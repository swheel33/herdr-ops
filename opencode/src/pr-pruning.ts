import { execFile as callback } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const execFile = promisify(callback)

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, args, { cwd, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

interface Worktree {
  branch?: string
  path: string
  is_linked_worktree: boolean
  open_workspace_id?: string
}

interface Agent {
  agent_status?: string
  workspace_id?: string
  cwd?: string
}

interface PR {
  headRefName: string
  isCrossRepository: boolean
  state: string
}

async function hasActiveAgent(root: string, session: string, tree: Worktree): Promise<boolean> {
  const response = JSON.parse(await run("herdr", ["--session", session, "agent", "list"], root))
  const agents = response.result?.agents as Agent[] | undefined
  if (!agents) throw new Error("Herdr agent list was unavailable")
  return agents.some((agent) => agent.agent_status !== "idle" &&
    (agent.workspace_id === tree.open_workspace_id || agent.cwd === tree.path))
}

async function terminalPR(root: string, branch: string): Promise<boolean> {
  const list = async (state: string): Promise<PR[]> => {
    const response = await run("gh", ["pr", "list", "--state", state, "--head", branch, "--limit", "100", "--json", "headRefName,isCrossRepository,state"], root)
    const prs = JSON.parse(response) as PR[]
    if (!Array.isArray(prs)) throw new Error("gh pr list did not return an array")
    return prs.filter((pr) => pr.headRefName === branch)
  }
  // A branch name can be shared with a fork PR; never prune while any matching
  // PR is open, even if the terminal PR belongs to this repository.
  if ((await list("open")).some((pr) => pr.state === "OPEN")) return false
  return (await list("all")).some((pr) => pr.isCrossRepository === false && (pr.state === "MERGED" || pr.state === "CLOSED"))
}

export async function pruneClosedPRWorktrees(root: string): Promise<void> {
  const sessions = JSON.parse(await run("herdr", ["session", "list", "--json"], root)).sessions as Array<{ name: string; running: boolean }>
  if (!Array.isArray(sessions)) throw new Error("Herdr session list was unavailable")
  const checked = new Map<string, Promise<boolean>>()
  for (const session of sessions.filter((item) => item.running)) {
    let trees: Worktree[]
    try {
      const response = JSON.parse(await run("herdr", ["--session", session.name, "worktree", "list", "--cwd", root], root))
      trees = response.result?.worktrees
      if (!Array.isArray(trees)) throw new Error("Herdr worktree list was unavailable")
    } catch (error) {
      console.error(`Herdr PR pruning: cannot inspect session ${session.name}:`, error)
      continue
    }
    for (const tree of trees) {
      if (!tree.is_linked_worktree || !tree.branch || !tree.open_workspace_id) continue
      try {
        if (await hasActiveAgent(root, session.name, tree)) continue
        let terminal = checked.get(tree.branch)
        if (!terminal) {
          terminal = terminalPR(root, tree.branch)
          checked.set(tree.branch, terminal)
        }
        if (!await terminal) continue
        // Never use --force: ignored, staged, and untracked work must be preserved.
        if (await run("git", ["status", "--porcelain", "--untracked-files=all"], tree.path)) continue
        if (await hasActiveAgent(root, session.name, tree)) continue
        await run("herdr", ["--session", session.name, "worktree", "remove", "--workspace", tree.open_workspace_id], root)
        console.info(`Herdr PR pruning: removed ${tree.branch} (${path.basename(tree.path)}) from ${session.name}`)
      } catch (error) {
        console.error(`Herdr PR pruning: preserving ${tree.branch} at ${tree.path}:`, error)
      }
    }
  }
}

export function startPRPruning(directory: string): () => void {
  let stopped = false
  let active = false
  const prune = async () => {
    if (stopped || active) return
    active = true
    try {
      const root = await run("git", ["rev-parse", "--show-toplevel"], directory)
      const [common, local] = await Promise.all([
        run("git", ["rev-parse", "--git-common-dir"], root),
        run("git", ["rev-parse", "--git-dir"], root),
      ])
      if (path.resolve(root, common) !== path.resolve(root, local)) return
      await pruneClosedPRWorktrees(root)
    } catch (error) {
      if (!stopped) console.error("Herdr PR pruning failed:", error)
    } finally {
      active = false
    }
  }
  void prune()
  const timer = setInterval(() => void prune(), 60_000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
