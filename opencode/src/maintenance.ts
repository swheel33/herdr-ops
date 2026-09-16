import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { CommandError } from "./errors.js"
import { parseWorktreeListResult, parseWorktreeResult, type ExistingWorktreeInfo } from "./dispatch.js"
import { withRepositoryLock } from "./repository-lock.js"
import type { CommandRunner, DispatchLogger } from "./types.js"

const DEVELOP_BRANCH = "develop"
const METADATA_SOURCE = "herdr-ops.pr"
const METADATA_TOKENS = ["pr_branch", "pr_open", "pr_draft", "pr_merged", "pr_closed"] as const

export const MAINTENANCE_INTERVAL_MS = 1 * 60 * 1_000
export const METADATA_TTL_MS = 2 * 60 * 60 * 1_000
const MAINTENANCE_STATE_FILE = "maintenance.json"

interface PullRequestInfo {
  number?: unknown
  isDraft?: unknown
  headRefName?: unknown
  headRefOid?: unknown
  isCrossRepository?: unknown
  state?: unknown
}

interface AgentInfo {
  agentStatus?: unknown
  cwd?: unknown
  workspaceId?: unknown
}

function parsePullRequests(stdout: string): PullRequestInfo[] {
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not return an array")
  return parsed.map((entry) => entry as PullRequestInfo)
}

function parseAgents(stdout: string): AgentInfo[] {
  const parsed = JSON.parse(stdout) as { result?: { agents?: unknown } }
  if (!Array.isArray(parsed.result?.agents)) throw new Error("herdr agent list did not return an agent array")
  return parsed.result.agents.map((entry) => {
    const value = entry as Record<string, unknown>
    return {
      ...(typeof value.agent_status === "string" ? { agentStatus: value.agent_status } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
      ...(typeof value.workspace_id === "string" ? { workspaceId: value.workspace_id } : {}),
    }
  })
}

function commandSucceededError(error: unknown): boolean {
  return error instanceof CommandError && error.result.exitCode === 1
}

async function commandSucceeds(
  runner: CommandRunner,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await runner.run({ executable: "git", args, cwd, ...(signal ? { signal } : {}) })
    return true
  } catch (error) {
    if (commandSucceededError(error)) return false
    throw error
  }
}

function isActiveAgent(agent: AgentInfo): boolean {
  return agent.agentStatus !== "idle"
}

export class RepositoryMaintenance {
  private readonly controller = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private pullRequests: Promise<PullRequestInfo[]> | undefined

  constructor(
    private readonly runner: CommandRunner,
    private readonly repositoryRoot: string,
    private readonly commonDir: string,
    private readonly logger?: DispatchLogger,
  ) {}

  start(): void {
    void this.run()
    this.timer = setInterval(() => void this.run(), MAINTENANCE_INTERVAL_MS)
    this.timer.unref()
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.controller.abort()
    await this.running?.catch(() => {})
  }

  run(): Promise<void> {
    if (this.running) return this.running
    this.running = this.perform()
      .catch((error) => {
        if (!this.controller.signal.aborted) {
          this.logger?.("warn", "Repository maintenance failed", {
            repository: this.repositoryRoot,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }

  private async perform(): Promise<void> {
    const stateDirectory = path.join(this.commonDir, "opencode-herdr-dispatch")
    const statePath = path.join(stateDirectory, MAINTENANCE_STATE_FILE)
    await mkdir(stateDirectory, { recursive: true })

    const result = await withRepositoryLock(this.commonDir, async () => {
      const lastSuccessfulRun = await this.readLastSuccessfulRun(statePath)
      if (Date.now() - lastSuccessfulRun < MAINTENANCE_INTERVAL_MS) {
        this.logger?.("debug", "Skipping recently completed repository maintenance", {
          repository: this.repositoryRoot,
          lastSuccessfulRun,
        })
        return false
      }

      this.pullRequests = undefined
      await this.performUnlocked()
      await this.writeLastSuccessfulRun(statePath, Date.now())
      return true
    }, { skipIfLocked: true })

    if (result === undefined) {
      this.logger?.("debug", "Skipping repository maintenance held by another operation", {
        repository: this.repositoryRoot,
      })
    }
  }

  private async performUnlocked(): Promise<void> {
    const signal = this.controller.signal
    try {
      await this.runner.run({
        executable: "git",
        args: ["fetch", "--prune", "origin"],
        cwd: this.repositoryRoot,
        signal,
      })
      await this.fastForwardDevelop(signal)
      await this.removeClosedPullRequestWorktrees(signal)
    } finally {
      if (!signal.aborted) await this.refreshMetadata(signal).catch((error) => {
        this.logger?.("warn", "Could not refresh workspace PR metadata", { error: String(error) })
      })
    }
  }

  private async listPullRequests(signal: AbortSignal): Promise<PullRequestInfo[]> {
    if (!this.pullRequests) {
      this.pullRequests = this.runner.run({
        executable: "gh",
        args: [
          "pr", "list", "--state", "all", "--limit", "1000",
          "--json", "number,isDraft,headRefName,headRefOid,isCrossRepository,state",
        ],
        cwd: this.repositoryRoot,
        signal,
      }).then((result) => parsePullRequests(result.stdout))
    }
    return this.pullRequests
  }

  private async refreshMetadata(signal: AbortSignal): Promise<void> {
    for (const worktree of await this.listWorktrees(signal)) {
      if (!worktree.openWorkspaceId) continue
      try {
        const branch = worktree.branch ?? ""
        const requests = branch
          ? (await this.listPullRequests(signal)).filter((pr) =>
            pr.headRefName === branch && pr.isCrossRepository === false,
          )
          : []
        const pr = requests.find((entry) => entry.state === "OPEN") ?? requests[0]
        const validNumber = typeof pr?.number === "number" && Number.isSafeInteger(pr.number) && pr.number > 0
        const status = pr?.state === "MERGED" ? "merged" : pr?.state === "CLOSED" ? "closed"
          : pr?.isDraft === true ? "draft" : "open"
        const tokens: Record<string, string> = {}
        if (branch) tokens.pr_branch = branch
        if (validNumber) tokens[`pr_${status}`] = `#${pr.number}`
        const args = [
          "workspace", "report-metadata", worktree.openWorkspaceId,
          "--source", METADATA_SOURCE, "--ttl-ms", String(METADATA_TTL_MS),
        ]
        for (const token of METADATA_TOKENS) {
          if (tokens[token]) args.push("--token", `${token}=${tokens[token]}`)
          else args.push("--clear-token", token)
        }
        await this.runner.run({ executable: "herdr", args, cwd: this.repositoryRoot, signal })
      } catch (error) {
        if (signal.aborted) throw error
        this.logger?.("warn", "Could not report workspace PR metadata", {
          workspace: worktree.openWorkspaceId,
          error: String(error),
        })
      }
    }
  }

  private async readLastSuccessfulRun(statePath: string): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as { lastSuccessfulRun?: unknown }
      return typeof parsed.lastSuccessfulRun === "number" ? parsed.lastSuccessfulRun : 0
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0
      this.logger?.("warn", "Ignoring malformed repository maintenance state", {
        repository: this.repositoryRoot,
        error: error instanceof Error ? error.message : String(error),
      })
      return 0
    }
  }

  private async writeLastSuccessfulRun(statePath: string, timestamp: number): Promise<void> {
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ lastSuccessfulRun: timestamp })}\n`)
      await rename(temporaryPath, statePath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }

  private async fastForwardDevelop(signal: AbortSignal): Promise<void> {
    const remoteRef = `refs/remotes/origin/${DEVELOP_BRANCH}`
    const localRef = `refs/heads/${DEVELOP_BRANCH}`
    if (!await commandSucceeds(
      this.runner,
      this.repositoryRoot,
      ["show-ref", "--verify", "--quiet", remoteRef],
      signal,
    )) {
      this.logger?.("debug", "Skipping develop refresh because origin/develop does not exist", {
        repository: this.repositoryRoot,
      })
      return
    }

    const remoteCommit = (await this.runner.run({
      executable: "git",
      args: ["rev-parse", "--verify", remoteRef],
      cwd: this.repositoryRoot,
      signal,
    })).stdout.trim()
    if (!await commandSucceeds(this.runner, this.repositoryRoot, ["show-ref", "--verify", "--quiet", localRef], signal)) {
      this.logger?.("warn", "Skipping develop refresh because local develop does not exist", {
        repository: this.repositoryRoot,
      })
      return
    }

    const localCommit = (await this.runner.run({
      executable: "git",
      args: ["rev-parse", "--verify", localRef],
      cwd: this.repositoryRoot,
      signal,
    })).stdout.trim()
    if (localCommit === remoteCommit) return
    if (!await commandSucceeds(
      this.runner,
      this.repositoryRoot,
      ["merge-base", "--is-ancestor", localCommit, remoteCommit],
      signal,
    )) {
      this.logger?.("warn", "Skipping develop refresh because it has diverged from origin/develop", {
        repository: this.repositoryRoot,
        localCommit,
        remoteCommit,
      })
      return
    }

    const checkout = (await this.listWorktrees(signal)).find((worktree) => worktree.branch === DEVELOP_BRANCH)
    if (checkout) {
      const status = await this.runner.run({
        executable: "git",
        args: ["status", "--porcelain", "--untracked-files=all"],
        cwd: checkout.path,
        signal,
      })
      if (status.stdout.trim()) {
        this.logger?.("warn", "Skipping checked-out develop refresh because it is dirty", {
          path: checkout.path,
        })
        return
      }
      await this.runner.run({
        executable: "git",
        args: ["merge", "--ff-only", remoteCommit],
        cwd: checkout.path,
        signal,
      })
    } else {
      await this.runner.run({
        executable: "git",
        args: ["update-ref", localRef, remoteCommit, localCommit],
        cwd: this.repositoryRoot,
        signal,
      })
    }
    this.logger?.("info", "Fast-forwarded develop to origin/develop", {
      repository: this.repositoryRoot,
      commit: remoteCommit,
    })
  }

  private async removeClosedPullRequestWorktrees(signal: AbortSignal): Promise<void> {
    const worktrees = (await this.listWorktrees(signal)).filter((worktree) =>
      worktree.isLinkedWorktree === true && Boolean(worktree.branch),
    )
    if (!worktrees.length) return

    const agents = await this.listAgents(signal)
    for (const worktree of worktrees) {
      const branch = worktree.branch!
      try {
        if (this.hasActiveAgent(worktree, agents)) {
          this.logger?.("debug", "Skipping worktree with an active agent", {
            branch,
            path: worktree.path,
          })
          continue
        }
        if (!await this.canRemoveWorktree(worktree, branch, signal)) continue

        let workspaceID = worktree.openWorkspaceId
        if (!workspaceID) {
          const opened = await this.runner.run({
            executable: "herdr",
            args: ["worktree", "open", "--cwd", this.repositoryRoot, "--path", worktree.path, "--no-focus"],
            cwd: this.repositoryRoot,
            signal,
          })
          workspaceID = parseWorktreeResult(opened.stdout).workspaceId
        }
        if (this.hasActiveAgent(worktree, await this.listAgents(signal), workspaceID)) continue
        if (!await this.canRemoveWorktree(worktree, branch, signal)) continue
        await this.runner.run({
          executable: "herdr",
          args: ["worktree", "remove", "--workspace", workspaceID],
          cwd: this.repositoryRoot,
          signal,
        })
        this.logger?.("info", "Removed worktree for closed pull request", {
          branch,
          path: worktree.path,
          workspaceID,
        })
      } catch (error) {
        if (signal.aborted) throw error
        this.logger?.("warn", "Could not inspect or remove pull request worktree", {
          branch,
          path: worktree.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async listAgents(signal: AbortSignal): Promise<AgentInfo[]> {
    const output = await this.runner.run({
      executable: "herdr",
      args: ["agent", "list"],
      cwd: this.repositoryRoot,
      signal,
    })
    return parseAgents(output.stdout)
  }

  private hasActiveAgent(worktree: ExistingWorktreeInfo, agents: AgentInfo[], workspaceID = worktree.openWorkspaceId): boolean {
    return agents.some((agent) => {
      if (!isActiveAgent(agent)) return false
      if (workspaceID && agent.workspaceId === workspaceID) return true
      return agent.cwd === worktree.path
    })
  }

  private async canRemoveWorktree(
    worktree: ExistingWorktreeInfo,
    branch: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const status = await this.runner.run({
      executable: "git",
      args: ["status", "--porcelain", "--untracked-files=all"],
      cwd: worktree.path,
      signal,
    })
    if (status.stdout.trim()) {
      this.logger?.("debug", "Skipping dirty pull request worktree", {
        branch,
        path: worktree.path,
      })
      return false
    }

    const worktreeCommit = (await this.runner.run({
      executable: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: worktree.path,
      signal,
    })).stdout.trim()
    const pullRequests = (await this.listPullRequests(signal)).filter((pr) =>
      pr.headRefName === branch && pr.isCrossRepository === false,
    )
    if (pullRequests.length === 0 || pullRequests.some((pr) => pr.state === "OPEN")) return false
    return pullRequests.some((pr) =>
      (pr.state === "CLOSED" || pr.state === "MERGED") && pr.headRefOid === worktreeCommit,
    )
  }

  private async listWorktrees(signal: AbortSignal): Promise<ExistingWorktreeInfo[]> {
    const output = await this.runner.run({
      executable: "herdr",
      args: ["worktree", "list", "--cwd", this.repositoryRoot],
      cwd: this.repositoryRoot,
      signal,
    })
    return parseWorktreeListResult(output.stdout)
  }
}
