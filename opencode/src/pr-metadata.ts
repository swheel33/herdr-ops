import { execFile as callback } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

const execFile = promisify(callback)
const source = "herdr-ops.pr"
const tokens = ["pr_branch", "pr_open", "pr_draft", "pr_merged", "pr_closed"] as const
const ttl = 2 * 60 * 60 * 1000

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, args, { cwd, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

interface PR {
  number: number
  headRefName: string
  isCrossRepository: boolean
  isDraft: boolean
  state: string
}

interface Workspace {
  workspace_id: string
  worktree?: { repo_root: string; checkout_path: string; is_linked_worktree: boolean }
}

export async function refreshPRMetadata(root: string): Promise<void> {
  const sessions = JSON.parse(await run("herdr", ["session", "list", "--json"], root)).sessions as Array<{ name: string; running: boolean }>
  const workspaces: Array<{ name: string; workspace: Workspace }> = []
  for (const session of sessions.filter((item) => item.running)) {
    try {
      const response = JSON.parse(await run("herdr", ["--session", session.name, "workspace", "list"], root))
      for (const workspace of response.result?.workspaces as Workspace[] ?? []) {
        if (workspace.worktree?.is_linked_worktree && path.resolve(workspace.worktree.repo_root) === root) {
          workspaces.push({ name: session.name, workspace })
        }
      }
    } catch (error) {
      console.error(`Herdr PR metadata: cannot inspect session ${session.name}:`, error)
    }
  }
  if (!workspaces.length) return

  // Do not clear previously reported PR badges if GitHub is temporarily unavailable.
  const prs = JSON.parse(await run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,isDraft,headRefName,isCrossRepository,state"], root)) as PR[]
  for (const { name, workspace } of workspaces) {
    try {
      const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], workspace.worktree!.checkout_path)
      const matches = prs.filter((pr) => !pr.isCrossRepository && pr.headRefName === branch)
      const pr = matches.find((item) => item.state === "OPEN") ?? matches[0]
      const state = pr?.state === "MERGED" ? "merged" : pr?.state === "CLOSED" ? "closed" : pr?.isDraft ? "draft" : "open"
      const values: Record<string, string> = { pr_branch: branch }
      if (Number.isSafeInteger(pr?.number) && pr!.number > 0) values[`pr_${state}`] = `#${pr!.number}`
      const args = ["--session", name, "workspace", "report-metadata", workspace.workspace_id, "--source", source, "--ttl-ms", String(ttl)]
      for (const token of tokens) args.push(values[token] ? "--token" : "--clear-token", values[token] ? `${token}=${values[token]}` : token)
      await run("herdr", args, root)
    } catch (error) {
      console.error(`Herdr PR metadata: cannot refresh ${workspace.workspace_id} in ${name}:`, error)
    }
  }
}

export function startPRMetadata(directory: string): () => void {
  let stopped = false
  let active = false
  const refresh = async () => {
    if (stopped || active) return
    active = true
    try {
      const root = await run("git", ["rev-parse", "--show-toplevel"], directory)
      const [common, local] = await Promise.all([
        run("git", ["rev-parse", "--git-common-dir"], root),
        run("git", ["rev-parse", "--git-dir"], root),
      ])
      if (path.resolve(root, common) !== path.resolve(root, local)) return
      await refreshPRMetadata(root)
    } catch (error) {
      if (!stopped) console.error("Herdr PR metadata refresh failed:", error)
    } finally {
      active = false
    }
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 60_000)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
