#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

const herdr = process.env.HERDR_BIN_PATH ?? "herdr"
const root = resolve(import.meta.dir, "..")
const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? "{}")
const cwd = context.worktree?.checkout_path ?? context.workspace_cwd
const noPullRequestMessage = "No pull request found for the current branch."
const noRepositoryMessage = "No GitHub repository is configured for the current workspace."
function errorMessage(error: any): string {
  return error.stderr?.toString().trim() || error.message || String(error)
}
function command(executable: string, args: string[], directory = root): any {
  return JSON.parse(execFileSync(executable, args, {
    cwd: directory, encoding: "utf8", timeout: 45000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  }))
}
function api(args: string[]): any {
  const response = command(herdr, args)
  if (response.error) throw new Error(response.error.message)
  return response.result
}

try {
  if (process.argv[2] === "pane") {
    const url = process.env.HERDR_OPS_PR_URL
    if (!url) throw new Error("Missing PR URL")
    const result = spawnSync("bun", [resolve(root, "../cli/ghpr/src/cli.tsx"), url], { stdio: "inherit" })
    process.exitCode = result.status ?? 1
  } else {
    if (!cwd || !context.workspace_id || !context.focused_pane_id) throw new Error("No workspace/pane context")
    let pr: any
    try {
      pr = command("gh", ["pr", "view", "--json", "url"], cwd)
    } catch (error) {
      const message = errorMessage(error)
      if (/no pull requests? found/i.test(message)) throw new Error(noPullRequestMessage)
      if (/no git remotes found/i.test(message)) throw new Error(noRepositoryMessage)
      throw error
    }
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*$/.test(pr.url)) throw new Error(noPullRequestMessage)
    const directory = process.env.HERDR_PLUGIN_STATE_DIR
    if (!directory) throw new Error("Missing plugin state directory")
    mkdirSync(directory, { recursive: true })
    const key = createHash("sha256").update(`${process.env.HERDR_SOCKET_PATH}\0${context.workspace_id}`).digest("hex")
    const file = resolve(directory, `${key}.json`)
    const lock = `${file}.lock`
    // Short-lived action lock prevents rapid repeated keypresses opening duplicates.
    let locked = false
    try {
      try { mkdirSync(lock); locked = true } catch (error: any) {
        if (error.code === "EEXIST") process.exit(0)
        throw error
      }
      let previous: any
      try { previous = JSON.parse(readFileSync(file, "utf8")) } catch {}
      if (previous?.url === pr.url) {
        try {
          const pane = api(["pane", "get", previous.pane]).pane
          if (pane.workspace_id === context.workspace_id && pane.terminal_id === previous.terminal) {
            api(["plugin", "pane", "focus", previous.pane])
            process.exitCode = 0
            // Release the lock before exiting; process.exit skips finally.
            rmSync(lock, { recursive: true }); locked = false
            process.exit(0)
          }
        } catch {}
      }
      const opened = api(["plugin", "pane", "open", "--plugin", "herdr-ops.pr",
        "--entrypoint", "ghpr", "--placement", "split", "--direction", "right",
        "--target-pane", context.focused_pane_id, "--env", `HERDR_OPS_PR_URL=${pr.url}`, "--focus"])
      const pane = opened.plugin_pane.pane
      writeFileSync(`${file}.tmp`, JSON.stringify({ pane: pane.pane_id, terminal: pane.terminal_id, url: pr.url }), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    } finally {
      if (locked) rmSync(lock, { recursive: true })
    }
  }
} catch (error: any) {
  const message = errorMessage(error)
  console.error(`herdr-pr: ${message}`)
  if (process.argv[2] !== "pane") {
    const title = message === noPullRequestMessage ? "Pull request unavailable" : "Pull request"
    try { api(["notification", "show", title, "--body", message]) } catch {}
  }
  process.exitCode = 1
}
