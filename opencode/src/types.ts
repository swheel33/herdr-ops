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

export interface DispatchInput {
  title: string
  branch: string
  plan: string
  base?: string
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
}

export interface DispatchResult extends WorktreeInfo {
  title: string
  branch: string
  base: string
  baseCommit: string
  shellPaneId: string
  agentName: string
  planDelivered: true
}

export interface DispatchPartialState {
  phase?: "workspace" | "panes" | "agent" | "plan"
  workspaceId?: string
  paneId?: string
  shellPaneId?: string
  path?: string
  agentName?: string
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
