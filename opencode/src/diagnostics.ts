import { appendFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"

// Keep diagnostics independent of the RPC transport, including errors raised
// after the server handler returns (for example output validation failures).
export function diagnostic(event: string, fields: Record<string, unknown> = {}, error?: unknown): void {
  try {
    const directory = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "herdr")
    mkdirSync(directory, { recursive: true })
    appendFileSync(path.join(directory, "feature-handoff.jsonl"), JSON.stringify({
      time: new Date().toISOString(), pid: process.pid, event, ...fields,
      ...(error === undefined ? {} : { error: inspect(error, { depth: 5, customInspect: false, getters: false }).slice(0, 16000) }),
    }) + "\n", { mode: 0o600 })
  } catch {
    // A diagnostic failure must not change handoff behavior.
  }
}
