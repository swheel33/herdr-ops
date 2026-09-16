import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { lock } from "proper-lockfile"

import { CommandError } from "./errors.js"
import {
  parseWorktreeListResult,
  parseWorktreeResult,
  type ExistingWorktreeInfo,
} from "./dispatch.js"
import type { CommandRunner, DispatchLogger } from "./types.js"

const DEVELOP_BRANCH = "develop"
export const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1_000
const MAINTENANCE_LOCK_STALE_MS = 30 * 60 * 1_000

interface PullRequestInfo {
  number?: unknown
  isDraft?: unknown
  headRefName?: unknown
  headRefOid?: unknown
  isCrossRepository?: unknown
  state?: unknown
}

function parsePullRequests(stdout: string): PullRequestInfo[] {
  const parsed = JSON.parse(stdout) as unknown
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not return an array")
  return parsed.map((entry) => entry as PullRequestInfo)
}

function isLockHeld(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOCKED"
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
    if (error instanceof CommandError && error.result.exitCode === 1) return false
    throw error
  }
}

export class RepositoryMaintenance {
  private controller = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined

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
    const statePath = path.join(stateDirectory, "maintenance.json")
    await mkdir(stateDirectory, { recursive: true })

    let release: (() => Promise<void>) | undefined
    try {
      release = await lock(statePath, {
        realpath: false,
        retries: 0,
        stale: MAINTENANCE_LOCK_STALE_MS,
      })
    } catch (error) {
      if (!isLockHeld(error)) throw error
      this.logger?.("debug", "Skipping repository maintenance held by another OpenCode process", {
        repository: this.repositoryRoot,
      })
      return
    }

    try {
      const lastSuccessfulRun = await this.readLastSuccessfulRun(statePath)
      if (Date.now() - lastSuccessfulRun < MAINTENANCE_INTERVAL_MS) {
        this.logger?.("debug", "Skipping recently completed repository maintenance", {
          repository: this.repositoryRoot,
          lastSuccessfulRun,
        })
        return
      }

      await this.performUnlocked()
      await this.writeLastSuccessfulRun(statePath, Date.now())
    } finally {
      await release()
    }
  }

  private async performUnlocked(): Promise<void> {
    const signal = this.controller.signal
    // Share PR discovery between metadata and cleanup, but never across runs.
    this.pullRequests.clear()
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

  private readonly pullRequests = new Map<string, PullRequestInfo[]>()

  private async branchPullRequests(branch: string, signal: AbortSignal): Promise<PullRequestInfo[]> {
    const cached = this.pullRequests.get(branch)
    if (cached) return cached
    const requests = parsePullRequests((await this.runner.run({
      executable: "gh",
      args: ["pr", "list", "--state", "all", "--head", branch, "--limit", "100",
        "--json", "number,isDraft,headRefName,headRefOid,isCrossRepository,state"],
      cwd: this.repositoryRoot,
      signal,
    })).stdout).filter((pr) => pr.headRefName === branch && pr.isCrossRepository === false)
    this.pullRequests.set(branch, requests)
    return requests
  }

  private async refreshMetadata(signal: AbortSignal): Promise<void> {
    for (const worktree of await this.listWorktrees(signal)) {
      if (!worktree.openWorkspaceId) continue
      try {
        const branch = worktree.branch ?? ""
        const requests = branch ? await this.branchPullRequests(branch, signal) : []
        const pr = requests.find((pr) => pr.state === "OPEN") ?? requests[0]
        const valid = typeof pr?.number === "number" && Number.isSafeInteger(pr.number) && pr.number > 0
        const status = pr?.state === "MERGED" ? "merged" : pr?.state === "CLOSED" ? "closed"
          : pr?.isDraft === true ? "draft" : "open"
        const tokens: Record<string, string> = {}
        if (valid) tokens[`pr_${status}`] = `#${pr.number}`
        const args = ["workspace", "report-metadata", worktree.openWorkspaceId,
          "--source", "herdr-ops.pr", "--ttl-ms", "1800000"]
        for (const name of ["pr_branch", "pr_open", "pr_draft", "pr_merged", "pr_closed"]) {
          if (tokens[name]) args.push("--token", `${name}=${tokens[name]}`)
          else args.push("--clear-token", name)
        }
        await this.runner.run({ executable: "herdr", args, cwd: this.repositoryRoot, signal })
      } catch (error) {
        if (signal.aborted) throw error
        this.logger?.("warn", "Could not report workspace PR metadata", {
          workspace: worktree.openWorkspaceId, error: String(error),
        })
      }
    }
  }

  private async readLastSuccessfulRun(statePath: string): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as {
        lastSuccessfulRun?: unknown
      }
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
    const localExists = await commandSucceeds(
      this.runner,
      this.repositoryRoot,
      ["show-ref", "--verify", "--quiet", localRef],
      signal,
    )
    if (!localExists) {
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

    const worktrees = await this.listWorktrees(signal)
    const checkout = worktrees.find((worktree) => worktree.branch === DEVELOP_BRANCH)
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
    const worktrees = await this.listWorktrees(signal)
    for (const worktree of worktrees) {
      if (worktree.isLinkedWorktree !== true || !worktree.branch) continue
      const branch = worktree.branch
      try {
        if (!await this.canRemoveWorktree(worktree, branch, signal)) continue

        let workspaceID = worktree.openWorkspaceId
        if (!workspaceID) {
          const opened = await this.runner.run({
            executable: "herdr",
            args: [
              "worktree",
              "open",
              "--cwd",
              this.repositoryRoot,
              "--path",
              worktree.path,
              "--no-focus",
            ],
            cwd: this.repositoryRoot,
            signal,
          })
          workspaceID = parseWorktreeResult(opened.stdout).workspaceId
        }
        if (!await this.canRemoveWorktree(worktree, branch, signal)) continue
        await this.runner.run({
          executable: "herdr",
          args: ["worktree", "remove", "--workspace", workspaceID, "--force"],
          cwd: this.repositoryRoot,
          signal,
        })
        this.logger?.("info", "Removed worktree for closed pull request", {
          branch: worktree.branch,
          path: worktree.path,
          workspaceID,
        })
      } catch (error) {
        if (signal.aborted) throw error
        this.logger?.("warn", "Could not inspect or remove pull request worktree", {
          branch: worktree.branch,
          path: worktree.path,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async canRemoveWorktree(
    worktree: ExistingWorktreeInfo,
    branch: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const worktreeCommit = (await this.runner.run({
      executable: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: worktree.path,
      signal,
    })).stdout.trim()
    // Cleanup revalidates GitHub state immediately before removing a checkout.
    this.pullRequests.delete(branch)
    const pullRequests = await this.branchPullRequests(branch, signal)
    if (
      pullRequests.length === 0 ||
      pullRequests.some((pullRequest) => pullRequest.state === "OPEN")
    ) {
      return false
    }
    return pullRequests.some(
      (pullRequest) =>
        (pullRequest.state === "CLOSED" || pullRequest.state === "MERGED") &&
        pullRequest.headRefOid === worktreeCommit,
    )
  }

  private async listWorktrees(signal: AbortSignal) {
    const output = await this.runner.run({
      executable: "herdr",
      args: ["worktree", "list", "--cwd", this.repositoryRoot],
      cwd: this.repositoryRoot,
      signal,
    })
    return parseWorktreeListResult(output.stdout)
  }
}
