import { DispatchError } from "./errors.js"
import type { CommandRunner } from "./types.js"

export interface ExistingWorktreeInfo {
  path: string
  branch?: string
  openWorkspaceId?: string
  isLinkedWorktree?: boolean
  isPrunable?: boolean
}

export interface ListedAgent {
  status?: string
  cwd?: string
  workspaceId?: string
}

export function parseWorktreeListResult(stdout: string): ExistingWorktreeInfo[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr worktree listing returned malformed JSON.", { cause: error })
  }

  const worktrees = (parsed as { result?: { worktrees?: unknown } }).result?.worktrees
  if (!Array.isArray(worktrees)) {
    throw new DispatchError("Herdr worktree listing did not include result.worktrees.")
  }

  return worktrees.flatMap((entry): ExistingWorktreeInfo[] => {
    if (typeof entry !== "object" || entry === null) return []
    const value = entry as Record<string, unknown>
    if (typeof value.path !== "string") return []
    return [{
      path: value.path,
      ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
      ...(typeof value.open_workspace_id === "string"
        ? { openWorkspaceId: value.open_workspace_id }
        : {}),
      ...(typeof value.is_linked_worktree === "boolean"
        ? { isLinkedWorktree: value.is_linked_worktree }
        : {}),
      ...(typeof value.is_prunable === "boolean"
        ? { isPrunable: value.is_prunable }
        : {}),
    }]
  })
}

export function parseAgentList(stdout: string): ListedAgent[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr agent listing returned malformed JSON.", { cause: error })
  }
  const agents = (parsed as { result?: { agents?: unknown } }).result?.agents
  if (!Array.isArray(agents)) throw new DispatchError("Herdr agent listing did not include result.agents.")
  return agents.flatMap((entry): ListedAgent[] => {
    if (typeof entry !== "object" || entry === null) return []
    const value = entry as Record<string, unknown>
    return [{
      ...(typeof value.agent_status === "string" ? { status: value.agent_status } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(typeof value.workspace_id === "string" ? { workspaceId: value.workspace_id } : {}),
    }]
  })
}

export async function listWorktrees(
  runner: CommandRunner,
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<ExistingWorktreeInfo[]> {
  const output = await runner.run({
    executable: "herdr",
    args: ["worktree", "list", "--cwd", repositoryRoot],
    cwd: repositoryRoot,
    ...(signal ? { signal } : {}),
  })
  return parseWorktreeListResult(output.stdout)
}

export async function listAgents(
  runner: CommandRunner,
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<ListedAgent[]> {
  const output = await runner.run({
    executable: "herdr",
    args: ["agent", "list"],
    cwd: repositoryRoot,
    ...(signal ? { signal } : {}),
  })
  return parseAgentList(output.stdout)
}

export function hasActiveAgent(
  worktree: ExistingWorktreeInfo,
  agents: ListedAgent[],
  workspaceId = worktree.openWorkspaceId,
): boolean {
  return agents.some((agent) => {
    if (agent.status === "idle") return false
    if (workspaceId && agent.workspaceId === workspaceId) return true
    return agent.cwd === worktree.path
  })
}

function nullSeparatedCount(output: string): number {
  return output.split("\0").filter(Boolean).length
}

export async function isEvacuatedWorktree(
  runner: CommandRunner,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const command = (args: readonly string[]) => runner.run({
    executable: "git",
    args,
    cwd: worktreePath,
    ...(signal ? { signal } : {}),
  })
  const tracked = await command(["ls-files", "-z"])
  const deleted = await command(["diff", "--name-only", "--diff-filter=D", "-z"])
  const otherChanges = await command(["diff", "--name-only", "--diff-filter=ACMRTUXB", "-z"])
  const staged = await command(["diff", "--cached", "--name-only", "-z"])
  const remaining = (await command(["ls-files", "--others", "-z"])).stdout
    .split("\0")
    .filter(Boolean)
  const trackedCount = nullSeparatedCount(tracked.stdout)
  return (
    trackedCount > 0 &&
    nullSeparatedCount(deleted.stdout) === trackedCount &&
    !otherChanges.stdout &&
    !staged.stdout &&
    remaining.every((entry) => entry.split("/").includes("node_modules"))
  )
}

export async function forceRemoveWorktree(
  runner: CommandRunner,
  repositoryRoot: string,
  worktree: ExistingWorktreeInfo,
  signal?: AbortSignal,
): Promise<void> {
  if (worktree.isLinkedWorktree !== true) {
    throw new DispatchError(`Refusing to force-remove non-linked checkout ${JSON.stringify(worktree.path)}.`)
  }
  await runner.run(worktree.openWorkspaceId
    ? {
        executable: "herdr",
        args: ["worktree", "remove", "--workspace", worktree.openWorkspaceId, "--force"],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      }
    : {
        executable: "git",
        args: ["worktree", "remove", "--force", worktree.path],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      })
}
