import { execFile as callback } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { refreshPRMetadata } from "./pr-metadata.js"
import { pruneClosedPRWorktrees } from "./pr-pruning.js"

const execFile = promisify(callback)
const active = new Set<string>()

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, args, { cwd, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

async function primaryBusy(root: string): Promise<boolean> {
  const sessions = JSON.parse(await run("herdr", ["session", "list", "--json"], root)).sessions as Array<{ name: string; running: boolean }>
  if (!Array.isArray(sessions)) throw new Error("Herdr session list was unavailable")
  for (const session of sessions.filter((item) => item.running)) {
    const agents = JSON.parse(await run("herdr", ["--session", session.name, "agent", "list"], root)).result?.agents as Array<{ agent_status?: string; cwd?: string }>
    if (!Array.isArray(agents)) throw new Error("Herdr agent list was unavailable")
    for (const agent of agents) {
      if (agent.agent_status === "idle") continue
      // Missing status or location is not evidence that it is safe to move HEAD.
      if (!agent.cwd) return true
      const relative = path.relative(root, await realpath(agent.cwd))
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return true
    }
  }
  return false
}

export async function refreshDevelop(root: string): Promise<void> {
  const git = (...args: string[]) => run("git", args, root)
  const safeCheckout = async () => {
    if (await git("branch", "--show-current") !== "develop") return false
    if (await git("status", "--porcelain", "--untracked-files=all")) return false
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"]) {
      const file = path.resolve(root, await git("rev-parse", "--git-path", marker))
      try {
        await lstat(file)
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    return true
  }
  if (!await safeCheckout()) return
  if (!(await git("remote")).split("\n").includes("origin")) return
  if (!await git("ls-remote", "--heads", "origin", "refs/heads/develop")) return
  await git("fetch", "--no-tags", "origin", "+refs/heads/develop:refs/remotes/origin/develop")
  const remote = await git("rev-parse", "refs/remotes/origin/develop")
  const local = await git("rev-parse", "HEAD")
  if (local === remote) return
  try {
    await git("merge-base", "--is-ancestor", local, remote)
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error
    console.info("Herdr maintenance: preserving develop with local commits ahead of or diverged from origin/develop")
    return
  }
  if (await primaryBusy(root)) return
  // Recheck after network/agent discovery; never switch branches or stash changes.
  if (!await safeCheckout() || await git("rev-parse", "HEAD") !== local) return
  await git("-c", "merge.autostash=false", "merge", "--ff-only", "--no-autostash", remote)
  console.info(`Herdr maintenance: updated develop to ${remote}`)
}

export async function refreshMaintenance(directory: string): Promise<void> {
  const root = await realpath(await run("git", ["rev-parse", "--show-toplevel"], directory))
  const [common, local] = await Promise.all([
    run("git", ["rev-parse", "--git-common-dir"], root),
    run("git", ["rev-parse", "--git-dir"], root),
  ])
  if (await realpath(path.resolve(root, common)) !== await realpath(path.resolve(root, local))) return
  // Multiple plugin instances in this server must not maintain the same repo concurrently.
  if (active.has(root)) return
  active.add(root)
  try {
    for (const [name, refresh] of [
      ["develop refresh", refreshDevelop],
      ["PR metadata", refreshPRMetadata],
      ["PR pruning", pruneClosedPRWorktrees],
    ] as const) {
      try {
        await refresh(root)
      } catch (error) {
        console.error(`Herdr maintenance ${name} failed:`, error)
      }
    }
  } finally {
    active.delete(root)
  }
}

export function startMaintenance(directory: string): () => void {
  let stopped = false
  let running = false
  const refresh = async () => {
    if (stopped || running) return
    running = true
    try {
      await refreshMaintenance(directory)
    } catch (error) {
      if (!stopped) console.error("Herdr maintenance failed:", error)
    } finally {
      running = false
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 60_000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
