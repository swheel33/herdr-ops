import { randomUUID } from "node:crypto"
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { CommandError, DispatchError } from "./errors.js"
import { NodeCommandRunner } from "./process.js"
import { withRepositoryLock } from "./repository-lock.js"
import { IMPLEMENTOR_AGENT } from "./workflow.js"
import {
  forceRemoveWorktree,
  hasActiveAgent,
  isEvacuatedWorktree,
  listAgents,
  listWorktrees,
  type ExistingWorktreeInfo,
} from "./worktree-lifecycle.js"
import type {
  CommandSpec,
  DispatchDependencies,
  DispatchInput,
  DispatchPartialState,
  DispatchResult,
  RepositoryInfo,
  WorktreeInfo,
} from "./types.js"
import { resolveRepository, validateBranch, validateDispatchInput, type ValidatedDispatchInput } from "./validation.js"

const inFlight = new Set<string>()
const SHELL_READY_RETRY_MS = 100
const SHELL_READY_TIMEOUT_MS = 5_000
const PLAN_PROMPT_RETRY_MS = 1_000
const PLAN_PROMPT_ATTEMPTS = 3

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

function repositoryKey(value: string, pullRequest = false): string | undefined {
  try {
    const url = new URL(value)
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length < 2 || (pullRequest && (parts[2] !== "pull" || !parts[3]))) return undefined
    return `${url.hostname.toLowerCase()}/${parts[0]!.toLowerCase()}/${parts[1]!.replace(/\.git$/u, "").toLowerCase()}`
  } catch {
    return undefined
  }
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
}

function parseAgentState(stdout: string): AgentState {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr agent inspection returned malformed JSON.", { cause: error })
  }
  const agent = (parsed as {
    result?: { agent?: { agent_status?: unknown; state_change_seq?: unknown } }
  }).result?.agent
  if (typeof agent?.agent_status !== "string" || typeof agent.state_change_seq !== "number") {
    throw new DispatchError("Herdr agent inspection did not include agent status and state-change sequence.")
  }
  return { status: agent.agent_status, stateChangeSeq: agent.state_change_seq }
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

interface ResolvedPullRequest {
  number: number
  url: string
  branch: string
  commit: string
}

export class HerdrDispatcher {
  constructor(
    private readonly dependencies: DispatchDependencies = { runner: new NodeCommandRunner(), realpath },
  ) {}

  private log(level: "debug" | "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>): void {
    this.dependencies.logger?.(level, message, metadata)
  }

  async dispatch(cwd: string, input: DispatchInput, implementationModel: string, signal?: AbortSignal): Promise<DispatchResult> {
    this.log("info", "Dispatch requested", {
      cwd,
      title: input.title,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.pullRequest ? { pullRequest: input.pullRequest } : {}),
      ...(input.branch ? { base: input.base ?? "fresh origin default" } : {}),
      planLength: input.plan.length,
    })
    let target = input.branch ?? input.pullRequest ?? "<unresolved>"
    let partial: DispatchPartialState | undefined
    try {
      const validated = await validateDispatchInput(this.dependencies.runner, cwd, input, signal)
      target = validated.mode === "new" ? validated.branch : validated.pullRequest
      this.log("debug", "Dispatch input validated", {
        mode: validated.mode,
        title: validated.title,
        ...(validated.mode === "new" ? {
          branch: validated.branch,
          ...(validated.base ? { base: validated.base } : {}),
        } : { pullRequest: validated.pullRequest }),
        planLength: validated.plan.length,
      })
      const repository = await resolveRepository(this.dependencies.runner, cwd, this.dependencies.realpath, signal)
      this.log("info", "Primary Git checkout resolved", {
        repository: repository.root,
        gitDir: repository.gitDir,
      })
      const key = validated.mode === "new"
        ? `${repository.root}\0new\0${validated.branch}`
        : `${repository.root}\0pull_request`
      if (inFlight.has(key)) throw new DispatchError(`A dispatch for ${JSON.stringify(target)} is already in progress.`)
      inFlight.add(key)
      partial = {}
      try {
        return await this.dispatchBranch(repository, validated, partial, implementationModel, signal)
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
        target,
        error: message,
        ...(partial ? { partial } : {}),
      })
      throw error
    }
  }

  private async dispatchBranch(
    repository: RepositoryInfo,
    input: ValidatedDispatchInput,
    partial: DispatchPartialState,
    implementationModel: string,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const rootState = await this.readRootState(repository.root, signal)
    this.log("debug", "Primary checkout state captured", {
      branch: rootState.branch,
      commit: rootState.commit,
    })
    await this.assertPrimaryCheckoutSafe(repository.root, input, signal)
    let branch = input.mode === "new" ? input.branch : ""
    let base = input.mode === "new"
      ? await this.resolveBase(repository.root, input.base, signal)
      : undefined
    let pullRequest: ResolvedPullRequest | undefined
    let reusedWorktree = false
    let reusedLocalBranch = false
    if (base) this.log("info", "Dispatch base resolved", { base: base.label, commit: base.commit })
    const worktree = await withRepositoryLock(repository.commonDir, async () => {
      if (input.mode === "pull_request") {
        pullRequest = await this.resolvePullRequest(repository.root, input.pullRequest, signal)
        branch = pullRequest.branch
        base = { label: `pull request #${pullRequest.number}`, commit: pullRequest.commit }
        await validateBranch(this.dependencies.runner, repository.root, branch, signal)
        this.log("info", "Existing pull request resolved", {
          pullRequest: pullRequest.url,
          branch,
          commit: pullRequest.commit,
        })
      }
      if (!base) throw new DispatchError("Dispatch target could not be resolved.")
      let existingWorktree = input.mode === "pull_request"
        ? await this.findExistingWorktree(repository, branch, signal)
        : undefined
      const branchExists = await commandSucceeds(this.dependencies, {
        executable: "git",
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        cwd: repository.root,
        ...(signal ? { signal } : {}),
      })
      if (existingWorktree) {
        reusedWorktree = await this.prepareExistingPullRequestWorktree(repository.root, existingWorktree, base.commit, signal)
        if (!reusedWorktree) {
          existingWorktree = undefined
          reusedLocalBranch = true
          await this.prepareExistingPullRequestBranch(repository.root, branch, base.commit, signal)
        }
      } else if (branchExists) {
        if (input.mode !== "pull_request") {
          throw new DispatchError(`Branch ${JSON.stringify(branch)} already exists. Choose a new branch.`)
        }
        reusedLocalBranch = true
        await this.prepareExistingPullRequestBranch(repository.root, branch, base.commit, signal)
      }
      partial.phase = "workspace"
      this.log("info", existingWorktree
        ? "Opening existing Herdr worktree workspace"
        : "Creating background Herdr worktree workspace", {
        branch,
        base: base.label,
        baseCommit: base.commit,
      })
      const output = await runStage(
        this.dependencies,
        {
          executable: "herdr",
          args: existingWorktree
            ? ["worktree", "open", "--cwd", repository.root, "--path", existingWorktree.path, "--label", input.title, "--no-focus"]
            : ["worktree", "create", "--cwd", repository.root, "--branch", branch, "--base", base.commit, "--label", input.title, "--no-focus"],
          cwd: repository.root,
          ...(signal ? { signal } : {}),
        },
        existingWorktree
          ? "Existing worktree could not be opened; no agent was started."
          : "Worktree creation failed; no agent was started.",
      )
      const created = parseWorktreeResult(output)
      partial.workspaceId = created.workspaceId
      partial.paneId = created.paneId
      if (created.path) partial.path = created.path
      this.log("info", existingWorktree
        ? "Herdr worktree workspace opened"
        : "Herdr worktree workspace created", {
        workspaceId: created.workspaceId,
        paneId: created.paneId,
        ...(created.path ? { worktreePath: created.path } : {}),
      })
      if (input.mode === "pull_request") {
        await runStage(this.dependencies, {
          executable: "git",
          args: ["branch", "--set-upstream-to", `origin/${branch}`, branch],
          cwd: created.path ?? existingWorktree?.path ?? repository.root,
          ...(signal ? { signal } : {}),
        }, `Could not configure ${JSON.stringify(branch)} to push to the existing pull request branch.`)
      }
      return created
    })

    if (!base) throw new DispatchError("Dispatch target could not be resolved.")
    partial.workspaceId = worktree.workspaceId
    partial.paneId = worktree.paneId
    if (worktree.path) partial.path = worktree.path
    if (!worktree.path) throw new DispatchError("Herdr did not report the worktree path required for dispatch.")
    await this.assertLinkedWorktree(repository, worktree.path, branch, reusedWorktree || reusedLocalBranch ? undefined : base.commit, signal)
    await this.assertRootStateUnchanged(repository.root, rootState, signal)
    this.log("debug", "Linked worktree verified", {
      workspaceId: worktree.workspaceId,
      branch,
      worktreePath: worktree.path,
    })

    const linkedEnvironmentFiles = await this.linkEnvironmentFiles(repository.root, worktree.path, signal)
    this.log("info", "Linked local environment files into worktree", {
      workspaceId: worktree.workspaceId,
      linkedEnvironmentFiles,
    })

    if (!reusedWorktree) {
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
    }

    partial.phase = "panes"
    const shellPaneId = await this.ensurePaneLayout(repository.root, worktree, signal)
    partial.shellPaneId = shellPaneId
    this.log("info", "Worktree pane layout ready", {
      workspaceId: worktree.workspaceId,
      agentPaneId: worktree.paneId,
      shellPaneId,
    })

    partial.phase = "agent"
    const agentName = (this.dependencies.createAgentName ?? createAgentName)(branch)
    partial.agentName = agentName
    await this.startAgentWhenShellReady({
      executable: "herdr",
      args: ["agent", "start", agentName, "--kind", "opencode", "--pane", worktree.paneId, "--timeout", "60000", "--", "--agent", IMPLEMENTOR_AGENT, "--model", implementationModel, "--auto"],
      cwd: repository.root,
      ...(signal ? { signal } : {}),
    })
    this.log("info", "Build agent started", {
      agentName,
      workspaceId: worktree.workspaceId,
      branch,
    })

    partial.phase = "plan"
    const stateBeforePlan = await this.readAgentState(repository.root, agentName, signal)
    await this.deliverPlan(repository.root, worktree.path, input, branch, base, pullRequest, agentName, stateBeforePlan, signal)
    this.log("info", "Implementation plan delivered", {
      agentName,
      branch,
      workspaceId: worktree.workspaceId,
    })
    return {
      mode: input.mode,
      title: input.title,
      branch,
      base: base.label,
      baseCommit: base.commit,
      ...(pullRequest ? { pullRequest: pullRequest.url } : {}),
      reusedWorktree,
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

  private async deliverPlan(repositoryRoot: string, worktreePath: string, input: ValidatedDispatchInput, branch: string, base: ResolvedBase, pullRequest: ResolvedPullRequest | undefined, agentName: string, stateBeforePlan: AgentState, signal?: AbortSignal): Promise<void> {
    const plan = [
      "Herdr implementation assignment: workspace setup is COMPLETE.",
      `Assigned directory: ${worktreePath}`,
      `Assigned branch: ${branch}`,
      `Resolved base: ${base.label} at ${base.commit}`,
      ...(pullRequest ? [
        `Existing pull request: ${pullRequest.url}`,
        `Existing pull request head: origin/${branch}`,
        "Continue this pull request and push completed commits to its existing head branch. Do not create a replacement branch or pull request.",
      ] : []),
      "Implement in this directory and branch. Do not create another worktree, branch, or agent.",
      "",
      "Agreed implementation plan:",
      input.plan,
    ].join("\n")
    const command: CommandSpec = {
      executable: "herdr",
      args: ["agent", "prompt", agentName, plan, "--wait", "--until", "working", "--timeout", "60000"],
      cwd: repositoryRoot,
      redactArgs: [3],
      ...(signal ? { signal } : {}),
    }
    for (let attempt = 1; attempt <= PLAN_PROMPT_ATTEMPTS; attempt += 1) {
      try {
        await this.dependencies.runner.run(command)
        break
      } catch (error) {
        if (herdrErrorCode(error) !== "agent_prompt_stalled") throw new DispatchError(`The plan was not accepted by OpenCode.\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
        const state = await this.readAgentState(repositoryRoot, agentName, signal)
        if (state.status === "working" || state.stateChangeSeq > stateBeforePlan.stateChangeSeq) break
        if (attempt === PLAN_PROMPT_ATTEMPTS) throw new DispatchError("OpenCode did not admit the implementation plan after the agent became available. Inspect the existing agent before retrying; no retry was attempted.", { cause: error })
        this.log("warn", "OpenCode was not ready to admit the plan; retrying prompt delivery", { agentName, attempt })
        await delay(PLAN_PROMPT_RETRY_MS, undefined, signal ? { signal } : undefined)
      }
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

  private async assertLinkedWorktree(repository: RepositoryInfo, worktreePath: string, expectedBranch: string, expectedCommit: string | undefined, signal?: AbortSignal): Promise<void> {
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
    if (worktreeRoot !== canonicalPath || commonPath !== repository.commonDir || gitPath === commonPath || branch.trim() !== expectedBranch || (expectedCommit !== undefined && commit.trim() !== expectedCommit)) throw new DispatchError("Herdr returned a checkout that does not match the requested linked worktree, branch, and base commit. No agent was started.")
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

  private async resolvePullRequest(repositoryRoot: string, reference: string, signal?: AbortSignal): Promise<ResolvedPullRequest> {
    const selector = /^#\d+$/u.test(reference) ? reference.slice(1) : reference
    if (!/^\d+$/u.test(selector) && !repositoryKey(selector, true)) {
      throw new DispatchError("Pull request must be a GitHub pull request URL or positive pull request number.")
    }
    const repositoryOutput = await runStage(this.dependencies, {
      executable: "gh",
      args: ["repo", "view", "--json", "url"],
      cwd: repositoryRoot,
      ...(signal ? { signal } : {}),
    }, "Could not identify the current GitHub repository.")
    let repositoryUrl: unknown
    try {
      repositoryUrl = (JSON.parse(repositoryOutput) as { url?: unknown }).url
    } catch (error) {
      throw new DispatchError("gh repo view returned malformed JSON.", { cause: error })
    }
    const currentRepository = typeof repositoryUrl === "string" ? repositoryKey(repositoryUrl) : undefined
    if (!currentRepository) throw new DispatchError("gh repo view did not return a valid repository URL.")

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const output = await runStage(this.dependencies, {
        executable: "gh",
        args: [
          "pr", "view", selector,
          "--json", "number,url,state,isDraft,headRefName,headRefOid,isCrossRepository,headRepository",
        ],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      }, `Could not resolve pull request ${JSON.stringify(reference)}.`)
      let value: Record<string, unknown>
      try {
        value = JSON.parse(output) as Record<string, unknown>
      } catch (error) {
        throw new DispatchError("gh pr view returned malformed JSON.", { cause: error })
      }
      const number = value.number
      const url = value.url
      const branch = value.headRefName
      const commit = value.headRefOid
      const headRepository = value.headRepository as { nameWithOwner?: unknown } | null | undefined
      if (
        typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 ||
        typeof url !== "string" || repositoryKey(url, true) !== currentRepository ||
        typeof branch !== "string" || !branch ||
        typeof commit !== "string" || !/^[0-9a-f]{40,64}$/iu.test(commit) ||
        typeof headRepository?.nameWithOwner !== "string"
      ) {
        throw new DispatchError("Pull request metadata is incomplete or does not belong to the current repository.")
      }
      if (value.state !== "OPEN") {
        throw new DispatchError(`Pull request #${number} is ${String(value.state).toLowerCase()} and cannot be continued.`)
      }
      if (value.isCrossRepository !== false) {
        throw new DispatchError("Pull requests from forks are not supported. Continue a branch hosted in the current repository.")
      }
      const fetched = await this.fetchRemoteBranch(repositoryRoot, "origin", branch, signal)
      if (fetched.commit === commit) return { number, url, branch, commit }
      if (attempt === 2) {
        throw new DispatchError(`Pull request #${number} changed while it was being prepared. Run /feature again.`)
      }
      this.log("debug", "Pull request head changed during dispatch; refreshing once", {
        pullRequest: url,
        advertisedCommit: commit,
        fetchedCommit: fetched.commit,
      })
    }
    throw new DispatchError("Pull request could not be resolved.")
  }

  private async findExistingWorktree(repository: RepositoryInfo, branch: string, signal?: AbortSignal): Promise<ExistingWorktreeInfo | undefined> {
    let matching = (await listWorktrees(this.dependencies.runner, repository.root, signal)).find((worktree) => worktree.branch === branch)
    if (!matching) return undefined
    if (matching.isPrunable) {
      try {
        await this.dependencies.runner.run({
          executable: "git",
          args: ["worktree", "repair", matching.path],
          cwd: repository.root,
          ...(signal ? { signal } : {}),
        })
      } catch (error) {
        if (signal?.aborted) throw error
        this.log("debug", "Could not repair prunable pull request worktree", {
          branch,
          path: matching.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      const worktreesAfterRepair = await listWorktrees(this.dependencies.runner, repository.root, signal)
      matching = worktreesAfterRepair.find((worktree) => worktree.branch === branch)
      if (matching?.isPrunable) {
        if (hasActiveAgent(matching, await listAgents(this.dependencies.runner, repository.root, signal))) {
          throw new DispatchError("The prunable pull request worktree still has an active agent and cannot be recreated.")
        }
        await forceRemoveWorktree(this.dependencies.runner, repository.root, matching, signal)
        this.log("info", "Removed prunable pull request worktree registration for recreation", {
          branch,
          path: matching.path,
        })
        return undefined
      }
      if (!matching) return undefined
      this.log("info", "Repaired stale pull request worktree registration", {
        branch,
        path: matching.path,
      })
    }
    const matchingPath = await this.dependencies.realpath(matching.path)
    if (matchingPath === repository.root || matching.isLinkedWorktree === false) {
      throw new DispatchError(`Pull request branch ${JSON.stringify(branch)} is checked out in the primary checkout and cannot be dispatched.`)
    }
    return { ...matching, path: matchingPath }
  }

  private async prepareExistingPullRequestBranch(repositoryRoot: string, branch: string, remoteCommit: string, signal?: AbortSignal): Promise<void> {
    const localCommit = (await runStage(this.dependencies, {
      executable: "git",
      args: ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      cwd: repositoryRoot,
      ...(signal ? { signal } : {}),
    }, `Could not read existing pull request branch ${JSON.stringify(branch)}.`)).trim()
    if (localCommit === remoteCommit) return
    if (await commandSucceeds(this.dependencies, {
      executable: "git",
      args: ["merge-base", "--is-ancestor", localCommit, remoteCommit],
      cwd: repositoryRoot,
      ...(signal ? { signal } : {}),
    })) {
      await runStage(this.dependencies, {
        executable: "git",
        args: ["update-ref", `refs/heads/${branch}`, remoteCommit, localCommit],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      }, `Could not fast-forward existing pull request branch ${JSON.stringify(branch)}.`)
      return
    }
    if (await commandSucceeds(this.dependencies, {
      executable: "git",
      args: ["merge-base", "--is-ancestor", remoteCommit, localCommit],
      cwd: repositoryRoot,
      ...(signal ? { signal } : {}),
    })) return
    throw new DispatchError(`Existing pull request branch ${JSON.stringify(branch)} has diverged from the remote pull request branch.`)
  }

  private async prepareExistingPullRequestWorktree(repositoryRoot: string, worktree: ExistingWorktreeInfo, remoteCommit: string, signal?: AbortSignal): Promise<boolean> {
    const agents = await listAgents(this.dependencies.runner, repositoryRoot, signal)
    if (hasActiveAgent(worktree, agents)) {
      throw new DispatchError("The pull request worktree already has an active agent.")
    }
    const status = await runStage(this.dependencies, {
      executable: "git",
      args: ["status", "--porcelain", "--untracked-files=all"],
      cwd: worktree.path,
      ...(signal ? { signal } : {}),
    }, "Could not inspect the existing pull request worktree.")
    if (status.trim()) {
      if (!await isEvacuatedWorktree(this.dependencies.runner, worktree.path, signal)) {
        throw new DispatchError("The existing pull request worktree contains tracked or unclassified changes and cannot be reused safely.")
      }
      if (hasActiveAgent(worktree, await listAgents(this.dependencies.runner, repositoryRoot, signal))) {
        throw new DispatchError("The evacuated pull request worktree gained an active agent and cannot be recreated.")
      }
      if (!await isEvacuatedWorktree(this.dependencies.runner, worktree.path, signal)) {
        throw new DispatchError("The pull request worktree changed while evacuation recovery was being prepared.")
      }
      await forceRemoveWorktree(this.dependencies.runner, repositoryRoot, worktree, signal)
      this.log("info", "Force-removed evacuated pull request worktree for recreation", {
        branch: worktree.branch,
        path: worktree.path,
      })
      return false
    }

    const localCommit = (await runStage(this.dependencies, {
      executable: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: worktree.path,
      ...(signal ? { signal } : {}),
    }, "Could not read the existing pull request worktree commit.")).trim()
    if (localCommit === remoteCommit) return true
    if (await commandSucceeds(this.dependencies, {
      executable: "git",
      args: ["merge-base", "--is-ancestor", localCommit, remoteCommit],
      cwd: worktree.path,
      ...(signal ? { signal } : {}),
    })) {
      await runStage(this.dependencies, {
        executable: "git",
        args: ["merge", "--ff-only", remoteCommit],
        cwd: worktree.path,
        ...(signal ? { signal } : {}),
      }, "Could not fast-forward the existing pull request worktree.")
      return true
    }
    if (await commandSucceeds(this.dependencies, {
      executable: "git",
      args: ["merge-base", "--is-ancestor", remoteCommit, localCommit],
      cwd: worktree.path,
      ...(signal ? { signal } : {}),
    })) return true
    throw new DispatchError("The existing pull request worktree has diverged from the remote pull request branch.")
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

export function formatDispatchResult(result: DispatchResult): string {
  return [
    "Plan delivered to an OpenCode Build agent in Herdr.",
    "Status: dispatched",
    `Mode: ${result.mode}`,
    `Feature: ${result.title}`,
    `Branch: ${result.branch}`,
    ...(result.pullRequest ? [`Pull request: ${result.pullRequest}`] : []),
    `Base: ${result.base}`,
    `Base commit: ${result.baseCommit}`,
    `Reused worktree: ${result.reusedWorktree ? "yes" : "no"}`,
    `Workspace ID: ${result.workspaceId}`,
    `Pane ID: ${result.paneId}`,
    `Agent: ${result.agentName}`,
    ...(result.path ? [`Worktree: ${result.path}`] : []),
  ].join("\n")
}
