import { execFile as callback } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(callback)

async function herdr(...args: string[]): Promise<Record<string, any>> {
  const { stdout } = await execFile("herdr", args, { timeout: 10_000 })
  const result = JSON.parse(stdout).result
  if (!result) throw new Error(`Herdr returned no result for ${args.join(" ")}`)
  return result
}

export function syncTabTitles(paneID: string, getSession: (id: string) => Promise<{ title?: string; parentID?: string }>): {
  update: (sessionID?: string) => Promise<boolean>
  clear: () => Promise<void>
  dispose: () => Promise<void>
} {
  let stopped = false
  let owned: { id: string; title: string; sessionID: string } | undefined
  let queue = Promise.resolve()
  const update = (sessionID?: string): Promise<boolean> => {
    const task = queue.then(async () => {
      if (stopped) return false
      const pane = (await herdr("pane", "get", paneID)).pane
      const tabID = pane?.tab_id as string | undefined
      const actualSession = pane?.agent_session?.value as string | undefined
      if (!tabID || !actualSession || (sessionID && actualSession !== sessionID)) return false
      const session = await getSession(actualSession)
      const title = session.title?.trim()
      if (session.parentID || !title) return false
      if (owned?.id === tabID && owned.sessionID === actualSession && owned.title === title) return true
      await herdr("tab", "rename", tabID, title)
      owned = { id: tabID, title, sessionID: actualSession }
      return true
    }).catch((error) => { if (!stopped) console.error("Herdr tab title sync failed:", error); return false })
    queue = task.then(() => {})
    return task
  }
  const clear = async () => {
    await queue
    if (!owned) return
    const previous = owned
    owned = undefined
    try {
      const pane = (await herdr("pane", "get", paneID)).pane
      const tab = (await herdr("tab", "get", previous.id)).tab
      if (pane?.tab_id === previous.id && pane?.agent_session?.value === previous.sessionID && tab?.label === previous.title) {
        await herdr("tab", "rename", previous.id, "")
      }
    } catch { /* The tab may have closed already. */ }
  }
  return {
    update,
    clear,
    dispose: async () => {
      stopped = true
      await queue
      await clear()
    },
  }
}
