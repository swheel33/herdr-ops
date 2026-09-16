import { randomUUID } from "node:crypto"
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { CommandError, DispatchError } from "./errors.js"
import { NodeCommandRunner } from "./process.js"
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
import {
  resolveRepository,
  validateDispatchInput,
  type ValidatedDispatchInput,
} from "./validation.js"

const inFlight = new Set<string>()
const fetchLocks = new Map<string, Promise<void>>()
const SHELL_READY_RETRY_MS = 100
const SHELL_READY_TIMEOUT_MS = 5_000

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
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  )
}

export function parseWorktreeResult(stdout: string): WorktreeInfo {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DispatchError("Herdr worktree creation returned malformed JSON.", {
      cause: error,
    })
  }

  const envelope = parsed as {
    result?: {
      workspace?: Record<string, unknown>
      root_pane?: Record<string, unknown>
      worktree?: Record<string, unknown>
      path?: unknown
      branch?: unknown
      already_open?: unknown
    }
  }
  const result = envelope.result
  const workspaceId = result?.workspace?.workspace_id
  const paneId = result?.root_pane?.pane_id
  if (typeof workspaceId !== "string" || typeof paneId !== "string") {
    throw new DispatchError(
      "Herdr worktree creation JSON is missing result.workspace.workspace_id or result.root_pane.pane_id.",
    )
  }

  const path = optionalString(
    result?.worktree?.path,
    result?.workspace?.worktree_path,
    result?.workspace?.cwd,
    result?.path,
  )
  const branch = optionalString(
    result?.worktree?.branch,
    result?.workspace?.branch,
    result?.branch,
  )
  return {
    workspaceId,
    paneId,
    ...(path ? { path } : {}),
    ...(branch ? { branch } : {}),
    ...(typeof result?.already_open === "boolean"
      ? { alreadyOpen: result.already_open }
      : {}),
  }
}

interface PaneRect {
  height: number
  width: number
  x: number
  y: number
}

interface PaneLayoutEntry {
  paneId: string
  rect: PaneRect
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
    throw new DispatchError("Herdr pane layout returned malformed JSON.", {
      cause: error,
    })
  }

  const layout = (parsed as {
    result?: { layout?: { panes?: unknown; splits?: unknown } }
  }).result?.layout
  if (!Array.isArray(layout?.panes) || !Array.isArray(layout.splits)) {
    throw new DispatchError(
      "Herdr pane layout did not include result.layout.panes and result.layout.splits.",
    )
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
    return {
      paneId: pane.pane_id,
      rect: {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      },
    }
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
  const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } }).result
    ?.pane?.pane_id
  if (typeof paneId !== "string") {
    throw new DispatchError("Herdr pane split did not include result.pane.pane_id.")
  }
  return paneId
}

function expectedShellPane(layout: PaneLayout, agentPaneId: string): string | undefined {
  if (layout.panes.length !== 2 || layout.splits.length !== 1) return undefined
  const agent = layout.panes.find((pane) => pane.paneId === agentPaneId)
  const shell = layout.panes.find((pane) => pane.paneId !== agentPaneId)
  const split = layout.splits[0]
  if (!agent || !shell || !split) return undefined
  const isTopBottom =
    split.direction === "down" &&
    Math.abs(split.ratio - 0.7) <= 0.02 &&
    agent.rect.x === shell.rect.x &&
    agent.rect.width === shell.rect.width &&
    agent.rect.y < shell.rect.y &&
    agent.rect.y + agent.rect.height === shell.rect.y
  return isTopBottom ? shell.paneId : undefined
}

function herdrErrorCode(error: unknown): string | undefined {
  if (!(error instanceof CommandError)) return undefined

  try {
    const parsed = JSON.parse(error.result.stderr) as {
      error?: { code?: unknown }
    }
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined
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

interface ResolvedBase {
  label: string
  commit: string
}

interface RootState {
  branch: string
  commit: string
  status: string
}

async function withFetchLock<T>(repositoryRoot: string, action: () => Promise<T>): Promise<T> {
  const previous = fetchLocks.get(repositoryRoot) ?? Promise.resolve()
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const queued = previous.then(() => gate)
  fetchLocks.set(repositoryRoot, queued)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (fetchLocks.get(repositoryRoot) === queued) fetchLocks.delete(repositoryRoot)
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

async function commandSucceeds(
  dependencies: DispatchDependencies,
  command: CommandSpec,
): Promise<boolean> {
  try {
    await dependencies.runner.run(command)
    return true
  } catch (error) {
    if (error instanceof CommandError && error.result.exitCode === 1) return false
    throw error
  }
}

export class HerdrDispatcher {
  constructor(
    private readonly dependencies: DispatchDependencies = {
      runner: new NodeCommandRunner(),
      realpath,
    },
    private readonly implementationModel = IMPLEMENTOR_MODEL,
  ) {}

  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.dependencies.logger?.(level, message, metadata)
  }

  async dispatch(
    cwd: string,
    input: DispatchInput,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    this.log("info", "Dispatch requested", {
      cwd,
      mode: input.mode,
      title: input.title,
      branch: input.branch,
      base: input.base ?? "fresh origin default",
      ...(input.source ? { source: input.source } : {}),
      planLength: input.plan.length,
    })

    try {
      return await this.dispatchValidated(cwd, input, signal)
    } catch (error) {
      this.log("error", "Dispatch failed", {
        mode: input.mode,
        branch: input.branch,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async dispatchValidated(
    cwd: string,
    input: DispatchInput,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const validated = await validateDispatchInput(
      this.dependencies.runner,
      cwd,
      input,
      signal,
    )
    this.log("debug", "Dispatch input validated", {
      mode: validated.mode,
      title: validated.title,
      branch: validated.branch,
      base: validated.base,
      ...(validated.source ? { source: validated.source } : {}),
      planLength: validated.plan.length,
    })
    const repository = await resolveRepository(
      this.dependencies.runner,
      cwd,
      this.dependencies.realpath,
      signal,
    )
    this.log("info", "Primary Git checkout resolved", {
      repository: repository.root,
      gitDir: repository.gitDir,
    })
    await this.assertPrimaryCheckoutSafe(repository.root, validated, signal)
    const key = `${repository.root}\0${validated.branch}`
    if (inFlight.has(key)) {
      throw new DispatchError(
        `A dispatch for branch ${JSON.stringify(validated.branch)} is already in progress for this repository.`,
      )
    }

    inFlight.add(key)
    const partial: DispatchPartialState = {}
    try {
      const rootState = await this.readRootState(repository.root, signal)
      const base = await this.resolveBase(repository.root, validated, signal)
      const existingWorktree = await this.findExistingWorktree(
        repository.root,
        validated.branch,
        signal,
      )
      if (existingWorktree && validated.mode !== "continue") {
        throw new DispatchError(
          `Branch ${JSON.stringify(validated.branch)} already has a worktree. Use continue intent or choose a new branch.`,
        )
      }
      if (validated.mode !== "continue" && !existingWorktree) {
        const branchExists = await commandSucceeds(this.dependencies, {
          executable: "git",
          args: ["show-ref", "--verify", "--quiet", `refs/heads/${validated.branch}`],
          cwd: repository.root,
          ...(signal ? { signal } : {}),
        })
        if (branchExists) {
          throw new DispatchError(
            `Branch ${JSON.stringify(validated.branch)} already exists. Use continue intent or choose a new branch.`,
          )
        }
      }

      this.log("info", existingWorktree ? "Opening existing Herdr worktree workspace" : "Creating background Herdr worktree workspace", {
        repository: repository.root,
        mode: validated.mode,
        branch: validated.branch,
        base: base.label,
        baseCommit: base.commit,
        ...(existingWorktree ? { worktreePath: existingWorktree.path } : {}),
      })
      const worktreeCommand: CommandSpec = {
        executable: "herdr",
        args: existingWorktree
          ? [
              "worktree",
              "open",
              "--cwd",
              repository.root,
              "--path",
              existingWorktree.path,
              "--label",
              validated.title,
              "--no-focus",
            ]
          : [
              "worktree",
              "create",
              "--cwd",
              repository.root,
              "--branch",
              validated.branch,
              "--base",
              base.commit,
              "--label",
              validated.title,
              "--no-focus",
            ],
        cwd: repository.root,
        ...(signal ? { signal } : {}),
      }
      const worktreeOutput = await runStage(
        this.dependencies,
        worktreeCommand,
        existingWorktree
          ? "Existing worktree could not be opened; no agent was started."
          : "Worktree creation failed; no agent was started.",
      )
      let worktree: WorktreeInfo
      try {
        worktree = parseWorktreeResult(worktreeOutput)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new DispatchError(
          `Herdr reported worktree creation success, but its response was invalid. A worktree may exist, no agent was started, and no cleanup was attempted.\n${detail}`,
          { cause: error },
        )
      }
      this.log("info", existingWorktree ? "Herdr worktree workspace opened" : "Herdr worktree workspace created", {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        ...(worktree.path ? { worktreePath: worktree.path } : {}),
      })
      partial.workspaceId = worktree.workspaceId
      partial.paneId = worktree.paneId
      if (worktree.path) partial.path = worktree.path
      if (!worktree.path) {
        throw new DispatchError(
          "Herdr did not report the worktree path required for environment linking and pane setup.",
        )
      }
      await this.assertLinkedWorktree(
        repository,
        worktree.path,
        validated.branch,
        existingWorktree ? undefined : base.commit,
        signal,
      )
      await this.assertRootStateUnchanged(repository.root, rootState, signal)

      const linkedEnvironmentFiles = await this.linkEnvironmentFiles(
        repository.root,
        worktree.path,
        signal,
      )
      this.log("info", "Linked local environment files into worktree", {
        workspaceId: worktree.workspaceId,
        linkedEnvironmentFiles,
      })

      if (!existingWorktree) {
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

      let layout = parsePaneLayout(await runStage(
        this.dependencies,
        {
          executable: "herdr",
          args: ["pane", "layout", "--pane", worktree.paneId],
          cwd: repository.root,
          ...(signal ? { signal } : {}),
        },
        "Could not inspect the Herdr worktree pane layout.",
      ))
      let shellPaneId: string
      if (layout.panes.length === 1 && layout.panes[0]?.paneId === worktree.paneId) {
        const splitOutput = await runStage(
          this.dependencies,
          {
            executable: "herdr",
            args: [
              "pane",
              "split",
              "--pane",
              worktree.paneId,
              "--direction",
              "down",
              "--ratio",
              "0.7",
              "--cwd",
              worktree.path,
              "--no-focus",
            ],
            cwd: repository.root,
            ...(signal ? { signal } : {}),
          },
          "Could not create the 70/30 Herdr worktree pane layout.",
        )
        shellPaneId = parseSplitPaneId(splitOutput)
        layout = parsePaneLayout(await runStage(
          this.dependencies,
          {
            executable: "herdr",
            args: ["pane", "layout", "--pane", worktree.paneId],
            cwd: repository.root,
            ...(signal ? { signal } : {}),
          },
          "Could not verify the new Herdr worktree pane layout.",
        ))
        if (expectedShellPane(layout, worktree.paneId) !== shellPaneId) {
          throw new DispatchError(
            "Herdr did not create the expected agent-top 70% and shell-bottom 30% pane layout.",
          )
        }
      } else {
        const existingShellPaneId = expectedShellPane(layout, worktree.paneId)
        if (!existingShellPaneId) {
          throw new DispatchError(
            "The Herdr worktree layout is not dispatch-compatible. Expected the root agent pane on top at 70% and one shell pane below at 30%.",
          )
        }
        shellPaneId = existingShellPaneId
      }
      partial.shellPaneId = shellPaneId

      const agentName = (this.dependencies.createAgentName ?? createAgentName)(
        validated.branch,
      )
      partial.agentName = agentName
      this.log("info", "Starting OpenCode Build agent in auto-approve mode", {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        agentName,
      })
      const startCommand: CommandSpec = {
        executable: "herdr",
        args: [
          "agent",
          "start",
          agentName,
          "--kind",
          "opencode",
          "--pane",
          worktree.paneId,
          "--timeout",
          "60000",
          "--",
          "--agent",
          IMPLEMENTOR_AGENT,
          "--model",
          this.implementationModel,
          "--auto",
        ],
        cwd: repository.root,
        ...(signal ? { signal } : {}),
      }
      await this.startAgentWhenShellReady(startCommand)
      this.log("info", "OpenCode Build agent started", {
        paneId: worktree.paneId,
        agentName,
      })

      this.log("info", "Delivering implementation plan", {
        agentName,
        planLength: validated.plan.length,
      })
      const promptCommand: CommandSpec = {
        executable: "herdr",
        args: [
          "agent",
          "prompt",
          agentName,
          [
            "Herdr implementation assignment — workspace setup is COMPLETE.",
            `Assigned directory: ${worktree.path}`,
            `Assigned branch: ${validated.branch}`,
            `Resolved base: ${base.label} at ${base.commit}`,
            "Implement in this directory and branch. Do not create another worktree, branch, or agent, and do not fetch a new baseline to repeat setup. Any setup wording below describes work already performed by the dispatcher. If the assignment appears inconsistent, stop and ask.",
            "",
            "Agreed implementation plan:",
            validated.plan,
          ].join("\n"),
        ],
        cwd: repository.root,
        redactArgs: [3],
        ...(signal ? { signal } : {}),
      }
      const workingObserved = await this.deliverPlan(promptCommand, agentName)
      this.log(workingObserved ? "info" : "warn", workingObserved
        ? "Implementation plan admitted by OpenCode"
        : "Implementation plan submitted; OpenCode has not reported working yet",
        {
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        agentName,
      })

      return {
        mode: validated.mode,
        title: validated.title,
        branch: validated.branch,
        base: base.label,
        baseCommit: base.commit,
        ...(validated.source ? { source: validated.source } : {}),
        reusedWorktree: existingWorktree !== undefined,
        workspaceId: worktree.workspaceId,
        paneId: worktree.paneId,
        shellPaneId,
        agentName,
        planDelivered: true,
        ...(worktree.path ? { path: worktree.path } : {}),
        ...(worktree.branch ? { worktreeBranch: worktree.branch } : {}),
      }
    } catch (error) {
      if (Object.keys(partial).length > 0) {
        throw new DispatchError(
          error instanceof Error ? error.message : String(error),
          { cause: error, partial },
        )
      }
      throw error
    } finally {
      inFlight.delete(key)
    }
  }

  private async assertPrimaryCheckoutSafe(
    repositoryRoot: string,
    input: ValidatedDispatchInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = await runStage(
      this.dependencies,
      {
        executable: "git",
        args: ["status", "--porcelain", "--untracked-files=all"],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not inspect the primary checkout before dispatch.",
    )
    if (status.trim() && !input.allowDirtyRoot) {
      throw new DispatchError(
        "The primary checkout has uncommitted files that will not be included in the feature worktree. Confirm this explicitly and dispatch with allowDirtyRoot only if that is intentional.",
      )
    }
  }

  private async readRootState(
    repositoryRoot: string,
    signal?: AbortSignal,
  ): Promise<RootState> {
    const command = (args: readonly string[], failure: string) =>
      runStage(
        this.dependencies,
        {
          executable: "git",
          args,
          cwd: repositoryRoot,
          ...(signal ? { signal } : {}),
        },
        failure,
      )
    const [branch, commit, status] = await Promise.all([
      command(["rev-parse", "--abbrev-ref", "HEAD"], "Could not read the root branch."),
      command(["rev-parse", "--verify", "HEAD"], "Could not read the root commit."),
      command(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        "Could not read the root status.",
      ),
    ])
    return { branch: branch.trim(), commit: commit.trim(), status }
  }

  private async assertRootStateUnchanged(
    repositoryRoot: string,
    expected: RootState,
    signal?: AbortSignal,
  ): Promise<void> {
    const actual = await this.readRootState(repositoryRoot, signal)
    if (
      actual.branch !== expected.branch ||
      actual.commit !== expected.commit ||
      actual.status !== expected.status
    ) {
      throw new DispatchError(
        "The primary checkout changed during dispatch. No agent was started and the plugin did not reset or repair it.",
      )
    }
  }

  private async assertLinkedWorktree(
    repository: RepositoryInfo,
    worktreePath: string,
    expectedBranch: string,
    expectedCommit: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const canonicalPath = await this.dependencies.realpath(worktreePath)
    if (canonicalPath === repository.root) {
      throw new DispatchError(
        "Herdr returned the primary checkout as the dispatch target. No agent was started.",
      )
    }
    const output = (args: readonly string[], failure: string) =>
      runStage(
        this.dependencies,
        {
          executable: "git",
          args,
          cwd: canonicalPath,
          ...(signal ? { signal } : {}),
        },
        failure,
      )
    const [rootOutput, gitDirOutput, commonDirOutput, branchOutput, commitOutput] =
      await Promise.all([
        output(["rev-parse", "--show-toplevel"], "Could not verify the worktree root."),
        output(["rev-parse", "--git-dir"], "Could not verify the worktree Git directory."),
        output(
          ["rev-parse", "--git-common-dir"],
          "Could not verify the worktree common Git directory.",
        ),
        output(["rev-parse", "--abbrev-ref", "HEAD"], "Could not verify the worktree branch."),
        output(["rev-parse", "--verify", "HEAD"], "Could not verify the worktree commit."),
      ])
    const worktreeRoot = await this.dependencies.realpath(rootOutput.trim())
    const gitDir = await this.dependencies.realpath(
      path.resolve(canonicalPath, gitDirOutput.trim()),
    )
    const commonDir = await this.dependencies.realpath(
      path.resolve(canonicalPath, commonDirOutput.trim()),
    )
    if (
      worktreeRoot !== canonicalPath ||
      commonDir !== repository.commonDir ||
      gitDir === commonDir ||
      branchOutput.trim() !== expectedBranch ||
      (expectedCommit !== undefined && commitOutput.trim() !== expectedCommit)
    ) {
      throw new DispatchError(
        "Herdr returned a checkout that does not match the requested linked worktree, branch, and base commit. No agent was started.",
      )
    }
  }

  private async linkEnvironmentFiles(
    repositoryRoot: string,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<number> {
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

  private async startAgentWhenShellReady(command: CommandSpec): Promise<void> {
    const deadline = Date.now() + SHELL_READY_TIMEOUT_MS

    while (true) {
      try {
        await this.dependencies.runner.run(command)
        return
      } catch (error) {
        if (
          herdrErrorCode(error) !== "agent_pane_busy" ||
          Date.now() >= deadline
        ) {
          if (error instanceof CommandError || error instanceof DispatchError) {
            throw new DispatchError(
              `The worktree exists, but no OpenCode agent was started. No cleanup was attempted.\n${error.message}`,
              { cause: error },
            )
          }
          throw error
        }

        await delay(SHELL_READY_RETRY_MS, undefined, {
          ...(command.signal ? { signal: command.signal } : {}),
        })
      }
    }
  }

  private async deliverPlan(command: CommandSpec, agentName: string): Promise<boolean> {
    const failurePrefix =
      "The workspace and agent exist, but OpenCode did not confirm plan admission. Inspect the existing agent before retrying; no cleanup was attempted."

    try {
      await this.dependencies.runner.run(command)
    } catch (error) {
      if (herdrErrorCode(error) !== "agent_prompt_stalled") {
        if (error instanceof CommandError || error instanceof DispatchError) {
          throw new DispatchError(`${failurePrefix}\n${error.message}`, { cause: error })
        }
        throw error
      }

      this.log("warn", "Herdr accepted the implementation plan but prompt activity observation stalled; no retry attempted", {
        agentName,
      })
    }

    try {
      await this.dependencies.runner.run({
        executable: "herdr",
        args: ["agent", "wait", agentName, "--until", "working", "--timeout", "60000"],
        cwd: command.cwd,
        ...(command.signal ? { signal: command.signal } : {}),
      })
      return true
    } catch (error) {
      const code = herdrErrorCode(error)
      if (code === "timeout" || code === "agent_wait_timeout" || code === "agent_prompt_stalled") {
        this.log("warn", "Implementation plan was submitted, but OpenCode did not reach working before the observation timeout; no retry attempted", {
          agentName,
          code,
        })
        return false
      }
      if (error instanceof CommandError || error instanceof DispatchError) {
        throw new DispatchError(`${failurePrefix}\nHerdr could not observe the agent becoming working.\n${error.message}`, { cause: error })
      }
      throw error
    }
  }

  private async resolveBase(
    repositoryRoot: string,
    input: ValidatedDispatchInput,
    signal?: AbortSignal,
  ): Promise<ResolvedBase> {
    return withFetchLock(repositoryRoot, async () => {
      if (input.source) {
        return this.resolveBaseRef(repositoryRoot, input.source, signal)
      }
      if (input.base) {
        return this.resolveBaseRef(repositoryRoot, input.base, signal)
      }

      const remoteHead = await runStage(
        this.dependencies,
        {
          executable: "git",
          args: ["ls-remote", "--symref", "origin", "HEAD"],
          cwd: repositoryRoot,
          ...(signal ? { signal } : {}),
        },
        "Could not resolve origin's default branch. Add a working origin remote or explicitly request a local base such as HEAD.",
      )
      const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu.exec(remoteHead)
      if (!match?.[1]) {
        throw new DispatchError(
          "Origin did not advertise a default branch. Specify an explicit base or repair origin's HEAD.",
        )
      }
      return this.fetchRemoteBranch(repositoryRoot, "origin", match[1], signal)
    })
  }

  private async resolveBaseRef(
    repositoryRoot: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<ResolvedBase> {
    const remotesOutput = await runStage(
      this.dependencies,
      {
        executable: "git",
        args: ["remote"],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not list Git remotes.",
    )
    const remote = remotesOutput
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .find((candidate) => ref.startsWith(`${candidate}/`))
    if (remote) {
      const branch = ref.slice(remote.length + 1)
      if (!branch) throw new DispatchError("Remote branch must not be empty.")
      return this.fetchRemoteBranch(repositoryRoot, remote, branch, signal)
    }

    const commit = (await runStage(
      this.dependencies,
      {
        executable: "git",
        args: ["rev-parse", "--verify", `${ref}^{commit}`],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      `Git base ${JSON.stringify(ref)} could not be resolved.`,
    )).trim()
    return { label: ref, commit }
  }

  private async fetchRemoteBranch(
    repositoryRoot: string,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<ResolvedBase> {
    await runStage(
      this.dependencies,
      {
        executable: "git",
        args: ["check-ref-format", "--branch", branch],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      `Remote branch ${JSON.stringify(`${remote}/${branch}`)} is invalid.`,
    )
    const trackingRef = `refs/remotes/${remote}/${branch}`
    const temporaryRef = `refs/opencode-herdr-dispatch/${randomUUID()}`
    try {
      await runStage(
        this.dependencies,
        {
          executable: "git",
          args: [
            "fetch",
            "--no-tags",
            remote,
            `+refs/heads/${branch}:${temporaryRef}`,
          ],
          cwd: repositoryRoot,
          ...(signal ? { signal } : {}),
        },
        `Could not freshly fetch ${JSON.stringify(`${remote}/${branch}`)}.`,
      )
      const commit = (await runStage(
        this.dependencies,
        {
          executable: "git",
          args: ["rev-parse", "--verify", `${temporaryRef}^{commit}`],
          cwd: repositoryRoot,
          ...(signal ? { signal } : {}),
        },
        `Fetched branch ${JSON.stringify(`${remote}/${branch}`)} could not be pinned.`,
      )).trim()
      await runStage(
        this.dependencies,
        {
          executable: "git",
          args: ["update-ref", trackingRef, commit],
          cwd: repositoryRoot,
          ...(signal ? { signal } : {}),
        },
        `Could not update tracking ref ${JSON.stringify(`${remote}/${branch}`)}.`,
      )
      return { label: `${remote}/${branch}`, commit }
    } finally {
      try {
        await this.dependencies.runner.run({
          executable: "git",
          args: ["update-ref", "-d", temporaryRef],
          cwd: repositoryRoot,
        })
      } catch {
        // A failed fetch may never create the temporary ref.
      }
    }
  }

  private async findExistingWorktree(
    repositoryRoot: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<ExistingWorktreeInfo | undefined> {
    const output = await runStage(
      this.dependencies,
      {
        executable: "herdr",
        args: ["worktree", "list", "--cwd", repositoryRoot],
        cwd: repositoryRoot,
        ...(signal ? { signal } : {}),
      },
      "Could not list existing Herdr worktrees.",
    )
    const matching = parseWorktreeListResult(output).find(
      (worktree) => worktree.branch === branch,
    )
    if (!matching) return undefined
    const matchingPath = await this.dependencies.realpath(matching.path)
    if (matchingPath === repositoryRoot || matching.isLinkedWorktree === false) {
      throw new DispatchError(
        `Branch ${JSON.stringify(branch)} is checked out in the primary checkout and cannot be used as a dispatch target. Choose a separate feature branch.`,
      )
    }
    return { ...matching, path: matchingPath }
  }
}

export function formatDispatchResult(result: DispatchResult): string {
  return [
    "Plan delivered to an OpenCode Build agent in Herdr.",
    `Mode: ${result.mode}`,
    `Feature: ${result.title}`,
    `Branch: ${result.branch}`,
    ...(result.source ? [`Source: ${result.source}`] : []),
    `Base: ${result.base}`,
    `Base commit: ${result.baseCommit}`,
    `Reused worktree: ${result.reusedWorktree ? "yes" : "no"}`,
    `Workspace ID: ${result.workspaceId}`,
    `Pane ID: ${result.paneId}`,
    `Agent: ${result.agentName}`,
    ...(result.path ? [`Worktree: ${result.path}`] : []),
    "Plan delivered: yes",
  ].join("\n")
}
