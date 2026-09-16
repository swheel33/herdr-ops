import { randomUUID } from "node:crypto"
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { CommandError, DispatchError } from "./errors.js"
import { NodeCommandRunner } from "./process.js"
import { withRepositoryLock } from "./repository-lock.js"
import { IMPLEMENTOR_AGENT, IMPLEMENTOR_MODEL } from "./workflow.js"
import type {
  CommandSpec,
  DispatchDependencies,
  DispatchInput,
  DispatchPartialState,
  DispatchResult,
  RepositoryInfo,
  WorktreeInfo,
} from "./types.js"
import { resolveRepository, validateDispatchInput, type ValidatedDispatchInput } from "./validation.js"

const inFlight = new Set<string>()
const SHELL_READY_RETRY_MS = 100
const SHELL_READY_TIMEOUT_MS = 5_000
const AGENT_SESSION_RETRY_MS = 250
const AGENT_SESSION_TIMEOUT_MS = 60_000

function createAgentName(branch: string): string {
  const branchPart = branch
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .slice(0, 14)
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10)
  return `h-${branchPart || "dispatch"}-${suffix}`.slice(0, 32)
}

function optionalString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function isEnvironmentFile(relativePath: string): boolean {
  const name = path.basename(relativePath)
  const excludedDirectories = new Set([
    ".git",
    ".herdr",
    ".worktrees",
    "node_modules",
  ])
  const isProjectPath = relativePath
    .split(path.sep)
    .every((segment) => !excludedDirectories.has(segment))
  return (
    isProjectPath &&
    (name === ".env" || name.startsWith(".env.")) &&
    !name.endsWith(".example")
  )
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

export interface ExistingWorktreeInfo {
  path: string
  branch?: string
  openWorkspaceId?: string
  isLinkedWorktree?: boolean
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
    }]
  })
}

export function parseWorktreeResult(stdout: string): WorktreeInfo {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr worktree creation returned malformed JSON.", { cause: error })
  }

  const result = (parsed as {
    result?: {
      workspace?: Record<string, unknown>
      root_pane?: Record<string, unknown>
      worktree?: Record<string, unknown>
      path?: unknown
    }
  }).result
  const workspaceId = result?.workspace?.workspace_id
  const paneId = result?.root_pane?.pane_id
  if (typeof workspaceId !== "string" || typeof paneId !== "string") {
    throw new DispatchError(
      "Herdr worktree creation JSON is missing result.workspace.workspace_id or result.root_pane.pane_id.",
    )
  }

  const worktreePath = optionalString(
    result?.worktree?.path,
    result?.workspace?.worktree_path,
    result?.workspace?.cwd,
    result?.path,
  )
  return {
    workspaceId,
    paneId,
    ...(worktreePath ? { path: worktreePath } : {}),
  }
}

interface PaneLayoutEntry {
  paneId: string
  rect: { height: number; width: number; x: number; y: number }
}

interface PaneLayout {
  panes: PaneLayoutEntry[]
  splits: Array<{ direction: string; ratio: number }>
}

function parsePaneLayout(stdout: string): PaneLayout {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr pane layout returned malformed JSON.", { cause: error })
  }

  const layout = (parsed as { result?: { layout?: { panes?: unknown; splits?: unknown } } }).result?.layout
  if (!Array.isArray(layout?.panes) || !Array.isArray(layout.splits)) {
    throw new DispatchError("Herdr pane layout did not include result.layout.panes and result.layout.splits.")
  }

  const panes = layout.panes.map((entry): PaneLayoutEntry => {
    const pane = entry as { pane_id?: unknown; rect?: Record<string, unknown> }
    const rect = pane.rect
    if (
      typeof pane.pane_id !== "string" ||
      typeof rect?.height !== "number" ||
      typeof rect.width !== "number" ||
      typeof rect.x !== "number" ||
      typeof rect.y !== "number"
    ) {
      throw new DispatchError("Herdr pane layout included a malformed pane entry.")
    }
    return { paneId: pane.pane_id, rect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y } }
  })
  const splits = layout.splits.map((entry) => {
    const split = entry as { direction?: unknown; ratio?: unknown }
    if (typeof split.direction !== "string" || typeof split.ratio !== "number") {
      throw new DispatchError("Herdr pane layout included a malformed split entry.")
    }
    return { direction: split.direction, ratio: split.ratio }
  })
  return { panes, splits }
}

function parseSplitPaneId(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr pane split returned malformed JSON.", { cause: error })
  }
  const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id
  if (typeof paneId !== "string") throw new DispatchError("Herdr pane split did not include result.pane.pane_id.")
  return paneId
}

function expectedShellPane(layout: PaneLayout, agentPaneId: string): string | undefined {
  if (layout.panes.length !== 2 || layout.splits.length !== 1) return undefined
  const agent = layout.panes.find((pane) => pane.paneId === agentPaneId)
  const shell = layout.panes.find((pane) => pane.paneId !== agentPaneId)
  const split = layout.splits[0]
  if (!agent || !shell || !split) return undefined
  if (
    split.direction !== "down" ||
    Math.abs(split.ratio - 0.7) > 0.02 ||
    agent.rect.x !== shell.rect.x ||
    agent.rect.width !== shell.rect.width ||
    agent.rect.y >= shell.rect.y ||
    agent.rect.y + agent.rect.height !== shell.rect.y
  ) return undefined
  return shell.paneId
}

function herdrErrorCode(error: unknown): string | undefined {
  if (!(error instanceof CommandError)) return undefined
  try {
    const parsed = JSON.parse(error.result.stderr) as { error?: { code?: unknown } }
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined
  } catch {
    return undefined
  }
}

interface AgentState {
  status: string
  stateChangeSeq: number
  sessionId?: string
}

function parseAgentState(stdout: string): AgentState {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr agent inspection returned malformed JSON.", { cause: error })
  }
  const agent = (parsed as {
    result?: {
      agent?: {
        agent_status?: unknown
        state_change_seq?: unknown
        agent_session?: { value?: unknown }
      }
    }
  }).result?.agent
  if (typeof agent?.agent_status !== "string" || typeof agent.state_change_seq !== "number") {
    throw new DispatchError("Herdr agent inspection did not include agent status and state-change sequence.")
  }
  const sessionId = typeof agent.agent_session?.value === "string" && agent.agent_session.value.length > 0
    ? agent.agent_session.value
    : undefined
  return {
    status: agent.agent_status,
    stateChangeSeq: agent.state_change_seq,
    ...(sessionId ? { sessionId } : {}),
  }
}

async function runStage(
  dependencies: DispatchDependencies,
  command: CommandSpec,
  failurePrefix: string,
): Promise<string> {
  try {
    return (await dependencies.runner.run(command)).stdout
  } catch (error) {
    if (error instanceof CommandError || error instanceof DispatchError) {
      throw new DispatchError(`${failurePrefix}\n${error.message}`, { cause: error })
    }
    throw error
  }
}

async function commandSucceeds(dependencies: DispatchDependencies, command: CommandSpec): Promise<boolean> {
  try {
    await dependencies.runner.run(command)
    return true
  } catch (error) {
    if (error instanceof CommandError && error.result.exitCode === 1) return false
    throw error
  }
}

interface RootState {
  branch: string
  commit: string
  status: string
}

interface ResolvedBase {
  label: string
  commit: string
}

export class HerdrDispatcher {
  constructor(
    private readonly dependencies: DispatchDependencies = { runner: new NodeCommandRunner(), realpath },
    private readonly implementationModel = IMPLEMENTOR_MODEL,
  ) {}

  private log(level: "debug" | "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>): void {
    this.dependencies.logger?.(level, message, metadata)
  }

  async dispatch(cwd: string, input: DispatchInput, signal?: AbortSignal): Promise<DispatchResult> {
    this.log("info", "Dispatch requested", {
      cwd,
      title: input.title,
      branch: input.branch,
      base: input.base ?? "fresh origin default",
      planLength: input.plan.length,
    })
    let branch = input.branch
    let partial: DispatchPartialState | undefined
    try {
      const validated = await validateDispatchInput(this.dependencies.runner, cwd, input, signal)
      branch = validated.branch
      this.log("debug", "Dispatch input validated", {
        title: validated.title,
        branch: validated.branch,
        ...(validated.base ? { base: validated.base } : {}),
        planLength: validated.plan.length,
      })
      const repository = await resolveRepository(this.dependencies.runner, cwd, this.dependencies.realpath, signal)
      this.log("info", "Primary Git checkout resolved", {
        repository: repository.root,
        gitDir: repository.gitDir,
      })
      const key = `${repository.root}\0${validated.branch}`
      if (inFlight.has(key)) throw new DispatchError(`A dispatch for branch ${JSON.stringify(validated.branch)} is already in progress.`)
      inFlight.add(key)
      partial = {}
      try {
        return await this.dispatchNewBranch(repository, validated, partial, signal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new DispatchError(
          message,
          Object.keys(partial).length ? { cause: error, partial } : { cause: error },
        )
      } finally {
        inFlight.delete(key)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log("error", "Dispatch failed", {
        branch,
        error: message,
        ...(partial ? { partial } : {}),
      })
      throw error
    }
  }

  private async dispatchNewBranch(
    repository: RepositoryInfo,
    input: ValidatedDispatchInput,
    partial: DispatchPartialState,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const rootState = await this.readRootState(repository.root, signal)
    this.log("debug", "Primary checkout state captured", {
      branch: rootState.branch,
      commit: rootState.commit,
    })
    await this.assertPrimaryCheckoutSafe(repository.root, input, signal)
    const base = await this.resolveBase(repository.root, input.base, signal)
    this.log("info", "Dispatch base resolved", {
      base: base.label,
      commit: base.commit,
    })
    const worktree = await withRepositoryLock(repository.commonDir, async () => {
      const branchExists = await commandSucceeds(this.dependencies, {
        executable: "git",
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
        cwd: repository.root,
        ...(signal ? { signal } : {}),
      })
      if (branchExists) throw new DispatchError(`Branch ${JSON.stringify(input.branch)} already exists. Choose a new branch.`)
      partial.phase = "workspace"
      this.log("info", "Creating background Herdr worktree workspace", {
        branch: input.branch,
        base: base.label,
        baseCommit: base.commit,
      })
      const output = await runStage(
        this.dependencies,
        {
          executable: "herdr",
          args: ["worktree", "create", "--cwd", repository.root, "--branch", input.branch, "--base", base.commit, "--label", input.title, "--no-focus"],
          cwd: repository.root,
          ...(signal ? { signal } : {}),
        },
        "Worktree creation failed; no agent was started.",
      )
      const created = parseWorktreeResult(output)
      this.log("info", "Herdr worktree workspace created", {
        workspaceId: created.workspaceId,
        paneId: created.paneId,
        ...(created.path ? { worktreePath: created.path } : {}),
      })
      return created
    })

    partial.workspaceId = worktree.workspaceId
    partial.paneId = worktree.paneId
    if (worktree.path) partial.path = worktree.path
    if (!worktree.path) throw new DispatchError("Herdr did not report the worktree path required for dispatch.")
    await this.assertLinkedWorktree(repository, worktree.path, input.branch, base.commit, signal)
    await this.assertRootStateUnchanged(repository.root, rootState, signal)
    this.log("debug", "Linked worktree verified", {
      workspaceId: worktree.workspaceId,
      branch: input.branch,
      worktreePath: worktree.path,
    })

    const linkedEnvironmentFiles = await this.linkEnvironmentFiles(repository.root, worktree.path, signal)
    this.log("info", "Linked local environment files into worktree", {
      workspaceId: worktree.workspaceId,
      linkedEnvironmentFiles,
    })

    this.log("info", "Installing worktree dependencies", {
      workspaceId: worktree.workspaceId,
      worktreePath: worktree.path,
    })
    await runStage(
      this.dependencies,
      {
        executable: "pnpm",
        args: ["install"],
        cwd: worktree.path,
        ...(signal ? { signal } : {}),
      },
      "The worktree exists, but pnpm install failed; no agent was started and no cleanup was attempted.",
    )
    this.log("info", "Worktree dependencies installed", {
      workspaceId: worktree.workspaceId,
      worktreePath: worktree.path,
    })

    partial.phase = "panes"
    const shellPaneId = await this.ensurePaneLayout(repository.root, worktree, signal)
    partial.shellPaneId = shellPaneId
    this.log("info", "Worktree pane layout ready", {
      workspaceId: worktree.workspaceId,
      agentPaneId: worktree.paneId,
      shellPaneId,
    })

    partial.phase = "agent"
    const agentName = (this.dependencies.createAgentName ?? createAgentName)(input.branch)
    partial.agentName = agentName
    await this.startAgentWhenShellReady({
      executable: "herdr",
      args: ["agent", "start", agentName, "--kind", "opencode", "--pane", worktree.paneId, "--timeout", "60000", "--", "--agent", IMPLEMENTOR_AGENT, "--model", this.implementationModel, "--auto"],
      cwd: repository.root,
      ...(signal ? { signal } : {}),
    })
    this.log("info", "Build agent process started", {
      agentName,
      workspaceId: worktree.workspaceId,
      branch: input.branch,
    })

    const stateBeforePlan = await waitForAgentSession(this.dependencies, repository.root, agentName, signal)
    this.log("info", "Build agent session ready", {
      agentName,
      sessionId: stateBeforePlan.sessionId,
      workspaceId: worktree.workspaceId,
      branch: input.branch,
    })

    partial.phase = "plan"
    await this.deliverPlan(repository.root, worktree.path, input, base, agentName, stateBeforePlan, signal)
    this.log("info", "Implementation plan delivered", {
      agentName,
      branch: input.branch,
      workspaceId: worktree.workspaceId,
    })
    return {
      title: input.title,
      branch: input.branch,
      base: base.label,
      baseCommit: base.commit,
      workspaceId: worktree.workspaceId,
      paneId: worktree.paneId,
      shellPaneId,
      agentName,
      planDelivered: true,
      path: worktree.path,
    }
  }

  private async ensurePaneLayout(repositoryRoot: string, worktree: WorktreeInfo, signal?: AbortSignal): Promise<string> {
    let layout = parsePaneLayout(await runStage(this.dependencies, {
      executable: "herdr",
      args: ["pane", "layout", "--pane", worktree.paneId],
      cwd: repositoryRoot,
      ...(signal ? { signal } : {}),
    }, "Could not inspect the Herdr worktree pane layout."))
    if (layout.panes.length === 1 && layout.panes[0]?.paneId === worktree.paneId) {
      const split = await runStage(this.dependencies, {
        executable: "herdr",
        args: ["pane", "split", "--pane", worktree.paneId, "--direction", "down", "--ratio", "0.7", "--cwd", worktree.path ?? repositoryRoot, "--no-focus"],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      }, "Could not create the 70/30 Herdr worktree pane layout.")
      const shellPaneId = parseSplitPaneId(split)
      layout = parsePaneLayout(await runStage(this.dependencies, {
        executable: "herdr",
        args: ["pane", "layout", "--pane", worktree.paneId],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      }, "Could not verify the new Herdr worktree pane layout."))
      if (expectedShellPane(layout, worktree.paneId) !== shellPaneId) throw new DispatchError("Herdr did not create the expected agent-top 70% and shell-bottom 30% pane layout.")
      return shellPaneId
    }
    const shellPaneId = expectedShellPane(layout, worktree.paneId)
    if (!shellPaneId) throw new DispatchError("The Herdr worktree layout is not dispatch-compatible. Expected one agent pane above one shell pane at 70/30.")
    return shellPaneId
  }

  private async deliverPlan(repositoryRoot: string, worktreePath: string, input: ValidatedDispatchInput, base: ResolvedBase, agentName: string, stateBeforePlan: AgentState, signal?: AbortSignal): Promise<void> {
    const plan = [
      "Herdr implementation assignment: workspace setup is COMPLETE.",
      `Assigned directory: ${worktreePath}`,
      `Assigned branch: ${input.branch}`,
      `Resolved base: ${base.label} at ${base.commit}`,
      "Implement in this directory and branch. Do not create another worktree, branch, or agent.",
      "",
      "Agreed implementation plan:",
      input.plan,
    ].join("\n")
    const command: CommandSpec = {
      executable: "herdr",
      args: ["agent", "prompt", agentName, plan],
      cwd: repositoryRoot,
      redactArgs: [3],
      ...(signal ? { signal } : {}),
    }
    try {
      await this.dependencies.runner.run(command)
    } catch (error) {
      if (herdrErrorCode(error) !== "agent_prompt_stalled") throw new DispatchError(`The plan was not accepted by OpenCode.\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
      this.log("warn", "Herdr accepted the plan but prompt observation stalled; no retry will be attempted", { agentName })
    }

    try {
      await this.dependencies.runner.run({
        executable: "herdr",
        args: ["agent", "wait", agentName, "--until", "working", "--timeout", "60000"],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      const code = herdrErrorCode(error)
      if (code === "timeout" || code === "agent_wait_timeout" || code === "agent_prompt_stalled") {
        const state = await this.readAgentState(repositoryRoot, agentName, signal)
        if (state.status === "working" || state.stateChangeSeq > stateBeforePlan.stateChangeSeq) {
          this.log("info", "Build agent activity was confirmed by state change after wait timed out", {
            agentName,
            previousStateChangeSeq: stateBeforePlan.stateChangeSeq,
            stateChangeSeq: state.stateChangeSeq,
            status: state.status,
          })
          return
        }
        throw new DispatchError("The plan was submitted, but OpenCode did not confirm that the Build agent started working. Inspect the existing agent before retrying; no retry was attempted.", { cause: error })
      }
      throw new DispatchError(`The plan was submitted, but Herdr could not confirm that the Build agent started working.\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  private async readAgentState(repositoryRoot: string, agentName: string, signal?: AbortSignal): Promise<AgentState> {
    return readAgentState(this.dependencies, repositoryRoot, agentName, signal)
  }

  private async startAgentWhenShellReady(command: CommandSpec): Promise<void> {
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS
    while (true) {
      try {
        await this.dependencies.runner.run(command)
        return
      } catch (error) {
        if (herdrErrorCode(error) !== "agent_pane_busy" || Date.now() >= deadline) {
          throw new DispatchError(`The worktree exists, but no OpenCode agent was started.\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
        await delay(SHELL_READY_RETRY_MS, undefined, command.signal ? { signal: command.signal } : undefined)
      }
    }
  }

  private async assertPrimaryCheckoutSafe(repositoryRoot: string, input: ValidatedDispatchInput, signal?: AbortSignal): Promise<void> {
    const status = await runStage(this.dependencies, { executable: "git", args: ["status", "--porcelain", "--untracked-files=all"], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, "Could not inspect the primary checkout before dispatch.")
    if (status.trim() && !input.allowDirtyRoot) throw new DispatchError("The primary checkout has uncommitted files that will not be included in the feature worktree. Confirm this explicitly and dispatch with allowDirtyRoot only if intentional.")
  }

  private async readRootState(repositoryRoot: string, signal?: AbortSignal): Promise<RootState> {
    const output = (args: readonly string[], failure: string) => runStage(this.dependencies, { executable: "git", args, cwd: repositoryRoot, ...(signal ? { signal } : {}) }, failure)
    const [branch, commit, status] = await Promise.all([
      output(["rev-parse", "--abbrev-ref", "HEAD"], "Could not read the root branch."),
      output(["rev-parse", "--verify", "HEAD"], "Could not read the root commit."),
      output(["status", "--porcelain=v1", "--untracked-files=all"], "Could not read the root status."),
    ])
    return { branch: branch.trim(), commit: commit.trim(), status }
  }

  private async assertRootStateUnchanged(repositoryRoot: string, expected: RootState, signal?: AbortSignal): Promise<void> {
    const actual = await this.readRootState(repositoryRoot, signal)
    if (actual.branch !== expected.branch || actual.commit !== expected.commit || actual.status !== expected.status) throw new DispatchError("The primary checkout changed during dispatch. The plugin did not reset or repair it.")
  }

  private async assertLinkedWorktree(repository: RepositoryInfo, worktreePath: string, expectedBranch: string, expectedCommit: string, signal?: AbortSignal): Promise<void> {
    const canonicalPath = await this.dependencies.realpath(worktreePath)
    if (canonicalPath === repository.root) throw new DispatchError("Herdr returned the primary checkout as the dispatch target. No agent was started.")
    const output = (args: readonly string[], failure: string) => runStage(this.dependencies, { executable: "git", args, cwd: canonicalPath, ...(signal ? { signal } : {}) }, failure)
    const [root, gitDir, commonDir, branch, commit] = await Promise.all([
      output(["rev-parse", "--show-toplevel"], "Could not verify the worktree root."),
      output(["rev-parse", "--git-dir"], "Could not verify the worktree Git directory."),
      output(["rev-parse", "--git-common-dir"], "Could not verify the worktree common Git directory."),
      output(["rev-parse", "--abbrev-ref", "HEAD"], "Could not verify the worktree branch."),
      output(["rev-parse", "--verify", "HEAD"], "Could not verify the worktree commit."),
    ])
    const worktreeRoot = await this.dependencies.realpath(root.trim())
    const gitPath = await this.dependencies.realpath(path.resolve(canonicalPath, gitDir.trim()))
    const commonPath = await this.dependencies.realpath(path.resolve(canonicalPath, commonDir.trim()))
    if (worktreeRoot !== canonicalPath || commonPath !== repository.commonDir || gitPath === commonPath || branch.trim() !== expectedBranch || commit.trim() !== expectedCommit) throw new DispatchError("Herdr returned a checkout that does not match the requested linked worktree, branch, and base commit. No agent was started.")
  }

  private async linkEnvironmentFiles(repositoryRoot: string, worktreePath: string, signal?: AbortSignal): Promise<number> {
    const output = await runStage(
      this.dependencies,
      {
        executable: "git",
        args: [
          "ls-files",
          "-z",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--",
          ":(glob).env",
          ":(glob).env.*",
          ":(glob)**/.env",
          ":(glob)**/.env.*",
        ],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not discover ignored environment files in the primary checkout.",
    )
    const environmentFiles = output
      .split("\0")
      .filter(Boolean)
      .filter(isEnvironmentFile)
    let linked = 0

    for (const relativePath of environmentFiles) {
      const source = path.join(repositoryRoot, relativePath)
      const destination = path.join(worktreePath, relativePath)
      const sourceStats = await lstat(source)
      if (!sourceStats.isFile() && !sourceStats.isSymbolicLink()) continue

      try {
        const destinationStats = await lstat(destination)
        if (destinationStats.isSymbolicLink()) {
          const target = await readlink(destination)
          if (path.resolve(path.dirname(destination), target) === source) continue
        }
        throw new DispatchError(
          `Refusing to overwrite existing worktree environment file ${JSON.stringify(relativePath)}.`,
        )
      } catch (error) {
        if (!isMissingFileError(error)) throw error
      }

      await mkdir(path.dirname(destination), { recursive: true })
      await symlink(source, destination)
      linked += 1
    }

    return linked
  }

  private async resolveBase(repositoryRoot: string, explicitBase: string | undefined, signal?: AbortSignal): Promise<ResolvedBase> {
    if (explicitBase) return this.resolveBaseRef(repositoryRoot, explicitBase, signal)
    const remoteHead = await runStage(this.dependencies, { executable: "git", args: ["ls-remote", "--symref", "origin", "HEAD"], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, "Could not resolve origin's default branch. Add a working origin remote or specify a base.")
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu.exec(remoteHead)
    if (!match?.[1]) throw new DispatchError("Origin did not advertise a default branch. Specify an explicit base or repair origin's HEAD.")
    return this.fetchRemoteBranch(repositoryRoot, "origin", match[1], signal)
  }

  private async resolveBaseRef(repositoryRoot: string, ref: string, signal?: AbortSignal): Promise<ResolvedBase> {
    const remotes = await runStage(this.dependencies, { executable: "git", args: ["remote"], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, "Could not list Git remotes.")
    const remote = remotes.split(/\r?\n/u).filter(Boolean).sort((left, right) => right.length - left.length).find((candidate) => ref.startsWith(`${candidate}/`))
    if (remote) {
      const branch = ref.slice(remote.length + 1)
      if (!branch) throw new DispatchError("Remote branch must not be empty.")
      return this.fetchRemoteBranch(repositoryRoot, remote, branch, signal)
    }
    const commit = (await runStage(this.dependencies, { executable: "git", args: ["rev-parse", "--verify", `${ref}^{commit}`], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, `Git base ${JSON.stringify(ref)} could not be resolved.`)).trim()
    return { label: ref, commit }
  }

  private async fetchRemoteBranch(repositoryRoot: string, remote: string, branch: string, signal?: AbortSignal): Promise<ResolvedBase> {
    await runStage(this.dependencies, { executable: "git", args: ["check-ref-format", "--branch", branch], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, `Remote branch ${JSON.stringify(`${remote}/${branch}`)} is invalid.`)
    const trackingRef = `refs/remotes/${remote}/${branch}`
    const temporaryRef = `refs/opencode-herdr-dispatch/${randomUUID()}`
    try {
      await runStage(this.dependencies, { executable: "git", args: ["fetch", "--no-tags", remote, `+refs/heads/${branch}:${temporaryRef}`], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, `Could not freshly fetch ${JSON.stringify(`${remote}/${branch}`)}.`)
      const commit = (await runStage(this.dependencies, { executable: "git", args: ["rev-parse", "--verify", `${temporaryRef}^{commit}`], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, "Fetched remote branch could not be pinned.")).trim()
      await runStage(this.dependencies, { executable: "git", args: ["update-ref", trackingRef, commit], cwd: repositoryRoot, ...(signal ? { signal } : {}) }, `Could not update tracking ref ${JSON.stringify(`${remote}/${branch}`)}.`)
      return { label: `${remote}/${branch}`, commit }
    } finally {
      try {
        await this.dependencies.runner.run({ executable: "git", args: ["update-ref", "-d", temporaryRef], cwd: repositoryRoot })
      } catch {
        // The temporary ref may not exist when fetch fails.
      }
    }
  }
}

async function readAgentState(
  dependencies: DispatchDependencies,
  repositoryRoot: string,
  agentName: string,
  signal?: AbortSignal,
): Promise<AgentState> {
  const output = await runStage(dependencies, {
    executable: "herdr",
    args: ["agent", "get", agentName],
    cwd: repositoryRoot,
    ...(signal ? { signal } : {}),
  }, "Could not inspect the Build agent state.")
  return parseAgentState(output)
}

async function waitForAgentSession(
  dependencies: DispatchDependencies,
  repositoryRoot: string,
  agentName: string,
  signal?: AbortSignal,
): Promise<AgentState> {
  const deadline = Date.now() + AGENT_SESSION_TIMEOUT_MS
  while (true) {
    const state = await readAgentState(dependencies, repositoryRoot, agentName, signal)
    if (state.sessionId) return state
    if (Date.now() >= deadline) {
      throw new DispatchError(
        `The OpenCode process started, but no session initialized within ${AGENT_SESSION_TIMEOUT_MS}ms. The implementation plan was not submitted.`,
      )
    }
    await delay(AGENT_SESSION_RETRY_MS, undefined, signal ? { signal } : undefined)
  }
}

export function formatDispatchResult(result: DispatchResult): string {
  return [
    "Plan delivered to an OpenCode Build agent in Herdr.",
    "Status: dispatched",
    `Feature: ${result.title}`,
    `Branch: ${result.branch}`,
    `Base: ${result.base}`,
    `Base commit: ${result.baseCommit}`,
    `Workspace ID: ${result.workspaceId}`,
    `Pane ID: ${result.paneId}`,
    `Agent: ${result.agentName}`,
    ...(result.path ? [`Worktree: ${result.path}`] : []),
  ].join("\n")
}
