import { execFile as callback } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { Plugin } from "@opencode/plugin"
import { Feature } from "./rpc.js"
import { startPRMetadata } from "./pr-metadata.js"
import { startPRPruning } from "./pr-pruning.js"

const execFile = promisify(callback)

export async function eligible(directory: string, sessionID: string): Promise<boolean> {
  try {
    const { stdout: root } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: directory })
    const cwd = root.trim()
    const { stdout: common } = await execFile("git", ["rev-parse", "--git-common-dir"], { cwd })
    const { stdout: local } = await execFile("git", ["rev-parse", "--git-dir"], { cwd })
    if (path.resolve(cwd, common.trim()) !== path.resolve(cwd, local.trim())) return false
    // The OpenCode service is shared between panes and does not inherit their
    // HERDR_SOCKET_PATH. Its default Herdr session may not own this conversation.
    const { stdout: response } = await execFile("herdr", ["session", "list", "--json"], { cwd, timeout: 10_000 })
    const sessions = JSON.parse(response).sessions as Array<{ name: string; running: boolean }> | undefined
    for (const session of sessions?.filter((item) => item.running) ?? []) {
      try {
        const { stdout } = await execFile("herdr", ["--session", session.name, "agent", "list"], { cwd, timeout: 10_000 })
        const agents = JSON.parse(stdout).result?.agents as Array<{ agent_session?: { value?: string } }> | undefined
        if (agents?.some((agent) => agent.agent_session?.value === sessionID)) return true
      } catch {
        // A named session may stop between discovery and inspection.
      }
    }
    return false
  } catch {
    return false
  }
}

export default Plugin.define({
  id: "herdr.feature.agent",
  async setup(ctx) {
    const stopMetadata = startPRMetadata(ctx.location.directory)
    const stopPruning = startPRPruning(ctx.location.directory)
    await ctx.rpc.register(Feature, {
      take: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const key = `pending/${sessionID}`
        const value = await ctx.storage.get(key)
        if (!value || typeof value !== "object" || Array.isArray(value)) return { pending: false }
        await ctx.storage.remove(key)
        const request = value as Record<string, unknown>
        return { pending: true, branch: typeof request.branch === "string" ? request.branch : undefined, pr: typeof request.pr === "string" ? request.pr : undefined }
      },
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "herdr_start_feature",
        description: "Request a Herdr worktree before editing. Pass pr for an existing open same-repository pull request (number or URL), branch for an existing or new branch, or neither for a new feature. Do not call inside a worktree.",
        input: {
          type: "object",
          properties: {
            branch: { type: "string", description: "Existing or new Git branch name; never use this for a pull request when its number or URL is known" },
            pr: { type: "string", description: "Existing open same-repository pull request number or URL" },
          },
          additionalProperties: false,
        },
        execute: async (input, call) => {
          const session = await ctx.session.get({ sessionID: call.sessionID })
          if (session.parentID || !await eligible(session.location.directory, call.sessionID)) {
            return { content: "Feature handoff unavailable: this must be a Herdr-hosted root conversation in the primary checkout. No changes were made." }
          }
          const { stdout: status } = await execFile("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: session.location.directory })
          if (status.trim()) return { content: "Feature handoff unavailable: the primary checkout has uncommitted changes. No worktree was created. Ask the user how to handle those changes; do not discard them." }
          const branch = (input as { branch?: string }).branch?.trim()
          const pr = (input as { pr?: string }).pr?.trim()
          if (pr && branch) return { content: "Specify either pr or branch, not both. No worktree was created." }
          if ("pr" in (input as object) && !pr) return { content: "A pull request reference cannot be empty. No worktree was created." }
          if (branch) await execFile("git", ["check-ref-format", "--branch", branch], { cwd: session.location.directory })
          if (await ctx.storage.get(`pending/${call.sessionID}`)) return { content: "Feature handoff is already queued. Finish this turn without editing." }
          await ctx.storage.set(`pending/${call.sessionID}`, { branch: branch ?? "", pr: pr ?? "" })
          return { content: "Feature handoff queued. Finish this turn without editing files or running implementation commands. The Herdr pane will move this same session when the turn completes." }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.parentID || !await eligible(session.location.directory, event.sessionID)) return
      event.system.push({ type: "text", text: "Herdr feature workflow: in this primary checkout, before implementing a feature or fix, call herdr_start_feature and end the turn without editing. If the user refers to an existing PR by number or URL, pass pr with that reference; if they name an existing branch but not a PR, pass branch with its exact name. Do not guess a PR or branch from vague context; ask if ambiguous. With neither, a new feature branch is created. After the session resumes in the worktree, implement normally. Read-only investigation and answering questions do not require a worktree. Do not call this tool for explicitly requested in-place edits. Committing and pushing are separate actions, not done by the handoff." })
    })
    return () => { stopMetadata(); stopPruning() }
  },
})
