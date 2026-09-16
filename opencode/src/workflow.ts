import { randomUUID } from "node:crypto"
import type { Config } from "@opencode-ai/plugin"

export const IMPLEMENTOR_AGENT = "build"
export const IMPLEMENTOR_MODEL = "openai/gpt-5.6-luna-fast"

export interface WorkflowModels {
  implementor: { model: string; variant: string }
}

export function resolveWorkflowModels(options: Record<string, unknown> = {}): WorkflowModels {
  const role = (name: string, model: string, variant: string) => {
    const value = options[name]
    if (value === undefined) return { model, variant }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${name} must be an object with model and optional variant.`)
    }
    const settings = value as Record<string, unknown>
    const selectedModel = settings.model ?? model
    // A different model must not inherit a model-specific reasoning variant.
    const selectedVariant = settings.variant ?? (selectedModel === model ? variant : "default")
    if (typeof selectedModel !== "string" || !/^[^\s/]+\/\S+$/.test(selectedModel)) {
      throw new Error(`${name}.model must be a provider/model identifier.`)
    }
    if (typeof selectedVariant !== "string" || !selectedVariant.trim()) {
      throw new Error(`${name}.variant must be a nonempty string.`)
    }
    return { model: selectedModel, variant: selectedVariant }
  }
  return { implementor: role("implementor", IMPLEMENTOR_MODEL, "high") }
}

export const FEATURE_COMMAND_TEMPLATE = `Dispatch the single agreed implementation outcome from this conversation to Herdr. This /feature invocation is explicit authorization to dispatch; ordinary planning conversation is not.

Optional scope filter or clarification: $ARGUMENTS

Use the latest settled plan plus the user's subsequent corrections. Copy that plan's implementation body rather than paraphrasing or enriching it. Remove conversational lead-ins if needed. Apply later corrections, or append a short clarification section. Do not accumulate requirements from earlier proposals after a narrowed plan replaces them. Only bring earlier details forward when the settled plan explicitly depends on them (for example, replace "use the earlier profiles" with those actual profiles). Do not add new architecture, acceptance criteria, tests, or verification work to make a short plan look complete. A precise paragraph is enough for a small change. Do not resurrect rejected alternatives.

If no implementation-ready scope exists, or a material product/design decision remains unresolved, ask the user rather than choose for them. If you finish this turn without dispatch, ask them to run /feature again when ready.

Read applicable project instructions. Ask about concrete conflicts with the agreed plan. Inspect Git metadata with inspect_herdr_repository before dispatch. Dispatch one new branch from a freshly fetched origin default unless another base is explicitly requested. A primary checkout branch such as develop/main is a base, not a dispatch target. Dirty-root approval does not copy uncommitted files; explain this and obtain explicit approval when needed.

Put branch creation, fetching, and worktree setup intent in the tool's Git fields, not as tasks in the implementation plan. The plugin completes that setup before the implementor receives the plan. Always launch the configured implementor; do not carry the orchestrator's current agent or model into the worktree.

Call dispatch_feature_to_herdr once, using the invocation authorization provided by the plugin. Report the result and any partial resources. Do not retry an unclear or failed launch. Delivery is not implementation completion. Remain the orchestrator in this checkout.`

export const IMPLEMENTOR_PROMPT = `You implement the agreed handoff in this worktree. Workspace setup is already complete. Use the assigned current directory and branch. Do not create another worktree or branch, re-fetch a newer base, or move the work to another checkout to repeat setup instructions in the plan. If the assignment is inconsistent, report it before proceeding. The handoff is the settled scope, not an invitation to redesign it.
Read applicable project instructions and relevant source, then execute the plan. Reuse existing mechanisms and remove superseded duplication when the agreed change calls for it. Do not add speculative abstractions, compatibility layers, unrelated cleanup, or tests that were not requested.
Adapt ordinary implementation details to the actual code. If evidence contradicts a material design decision or requires a scope expansion, explain the concrete conflict and ask before proceeding. Distinguish a hypothesis from a reproduced cause. For a bug fix, preserve the reported user-visible outcome rather than substituting an architecture cleanup.
Do not dispatch other worktrees. Report what was changed, what was actually verified, remaining blockers, and any deviations from the handoff. Do not claim implementation success merely because commands completed.`

/** Authorization is process-local, single-use, and bound to the command's user message. */
export class FeatureAuthorization {
  private readonly pending = new Map<string, { token: string; messageID?: string; sourceMessageIDs: string[] }>()

  issue(sessionID: string, sourceMessageIDs: string[]): string {
    const token = randomUUID()
    this.pending.set(sessionID, { token, sourceMessageIDs })
    return token
  }

  bind(sessionID: string, messageID: string, text: string): void {
    const entry = this.pending.get(sessionID)
    if (!entry) return
    if (!entry.messageID && text.includes(this.marker(entry.token))) entry.messageID = messageID
    else this.clear(sessionID)
  }

  marker(token: string): string {
    return `<feature_authorization>${token}</feature_authorization>`
  }

  consume(sessionID: string, token: string, latestUserMessageID: string): string[] {
    const entry = this.pending.get(sessionID)
    if (!entry || entry.token !== token || !entry.messageID || entry.messageID !== latestUserMessageID) {
      throw new Error("Dispatch requires a current /feature invocation. Ordinary conversation cannot authorize implementation.")
    }
    this.clear(sessionID)
    return entry.sourceMessageIDs
  }

  clear(sessionID: string): void {
    this.pending.delete(sessionID)
  }
}

export function configureFeatureWorkflow(config: Config, linkedWorktree = false, models = resolveWorkflowModels()): void {
  config.agent ??= {}
  // Retire legacy file/inline registrations as well as the old runtime agent.
  config.agent["herdr-feature-coordinator"] = { disable: true }
  config.agent["herdr-implementor"] = { disable: true }
  config.command ??= {}
  if (linkedWorktree) {
    config.agent.build = {
      ...config.agent.build,
      ...models.implementor,
      permission: {
        ...config.agent.build?.permission,
        dispatch_feature_to_herdr: "deny",
      } as NonNullable<Config["permission"]>,
    }
    delete config.command.feature
    return
  }
  config.command.feature = {
    description: "Dispatch the agreed plan to a Herdr implementation worktree.",
    subtask: false,
    template: FEATURE_COMMAND_TEMPLATE,
  }
  config.permission ??= {}
  if (typeof config.permission === "object") {
    Object.assign(config.permission, {
      inspect_herdr_repository: "allow",
      dispatch_feature_to_herdr: "allow",
    })
  }
}
