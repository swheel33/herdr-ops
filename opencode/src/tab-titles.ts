import { setTimeout as delay } from "node:timers/promises"

import type { Event } from "@opencode-ai/sdk"

import type { CommandRunner, DispatchLogger } from "./types.js"

const TITLE_SYNC_RETRY_DELAYS_MS = [0, 100, 400, 1_000] as const

interface HerdrAgent {
  agent_session?: { value?: unknown }
  tab_id?: unknown
}

interface HerdrTab {
  label?: unknown
}

function parseSessionTab(stdout: string, sessionID: string): string | undefined {
  const parsed = JSON.parse(stdout) as { result?: { agents?: unknown } }
  if (!Array.isArray(parsed.result?.agents)) return undefined

  return parsed.result.agents
    .map((agent) => agent as HerdrAgent)
    .find((agent) => agent.agent_session?.value === sessionID && typeof agent.tab_id === "string")
    ?.tab_id as string | undefined
}

function parseTabLabel(stdout: string): string | undefined {
  const parsed = JSON.parse(stdout) as { result?: { tab?: HerdrTab } }
  return typeof parsed.result?.tab?.label === "string" ? parsed.result.tab.label : undefined
}

export class HerdrTabTitleSynchronizer {
  private readonly controller = new AbortController()
  private readonly operations = new Set<Promise<void>>()
  private readonly latestTitles = new Map<string, string>()
  private readonly titles = new Map<string, string>()
  private readonly tabTitles = new Map<string, string>()
  private queue = Promise.resolve()

  constructor(
    private readonly runner: CommandRunner,
    private readonly cwd: string,
    private readonly logger?: DispatchLogger,
  ) {}

  async handle(event: Event): Promise<void> {
    if (event.type !== "session.created" && event.type !== "session.updated") return
    const session = event.properties.info
    const title = session.title.trim()
    if (session.parentID || !title || this.titles.get(session.id) === title) return
    this.latestTitles.set(session.id, title)

    const operation = this.queue.then(() => this.synchronize(session.id, title))
    this.queue = operation.catch(() => {})
    this.operations.add(operation)
    try {
      await operation
    } finally {
      this.operations.delete(operation)
    }
  }

  private async synchronize(sessionID: string, title: string): Promise<void> {
    for (const retryDelay of TITLE_SYNC_RETRY_DELAYS_MS) {
      if (this.controller.signal.aborted || this.latestTitles.get(sessionID) !== title) return
      if (retryDelay > 0) {
        try {
          await delay(retryDelay, undefined, { signal: this.controller.signal })
        } catch {
          return
        }
      }
      if (this.latestTitles.get(sessionID) !== title) return

      try {
        const agents = await this.runner.run({
          executable: "herdr",
          args: ["agent", "list"],
          cwd: this.cwd,
          signal: this.controller.signal,
        })
        const tabID = parseSessionTab(agents.stdout, sessionID)
        if (!tabID) continue
        if (this.latestTitles.get(sessionID) !== title) return

        await this.runner.run({
          executable: "herdr",
          args: ["tab", "rename", tabID, title],
          cwd: this.cwd,
          signal: this.controller.signal,
        })
        this.tabTitles.set(tabID, title)
        if (this.latestTitles.get(sessionID) !== title) return
        this.titles.set(sessionID, title)
        this.logger?.("debug", "Herdr tab renamed from OpenCode session", {
          sessionID,
          tabID,
          title,
        })
        return
      } catch (error) {
        if (this.controller.signal.aborted) return
        this.logger?.("warn", "Could not synchronize the OpenCode session title to Herdr", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }
  }

  async dispose(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled(this.operations)

    await Promise.all([...this.tabTitles].map(async ([tabID, title]) => {
      try {
        const tab = await this.runner.run({
          executable: "herdr",
          args: ["tab", "get", tabID],
          cwd: this.cwd,
        })
        if (parseTabLabel(tab.stdout) !== title) return

        await this.runner.run({
          executable: "herdr",
          args: ["tab", "rename", tabID, ""],
          cwd: this.cwd,
        })
        this.logger?.("debug", "Cleared the OpenCode session title from Herdr", {
          tabID,
          title,
        })
      } catch (error) {
        this.logger?.("debug", "Could not clear the OpenCode session title from Herdr", {
          tabID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }))
  }
}
