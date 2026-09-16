export interface CommandSpec {
  executable: string
  args: readonly string[]
  cwd: string
  signal?: AbortSignal
  redactArgs?: readonly number[]
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
}

export interface CommandRunner {
  run(command: CommandSpec): Promise<CommandResult>
}

export type DispatchMode = "new" | "continue" | "branch_from"

export interface DispatchInput {
  mode: DispatchMode
  title: string
  branch: string
  plan: string
  base?: string
  source?: string
  allowDirtyRoot?: boolean
}

export interface BatchDispatchFeature extends Omit<DispatchInput, "allowDirtyRoot"> {
  id: string
}

export interface BatchDispatchInput {
  features: BatchDispatchFeature[]
  allowDirtyRoot?: boolean
}

export interface RepositoryInfo {
  root: string
  gitDir: string
  commonDir: string
}

export interface WorktreeInfo {
  workspaceId: string
  paneId: string
  path?: string
  branch?: string
  alreadyOpen?: boolean
}

export interface DispatchResult extends WorktreeInfo {
  mode: DispatchMode
  title: string
  branch: string
  base: string
  baseCommit: string
  source?: string
  reusedWorktree: boolean
  shellPaneId: string
  agentName: string
  planDelivered: true
  worktreeBranch?: string
}

export type BatchFeatureResult =
  | {
      id: string
      title: string
      branch: string
      status: "fulfilled"
      result: DispatchResult
    }
  | {
      id: string
      title: string
      branch: string
      status: "rejected"
      error: string
      partial?: DispatchPartialState
    }

export interface DispatchPartialState {
  workspaceId?: string
  paneId?: string
  shellPaneId?: string
  path?: string
  agentName?: string
}

export interface BatchDispatchResult {
  requested: number
  succeeded: number
  failed: number
  results: BatchFeatureResult[]
}

export type DispatchLogLevel = "debug" | "info" | "warn" | "error"

export type DispatchLogger = (
  level: DispatchLogLevel,
  message: string,
  metadata?: Record<string, unknown>,
) => void

export interface DispatchDependencies {
  runner: CommandRunner
  realpath(path: string): Promise<string>
  createAgentName?(branch: string): string
  logger?: DispatchLogger
}
