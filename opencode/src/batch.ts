import { HerdrDispatcher } from "./dispatch.js"
import { DispatchError } from "./errors.js"
import type {
  BatchDispatchInput,
  BatchDispatchResult,
  BatchFeatureResult,
  DispatchInput,
} from "./types.js"

export const MAX_BATCH_SIZE = 8

function featureInput(
  feature: BatchDispatchInput["features"][number],
  allowDirtyRoot: boolean,
): DispatchInput {
  return {
    title: feature.title,
    plan: feature.plan,
    ...(feature.branch === undefined ? {} : { branch: feature.branch }),
    ...(feature.pullRequest === undefined ? {} : { pullRequest: feature.pullRequest }),
    ...(feature.base === undefined ? {} : { base: feature.base }),
    allowDirtyRoot,
  }
}

function target(feature: BatchDispatchInput["features"][number]): string {
  return feature.branch ?? feature.pullRequest ?? "<unresolved>"
}

export async function dispatchBatch(
  dispatcher: HerdrDispatcher,
  cwd: string,
  input: BatchDispatchInput,
  implementationModel: string,
  signal?: AbortSignal,
  onResult?: (result: BatchFeatureResult, index: number) => Promise<void>,
): Promise<BatchDispatchResult> {
  if (input.features.length < 1 || input.features.length > MAX_BATCH_SIZE) {
    throw new DispatchError(`Batch dispatch requires between 1 and ${MAX_BATCH_SIZE} features.`)
  }

  const allowDirtyRoot = input.allowDirtyRoot ?? false
  const seenIDs = new Set<string>()
  const results: BatchFeatureResult[] = []
  const record = async (result: BatchFeatureResult): Promise<void> => {
    results.push(result)
    await onResult?.(result, results.length - 1)
  }

  for (const feature of input.features) {
    if (signal?.aborted) {
      throw new DispatchError("Batch dispatch cancelled before the next feature started.")
    }
    const id = feature.id.trim()
    const featureTarget = target(feature)
    if (!id) {
      await record({
        id: feature.id,
        title: feature.title,
        target: featureTarget,
        status: "rejected",
        error: "Batch feature ID must not be empty.",
      })
      continue
    }
    if (seenIDs.has(id)) {
      await record({
        id,
        title: feature.title,
        target: featureTarget,
        status: "rejected",
        error: `Batch feature ID ${JSON.stringify(id)} is duplicated.`,
      })
      continue
    }
    seenIDs.add(id)

    let result: BatchFeatureResult
    try {
      result = {
        id,
        title: feature.title,
        target: featureTarget,
        status: "fulfilled",
        result: await dispatcher.dispatch(
          cwd,
          featureInput(feature, allowDirtyRoot),
          implementationModel,
          signal,
        ),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      result = {
        id,
        title: feature.title,
        target: featureTarget,
        status: "rejected",
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof DispatchError && error.partial ? { partial: error.partial } : {}),
      }
    }
    await record(result)
  }

  const succeeded = results.filter((result) => result.status === "fulfilled").length
  return {
    requested: input.features.length,
    succeeded,
    failed: input.features.length - succeeded,
    results,
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
          "Status: failed",
          `Target: ${feature.target}`,
          ...(feature.partial?.workspaceId ? [`Workspace ID: ${feature.partial.workspaceId}`] : []),
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
        ...(feature.result.pullRequest ? [`Pull request: ${feature.result.pullRequest}`] : []),
        `Base: ${feature.result.base}`,
        `Base commit: ${feature.result.baseCommit}`,
        `Reused worktree: ${feature.result.reusedWorktree ? "yes" : "no"}`,
        `Workspace ID: ${feature.result.workspaceId}`,
        `Pane ID: ${feature.result.paneId}`,
        `Shell pane ID: ${feature.result.shellPaneId}`,
        `Agent: ${feature.result.agentName}`,
        ...(feature.result.path ? [`Worktree: ${feature.result.path}`] : []),
      ]
    }),
  ].join("\n")
}
