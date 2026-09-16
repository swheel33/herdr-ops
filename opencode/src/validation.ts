import { resolve } from "node:path"

import { CommandError, DispatchError } from "./errors.js"
import type {
  CommandRunner,
  DispatchMode,
  DispatchInput,
  RepositoryInfo,
} from "./types.js"

export const MIN_PLAN_LENGTH = 80
export const MAX_TITLE_LENGTH = 80

export interface ValidatedDispatchInput {
  mode: DispatchMode
  title: string
  branch: string
  plan: string
  base?: string
  source?: string
  allowDirtyRoot: boolean
}

export function validatePlan(plan: string): void {
  const trimmed = plan.trim()
  if (!trimmed) throw new DispatchError("Plan must not be empty.")
  if (trimmed.length < MIN_PLAN_LENGTH || trimmed.split(/\s+/u).length < 10) {
    throw new DispatchError(
      `Plan is underspecified; provide at least ${MIN_PLAN_LENGTH} characters and 10 words.`,
    )
  }
}

export async function validateBranch(
  runner: CommandRunner,
  cwd: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!branch.trim()) throw new DispatchError("Branch must not be empty.")
  try {
    await runner.run({
      executable: "git",
      args: ["check-ref-format", "--branch", branch],
      cwd,
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (error instanceof CommandError) {
      throw new DispatchError(`Invalid Git branch name ${JSON.stringify(branch)}.`, {
        cause: error,
      })
    }
    throw error
  }
}

async function gitOutput(
  runner: CommandRunner,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await runner.run({
      executable: "git",
      args,
      cwd,
      ...(signal ? { signal } : {}),
    })
    return result.stdout.trim()
  } catch (error) {
    if (error instanceof CommandError) {
      throw new DispatchError(`Dispatch must run inside a Git repository.\n${error.message}`, {
        cause: error,
      })
    }
    throw error
  }
}

export async function isLinkedWorktree(
  runner: CommandRunner,
  cwd: string,
  realpath: (path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const [gitDirResult, commonDirResult] = await Promise.all([
      runner.run({
        executable: "git",
        args: ["rev-parse", "--git-dir"],
        cwd,
        ...(signal ? { signal } : {}),
      }),
      runner.run({
        executable: "git",
        args: ["rev-parse", "--git-common-dir"],
        cwd,
        ...(signal ? { signal } : {}),
      }),
    ])
    const gitDir = await realpath(resolve(cwd, gitDirResult.stdout.trim()))
    const commonDir = await realpath(resolve(cwd, commonDirResult.stdout.trim()))
    return gitDir !== commonDir
  } catch (error) {
    if (error instanceof CommandError) return false
    throw error
  }
}

export async function resolveRepository(
  runner: CommandRunner,
  cwd: string,
  realpath: (path: string) => Promise<string>,
  signal?: AbortSignal,
): Promise<RepositoryInfo> {
  const rootOutput = await gitOutput(runner, cwd, ["rev-parse", "--show-toplevel"], signal)
  const gitDirOutput = await gitOutput(runner, cwd, ["rev-parse", "--git-dir"], signal)
  const commonDirOutput = await gitOutput(
    runner,
    cwd,
    ["rev-parse", "--git-common-dir"],
    signal,
  )
  const bare = await gitOutput(
    runner,
    cwd,
    ["rev-parse", "--is-bare-repository"],
    signal,
  )

  if (bare === "true") throw new DispatchError("Bare Git repositories are not supported.")

  const root = await realpath(resolve(cwd, rootOutput))
  const gitDir = await realpath(resolve(cwd, gitDirOutput))
  const commonDir = await realpath(resolve(cwd, commonDirOutput))

  if (gitDir !== commonDir) {
    throw new DispatchError(
      "Dispatch from a linked worktree is not supported. Start Project Chat in the primary checkout.",
    )
  }

  return { root, gitDir, commonDir }
}

export async function validateDispatchInput(
  runner: CommandRunner,
  cwd: string,
  input: DispatchInput,
  signal?: AbortSignal,
): Promise<ValidatedDispatchInput> {
  const title = input.title.trim()
  const branch = input.branch.trim()
  const plan = input.plan.trim()
  const base = input.base?.trim()
  const source = input.source?.trim()

  if (!title) throw new DispatchError("Feature title must not be empty.")
  if (title.length > MAX_TITLE_LENGTH) {
    throw new DispatchError(`Feature title must be at most ${MAX_TITLE_LENGTH} characters.`)
  }
  if (input.mode === "new" && source) {
    throw new DispatchError("New feature dispatches do not accept a source branch.")
  }
  if (input.mode !== "new" && !source) {
    throw new DispatchError(`${input.mode} dispatches require an existing source branch.`)
  }
  validatePlan(plan)
  await validateBranch(runner, cwd, branch, signal)
  return {
    mode: input.mode,
    title,
    branch,
    plan,
    ...(base ? { base } : {}),
    ...(source ? { source } : {}),
    allowDirtyRoot: input.allowDirtyRoot ?? false,
  }
}
