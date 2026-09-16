import { DispatchError } from "./errors.js"
import { HerdrDispatcher } from "./dispatch.js"
import type {
  BatchDispatchInput,
  BatchDispatchResult,
  BatchFeatureResult,
  CommandRunner,
  DispatchInput,
} from "./types.js"
import { validateDispatchInput } from "./validation.js"

const MAX_BATCH_SIZE = 8
const MAX_CONCURRENCY = 3

function featureInput(
  feature: BatchDispatchInput["features"][number],
  allowDirtyRoot: boolean,
): DispatchInput {
  return {
    mode: feature.mode,
    title: feature.title,
    branch: feature.branch,
    plan: feature.plan,
    ...(feature.source === undefined ? {} : { source: feature.source }),
    ...(feature.base === undefined ? {} : { base: feature.base }),
    allowDirtyRoot,
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = value.trim()
    if (seen.has(normalized)) {
      throw new DispatchError(`Batch dispatch contains duplicate ${label} ${JSON.stringify(normalized)}.`)
    }
    seen.add(normalized)
  }
}

export async function dispatchBatch(
  dispatcher: HerdrDispatcher,
  runner: CommandRunner,
  cwd: string,
  input: BatchDispatchInput,
  signal?: AbortSignal,
): Promise<BatchDispatchResult> {
  if (input.features.length < 1 || input.features.length > MAX_BATCH_SIZE) {
    throw new DispatchError(`Batch dispatch requires between 1 and ${MAX_BATCH_SIZE} features.`)
  }

  assertUnique(input.features.map((feature) => feature.id), "feature ID")
  assertUnique(input.features.map((feature) => feature.branch), "target branch")

  const allowDirtyRoot = input.allowDirtyRoot ?? false
  try {
    await Promise.all(
      input.features.map((feature) =>
        validateDispatchInput(runner, cwd, featureInput(feature, allowDirtyRoot), signal),
      ),
    )
  } catch (error) {
    if (!signal?.aborted) throw error
    return {
      requested: input.features.length,
      succeeded: 0,
      failed: input.features.length,
      results: input.features.map((feature) => ({
        id: feature.id,
        title: feature.title,
        branch: feature.branch,
        status: "rejected",
        error: "Dispatch cancelled during batch validation.",
      })),
    }
  }

  const results = new Array<BatchFeatureResult>(input.features.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= input.features.length) return

      const feature = input.features[index]
      if (feature === undefined) return
      if (signal?.aborted) {
        results[index] = {
          id: feature.id,
          title: feature.title,
          branch: feature.branch,
          status: "rejected",
          error: "Dispatch cancelled before this feature started.",
        }
        continue
      }

      try {
        results[index] = {
          id: feature.id,
          title: feature.title,
          branch: feature.branch,
          status: "fulfilled",
          result: await dispatcher.dispatch(
            cwd,
            featureInput(feature, allowDirtyRoot),
            signal,
          ),
        }
      } catch (error) {
        results[index] = {
          id: feature.id,
          title: feature.title,
          branch: feature.branch,
          status: "rejected",
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof DispatchError && error.partial
            ? { partial: error.partial }
            : {}),
        }
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENCY, input.features.length) },
      () => worker(),
    ),
  )

  const completeResults = results.filter(
    (result): result is BatchFeatureResult => result !== undefined,
  )
  const succeeded = completeResults.filter((result) => result.status === "fulfilled").length
  return {
    requested: input.features.length,
    succeeded,
    failed: input.features.length - succeeded,
    results: completeResults,
  }
}

export function formatBatchDispatchResult(result: BatchDispatchResult): string {
  return [
    `Herdr batch dispatch complete: ${result.succeeded} succeeded, ${result.failed} failed.`,
    ...result.results.flatMap((feature, index) => {
      const heading = `${index + 1}. ${feature.id}: ${feature.title}`
      if (feature.status === "rejected") {
        return [
          heading,
          `Status: failed`,
          `Branch: ${feature.branch}`,
          ...(feature.partial?.workspaceId
            ? [`Workspace ID: ${feature.partial.workspaceId}`]
            : []),
          ...(feature.partial?.paneId ? [`Pane ID: ${feature.partial.paneId}`] : []),
          ...(feature.partial?.agentName ? [`Agent: ${feature.partial.agentName}`] : []),
          ...(feature.partial?.path ? [`Worktree: ${feature.partial.path}`] : []),
          `Error: ${feature.error}`,
        ]
      }
      return [
        heading,
        "Status: dispatched",
        `Mode: ${feature.result.mode}`,
        `Branch: ${feature.result.branch}`,
        `Base: ${feature.result.base}`,
        `Base commit: ${feature.result.baseCommit}`,
        `Workspace ID: ${feature.result.workspaceId}`,
        `Pane ID: ${feature.result.paneId}`,
        `Agent: ${feature.result.agentName}`,
        ...(feature.result.path ? [`Worktree: ${feature.result.path}`] : []),
      ]
    }),
  ].join("\n")
}
