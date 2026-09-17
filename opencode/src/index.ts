import { appendFile, mkdir, realpath } from "node:fs/promises"
import path from "node:path"

import { tool, type Plugin } from "@opencode-ai/plugin"

import { HerdrDispatcher, formatDispatchResult } from "./dispatch.js"
import { DispatchError } from "./errors.js"
import { RepositoryMaintenance } from "./maintenance.js"
import { NodeCommandRunner } from "./process.js"
import { HerdrTabTitleSynchronizer } from "./tab-titles.js"
import { isLinkedWorktree, resolveRepository } from "./validation.js"
import {
  configureFeatureWorkflow,
  FeatureAuthorization,
  IMPLEMENTOR_AGENT,
  IMPLEMENTOR_PROMPT,
  IMPLEMENTOR_VARIANT,
} from "./workflow.js"

const HerdrDispatchPlugin: Plugin = async ({ client, directory }) => {
  const authorization = new FeatureAuthorization()
  const sessionModels = new Map<string, string>()
  let configuredModel: string | undefined
  const runner = new NodeCommandRunner()
  const logger = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ) => {
    void client.app.log({
      body: {
        service: "opencode-herdr-dispatch",
        level,
        message,
        ...(metadata ? { extra: metadata } : {}),
      },
    }).catch(() => {})
  }

  const titleSynchronizer = new HerdrTabTitleSynchronizer(runner, directory, logger)
  const linkedWorktree = await isLinkedWorktree(runner, directory, realpath)
  if (linkedWorktree) {
    return {
      config: async (config) => configureFeatureWorkflow(config, true),
      "experimental.chat.system.transform": async (_input, output) => {
        output.system.push(`${IMPLEMENTOR_PROMPT}\nAssigned working directory: ${directory}`)
      },
      "chat.message": async (input, output) => {
        if (input.agent === IMPLEMENTOR_AGENT && output.parts.some(
          (part) => part.type === "text" && part.text.startsWith("Herdr implementation assignment:"),
        )) {
          Object.assign(output.message, { variant: IMPLEMENTOR_VARIANT })
        }
      },
      event: async ({ event }) => titleSynchronizer.handle(event),
      dispose: async () => titleSynchronizer.dispose(),
    }
  }

  const dispatcher = new HerdrDispatcher({ runner, realpath, logger })
  let maintenance: RepositoryMaintenance | undefined
  try {
    const repository = await resolveRepository(runner, directory, realpath)
    maintenance = new RepositoryMaintenance(runner, repository.root, repository.commonDir, logger)
    maintenance.start()
  } catch (error) {
    logger("debug", "Repository maintenance is unavailable outside a primary Git checkout", {
      directory,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle" || event.type === "session.error" || event.type === "session.deleted") {
        const properties = event.properties as { sessionID?: string; info?: { id: string } }
        const sessionID = properties.sessionID ?? properties.info?.id
        if (sessionID) {
          authorization.clear(sessionID)
          sessionModels.delete(sessionID)
        }
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
      configuredModel = config.model
      configureFeatureWorkflow(config, false)
    },
    "chat.message": async (input, output) => {
      if (input.model) sessionModels.set(input.sessionID, `${input.model.providerID}/${input.model.modelID}`)
      authorization.bind(
        input.sessionID,
        output.message.id,
        output.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      )
    },
    "command.execute.before": async (input, output) => {
      if (input.command !== "feature") return
      const response = await client.session.messages({ path: { id: input.sessionID }, query: { directory } })
      if (!response.data) throw new DispatchError(`Could not load parent-thread context for /feature: ${JSON.stringify(response.error)}`)
      const token = authorization.issue(input.sessionID, response.data.map((message) => message.info.id))
      output.parts.push({ type: "text", text: authorization.marker(token) } as typeof output.parts[number])
    },
    tool: {
      inspect_herdr_repository: tool({
        description: "Read the Git state needed to plan a Herdr feature dispatch without changing the repository.",
        args: {},
        async execute(_args, context) {
          const commands = [
            ["status", "--short", "--branch"],
            ["branch", "--all", "--no-color"],
            ["remote", "-v"],
            ["log", "-20", "--oneline", "--decorate"],
          ] as const
          const outputs = await Promise.all(commands.map((args) => runner.run({ executable: "git", args, cwd: context.directory, signal: context.abort })))
          const status = outputs[0]!
          const branches = outputs[1]!
          const remotes = outputs[2]!
          const log = outputs[3]!
          return [
            "Git status:", status.stdout.trim() || "<clean>", "",
            "Branches:", branches.stdout.trim() || "<none>", "",
            "Remotes:", remotes.stdout.trim() || "<none>", "",
            "Recent commits:", log.stdout.trim() || "<none>",
          ].join("\n")
        },
      }),
      dispatch_feature_to_herdr: tool({
        description: "Dispatch one agreed implementation plan to one new Herdr worktree after /feature authorization.",
        args: {
          authorization: tool.schema.string().describe("Exact feature_authorization token from the current /feature invocation"),
          title: tool.schema.string().min(1).max(80).describe("Short feature title"),
          branch: tool.schema.string().describe("New local Git branch for this feature"),
          plan: tool.schema.string().describe("The implementation-ready handoff for this feature"),
          base: tool.schema.string().optional().describe("Optional explicit Git base ref; defaults to freshly fetched origin HEAD"),
          allowDirtyRoot: tool.schema.boolean().optional().describe("Explicitly allow dispatch when the primary checkout is dirty"),
        },
        async execute(args, context) {
          const messages = await client.session.messages({ path: { id: context.sessionID }, query: { directory } })
          if (!messages.data) throw new DispatchError("Cannot verify current dispatch authorization.")
          const latestUser = [...messages.data].reverse().find((message) => message.info.role === "user")
          authorization.consume(context.sessionID, args.authorization, latestUser?.info.id ?? "")

          const implementationModel = sessionModels.get(context.sessionID) ?? configuredModel
          if (!implementationModel) {
            throw new DispatchError("Could not determine the active orchestrator model for this dispatch.")
          }

          const repository = await resolveRepository(runner, context.directory, realpath, context.abort)
          const receiptDirectory = path.join(repository.commonDir, "opencode-herdr-dispatch")
          const receiptPath = path.join(receiptDirectory, "handoffs.jsonl")
          await mkdir(receiptDirectory, { recursive: true })
          const receiptID = args.authorization
          const input = {
            title: args.title,
            branch: args.branch,
            plan: args.plan,
            ...(args.base === undefined ? {} : { base: args.base }),
            ...(args.allowDirtyRoot === undefined ? {} : { allowDirtyRoot: args.allowDirtyRoot }),
          }
          await appendFile(receiptPath, `${JSON.stringify({ id: receiptID, state: "requested", time: new Date().toISOString(), sessionID: context.sessionID, input })}\n`, { mode: 0o600 })
          try {
            const result = await dispatcher.dispatch(context.directory, input, implementationModel, context.abort)
            await appendFile(receiptPath, `${JSON.stringify({ id: receiptID, state: "completed", time: new Date().toISOString(), result })}\n`, { mode: 0o600 })
            return `${formatDispatchResult(result)}\nDispatch receipt: ${receiptID}`
          } catch (error) {
            const dispatchError = error instanceof DispatchError ? error : new DispatchError(String(error))
            await appendFile(receiptPath, `${JSON.stringify({ id: receiptID, state: "failed", time: new Date().toISOString(), error: dispatchError.message, partial: dispatchError.partial })}\n`, { mode: 0o600 })
            const partial = dispatchError.partial ? `\nPartial resources: ${JSON.stringify(dispatchError.partial)}` : ""
            return `Dispatch failed.\n${dispatchError.message}${partial}\nDispatch receipt: ${receiptID}`
          }
        },
      }),
    },
  }
}

export default HerdrDispatchPlugin
