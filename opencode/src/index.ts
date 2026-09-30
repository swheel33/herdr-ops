import { execFile as callback } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { Plugin } from "@opencode/plugin"
import { Feature, featuresSchema, type FeatureTask } from "./rpc.js"
import { startMaintenance } from "./maintenance.js"

const execFile = promisify(callback)

export async function eligible(directory: string, sessionID: string): Promise<boolean> {
  try {
    const { stdout: root } = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: directory })
    const cwd = root.trim()
    const { stdout: common } = await execFile("git", ["rev-parse", "--git-common-dir"], { cwd })
    const { stdout: local } = await execFile("git", ["rev-parse", "--git-dir"], { cwd })
    if (path.resolve(cwd, common.trim()) !== path.resolve(cwd, local.trim())) return false
    // The OpenCode service is shared between panes and does not inherit their
    // HERDR_SOCKET_PATH. Its default Herdr session may not own this conversation.
    const { stdout: response } = await execFile("herdr", ["session", "list", "--json"], { cwd, timeout: 10_000 })
    const sessions = JSON.parse(response).sessions as Array<{ name: string; running: boolean }> | undefined
    for (const session of sessions?.filter((item) => item.running) ?? []) {
      try {
        const { stdout } = await execFile("herdr", ["--session", session.name, "agent", "list"], { cwd, timeout: 10_000 })
        const agents = JSON.parse(stdout).result?.agents as Array<{ agent_session?: { value?: string } }> | undefined
        if (agents?.some((agent) => agent.agent_session?.value === sessionID)) return true
      } catch {
        // A named session may stop between discovery and inspection.
      }
    }
    return false
  } catch {
    return false
  }
}

export default Plugin.define({
  id: "herdr.feature.agent",
  async setup(ctx) {
    const stopMaintenance = startMaintenance(ctx.location.directory)
    const queuing = new Set<string>()
    const queue = async (sessionID: string, request: { features: FeatureTask[] } | { branch: string; pr: string }) => {
      if (queuing.has(sessionID)) return false
      queuing.add(sessionID)
      try {
        const key = `pending/${sessionID}`
        if (await ctx.storage.get(key)) return false
        await ctx.storage.set(key, request)
        return true
      } finally {
        queuing.delete(sessionID)
      }
    }
    await ctx.rpc.register(Feature, {
      take: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const key = `pending/${sessionID}`
        const value = await ctx.storage.get(key)
        if (!value || typeof value !== "object" || Array.isArray(value)) return { pending: false }
        await ctx.storage.remove(key)
        const request = value as Record<string, unknown>
        return { pending: true, branch: typeof request.branch === "string" ? request.branch : undefined, pr: typeof request.pr === "string" ? request.pr : undefined, features: request.features as FeatureTask[] | undefined }
      },
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "herdr_start_feature",
        description: "Request Herdr worktrees before editing. For multiple independent features, pass features with one assignment per branch; each forks the full conversation history and moves that fork into its worktree. The original conversation stays here. For a single-session move, pass pr for an existing open same-repository PR, branch for an existing or new branch, or neither. Do not call inside a worktree. Queue all features in one call, then end the turn.",
        input: {
          type: "object",
          properties: {
            branch: { type: "string", description: "Existing or new Git branch name; never use this for a pull request when its number or URL is known" },
            pr: { type: "string", description: "Existing open same-repository pull request number or URL" },
            features: featuresSchema,
          },
          additionalProperties: false,
        },
        execute: async (input, call) => {
          const session = await ctx.session.get({ sessionID: call.sessionID })
          if (session.parentID || !await eligible(session.location.directory, call.sessionID)) {
            return { content: "Feature handoff unavailable: this must be a Herdr-hosted root conversation in the primary checkout. No changes were made." }
          }
          const { stdout: status } = await execFile("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: session.location.directory })
          if (status.trim()) return { content: "Feature handoff unavailable: the primary checkout has uncommitted changes. No worktree was created. Ask the user how to handle those changes; do not discard them." }
          const features = (input as { features?: FeatureTask[] }).features
          if (features) {
            if (!features.length) return { content: "Provide at least one feature task. No worktrees were created." }
            if ("branch" in (input as object) || "pr" in (input as object)) return { content: "Specify features or a top-level branch/pr, not both. No worktrees were created." }
            const targets = new Set<string>()
            for (const feature of features) {
              feature.task = feature.task.trim()
              if (!feature.task || (feature.branch !== undefined && !feature.branch.trim()) || (feature.pr !== undefined && !feature.pr.trim())) return { content: "Feature tasks and supplied branch/PR references cannot be empty. No worktrees were created." }
              if (feature.branch && feature.pr) return { content: "Specify either pr or branch for each feature, not both. No worktrees were created." }
              if (feature.branch) {
                feature.branch = feature.branch.trim()
                await execFile("git", ["check-ref-format", "--branch", feature.branch], { cwd: session.location.directory })
              }
              if (feature.pr) feature.pr = feature.pr.trim()
              const target = feature.branch ? `branch:${feature.branch}` : feature.pr ? `pr:${feature.pr}` : undefined
              if (target && targets.has(target)) return { content: "Each feature must target a different branch/PR. No worktrees were created." }
              if (target) targets.add(target)
            }
            if (!await queue(call.sessionID, { features })) return { content: "Feature handoff is already queued. Finish this turn without editing." }
            return { content: `${features.length} feature sessions queued. Finish this turn without editing or running implementation commands. Herdr will fork this conversation with its full history for each task and move each fork into its own worktree; this conversation stays in the primary checkout.` }
          }
          const branch = (input as { branch?: string }).branch?.trim()
          const pr = (input as { pr?: string }).pr?.trim()
          if (pr && branch) return { content: "Specify either pr or branch, not both. No worktree was created." }
          if ("pr" in (input as object) && !pr) return { content: "A pull request reference cannot be empty. No worktree was created." }
          if (branch) await execFile("git", ["check-ref-format", "--branch", branch], { cwd: session.location.directory })
          if (!await queue(call.sessionID, { branch: branch ?? "", pr: pr ?? "" })) return { content: "Feature handoff is already queued. Finish this turn without editing." }
          return { content: "Feature handoff queued. Finish this turn without editing files or running implementation commands. The Herdr pane will move this same session when the turn completes." }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session.parentID || !await eligible(session.location.directory, event.sessionID)) return
      event.system.push({ type: "text", text: "Herdr feature workflow: in this primary checkout, before implementing a feature or fix, call herdr_start_feature and end the turn without editing. When the user requests multiple independent fixes/features, pass all of them in one features array, one assignment per separate branch/session. Each session inherits the full conversation history through a fork, which is moved into its own worktree. Specify which feature each fork should implement, including local verification requirements and any requested commit/push/PR instructions. The original conversation stays here for batch starts. If the user refers to an existing PR by number or URL, pass pr with that reference; if they name an existing branch but not a PR, pass branch with its exact name. Do not guess a PR or branch from vague context; ask if ambiguous. With neither, a new feature branch is created. For a single feature without features, the same session moves; after it resumes in the worktree, implement normally. Read-only investigation and answering questions do not require a worktree. Do not call this tool for explicitly requested in-place edits. Committing and pushing are separate actions, not done by the handoff." })
    })
    return stopMaintenance
  },
})
