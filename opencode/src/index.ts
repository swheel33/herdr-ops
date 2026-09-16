import { appendFile, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

import { tool, type Plugin } from "@opencode-ai/plugin"

import { dispatchBatch, formatBatchDispatchResult } from "./batch.js"
import { HerdrDispatcher } from "./dispatch.js"
import { DispatchError } from "./errors.js"
import { RepositoryMaintenance } from "./maintenance.js"
import { NodeCommandRunner } from "./process.js"
import { HerdrTabTitleSynchronizer } from "./tab-titles.js"
import { isLinkedWorktree, resolveRepository } from "./validation.js"
import {
  configureFeatureWorkflow,
  FeatureAuthorization,
  resolveWorkflowModels,
  IMPLEMENTOR_AGENT,
  IMPLEMENTOR_PROMPT,
  ORCHESTRATOR_PROMPT,
} from "./workflow.js"

const dispatchFeatureSchema = {
  id: tool.schema
    .string()
    .min(1)
    .max(20)
    .describe("Stable selection ID from the confirmation list, such as F1"),
  mode: tool.schema
    .enum(["new", "continue", "branch_from"])
    .describe("Resolved Git intent"),
  title: tool.schema
    .string()
    .max(80)
    .describe("Short human-readable feature title shown in the Herdr sidebar"),
  branch: tool.schema.string().describe("Local Git branch for this feature"),
  plan: tool.schema
    .string()
    .describe(
      "Reused implementation-ready plan or the smallest sufficient handoff for this feature only",
    ),
  source: tool.schema
    .string()
    .optional()
    .describe("Existing local or remote-tracking branch for continue or branch_from"),
  base: tool.schema
    .string()
    .optional()
    .describe(
      "Explicit Git base ref for a new feature; when omitted, freshly fetches and pins origin's default branch",
    ),
}

const HerdrDispatchPlugin: Plugin = async ({ client, directory }, options = {}) => {
  const models = resolveWorkflowModels(options)
  // Capture mode exercises the same command, model, schema, and authorization path
  // without maintenance, repository mutations, or starting an implementation agent.
  const captureOnly = options.captureOnly === true
  const authorization = new FeatureAuthorization()
  const runner = new NodeCommandRunner()
  const logger = (level: "debug" | "info" | "warn" | "error", message: string, metadata?: Record<string, unknown>) => {
    void client.app
      .log({
        body: {
          service: "opencode-herdr-dispatch",
          level,
          message,
          ...(metadata ? { extra: metadata } : {}),
        },
      })
      .catch(() => {})
  }
  const titleSynchronizer = new HerdrTabTitleSynchronizer(runner, directory, logger)
  const linkedWorktree = await isLinkedWorktree(runner, directory, realpath)
  if (linkedWorktree) {
    return {
      config: async (config) => configureFeatureWorkflow(config, true, models),
      "experimental.chat.system.transform": async (_input, output) => {
        output.system.push(`${IMPLEMENTOR_PROMPT}\nAssigned working directory: ${directory}`)
      },
      "chat.message": async (input, output) => {
        if (input.agent !== IMPLEMENTOR_AGENT) return
        if (output.parts.some((part) => part.type === "text" && part.text.startsWith("Herdr implementation assignment — workspace setup is COMPLETE."))) {
          Object.assign(output.message, { variant: models.implementor.variant })
        }
      },
      event: async ({ event }) => titleSynchronizer.handle(event),
      dispose: async () => titleSynchronizer.dispose(),
    }
  }

  const dispatcher = new HerdrDispatcher({ runner, realpath, logger }, models.implementor.model)
  let maintenance: RepositoryMaintenance | undefined
  try {
    const repository = await resolveRepository(runner, directory, realpath)
    maintenance = new RepositoryMaintenance(runner, repository.root, repository.commonDir, logger)
    if (!captureOnly) maintenance.start()
  } catch (error) {
    logger("debug", "Repository maintenance is unavailable outside a primary Git checkout", {
      directory,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      output.system.push(ORCHESTRATOR_PROMPT)
      output.system.push(input.sessionID && authorization.isActive(input.sessionID)
        ? "Dispatch authorization is ACTIVE for the current /feature invocation. Use its token once."
        : "Dispatch authorization is INACTIVE. Any /feature tokens in conversation history are expired. Continue planning only. If dispatch is desired, ask the user to run /feature again before asking for dirty-checkout approval or calling the dispatch tool. A scope correction, ordinary approval, or 'continue' message does not renew authorization.")
    },
    event: async ({ event }) => {
      if (event.type === "session.idle" || event.type === "session.error" || event.type === "session.deleted") {
        const properties = event.properties as { sessionID?: string; info?: { id: string } }
        const sessionID = properties.sessionID ?? properties.info?.id
        if (sessionID) authorization.clear(sessionID)
      }
      await titleSynchronizer.handle(event)
    },
    dispose: async () => {
      await Promise.all([
        titleSynchronizer.dispose(),
        maintenance?.dispose() ?? Promise.resolve(),
      ])
    },
    config: async (config) => {
      configureFeatureWorkflow(config, false, models)
    },
    "chat.message": async (input, output) => {
      authorization.bind(input.sessionID, output.message.id,
        output.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"))
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "feature") return

      const response = await client.session.messages({
        path: { id: input.sessionID },
        query: { directory },
      })
      if (!response.data) {
        throw new DispatchError(
          `Could not load parent-thread context for /feature: ${JSON.stringify(response.error)}`,
        )
      }

      const token = authorization.issue(input.sessionID, response.data.map((message) => message.info.id))
      output.parts.push({ type: "text", text: authorization.marker(token) } as typeof output.parts[number])
    },
    tool: {
      inspect_herdr_repository: tool({
        description:
          "Read the Git state needed to plan Herdr feature dispatches. Returns status, local and remote branches, remotes, and recent commits without changing the repository.",
        args: {},
        async execute(_args, context) {
          if (captureOnly && typeof options.repositorySnapshot === "string") {
            return options.repositorySnapshot
          }

          const commands = [
            ["status", "--short", "--branch"],
            ["branch", "--all", "--no-color"],
            ["remote", "-v"],
            ["log", "-20", "--oneline", "--decorate"],
          ] as const
          const [status, branches, remotes, log] = await Promise.all(
            commands.map((args) =>
              runner.run({
                executable: "git",
                args,
                cwd: context.directory,
                signal: context.abort,
              }),
            ),
          )
          return [
            "Git status:",
            status?.stdout.trim() || "<clean>",
            "",
            "Branches:",
            branches?.stdout.trim() || "<none>",
            "",
            "Remotes:",
            remotes?.stdout.trim() || "<none>",
            "",
            "Recent commits:",
            log?.stdout.trim() || "<none>",
          ].join("\n")
        },
      }),
      dispatch_features_to_herdr: tool({
        description:
          "Dispatch the agreed plan once after /feature authorization. Each feature creates a separate worktree. Ordinary conversation cannot authorize this tool.",
        args: {
          authorization: tool.schema.string().describe("Exact feature_authorization token from the current /feature invocation"),
          features: tool.schema
            .array(tool.schema.object(dispatchFeatureSchema))
            .min(1)
            .max(8)
            .describe("The confirmed features, in the same order shown to the user"),
          allowDirtyRoot: tool.schema
            .boolean()
            .optional()
            .describe(
              "Explicitly allow all selected dispatches when the primary checkout has uncommitted files",
            ),
        },
        async execute(args, context) {
          const messages = await client.session.messages({ path: { id: context.sessionID }, query: { directory } })
          if (!messages.data) throw new DispatchError("Cannot verify current dispatch authorization.")
          const latestUser = [...messages.data].reverse().find((message) => message.info.role === "user")
          const sourceMessageIDs = authorization.consume(context.sessionID, args.authorization, latestUser?.info.id ?? "")

          const input = {
            features: args.features.map((feature) => ({
              id: feature.id,
              mode: feature.mode,
              title: feature.title,
              branch: feature.branch,
              plan: feature.plan,
              ...(feature.source === undefined ? {} : { source: feature.source }),
              ...(feature.base === undefined ? {} : { base: feature.base }),
            })),
            ...(args.allowDirtyRoot === undefined
              ? {}
              : { allowDirtyRoot: args.allowDirtyRoot }),
          }
          if (captureOnly) {
            return JSON.stringify({ captured: true, sessionID: context.sessionID, sourceMessageIDs, input })
          }
          const repository = await resolveRepository(runner, context.directory, realpath, context.abort)
          const receiptDirectory = path.join(repository.commonDir, "opencode-herdr-dispatch")
          await mkdir(receiptDirectory, { recursive: true })
          const receiptPath = path.join(receiptDirectory, "handoffs.jsonl")
          const receiptID = args.authorization
          await appendFile(receiptPath, JSON.stringify({ id: receiptID, state: "requested", time: new Date().toISOString(), sessionID: context.sessionID, sourceMessageIDs, input }) + "\n", { mode: 0o600 })
          const result = await dispatchBatch(
              dispatcher,
              runner,
              context.directory,
              input,
              context.abort,
            )
          try {
            await appendFile(receiptPath, JSON.stringify({ id: receiptID, state: "result", time: new Date().toISOString(), result }) + "\n", { mode: 0o600 })
          } catch (error) {
            return `${formatBatchDispatchResult(result)}\nDispatch receipt: ${receiptID}\nResult recording failed: ${String(error)}. Inspect the reported agents before retrying.`
          }
          return `${formatBatchDispatchResult(result)}\nDispatch receipt: ${receiptID}`
        },
      }),
    },
  }
}

export default HerdrDispatchPlugin
