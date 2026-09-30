import assert from "node:assert/strict"
import { execFile as callback } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFile = promisify(callback)
const base = "/tmp/opencode/herdr-fork-e2e"
await mkdir(base, { recursive: true })
const root = await mkdtemp(path.join(base, "repo-"))
const receiptPath = path.join(base, `result-${Date.now()}.json`)
const receipt = { status: "running", root, sessions: [], checks: [] }
async function command(executable, args, cwd = root) {
  return (await execFile(executable, args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
}
async function api(operation, sessionID, data) {
  const args = ["api", operation]
  if (sessionID) args.push("--param", `sessionID=${sessionID}`)
  if (data) args.push("--data", JSON.stringify(data))
  const output = await command("opencode", args)
  return output ? JSON.parse(output).data : undefined
}
try {
  await command("git", ["init", "-q", "-b", "main"])
  await command("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-qm", "base"])
  const original = await api("session.create", undefined, { title: "Herdr full-context fork E2E", location: { directory: root } })
  receipt.sessions.push(original.id)
  // Real OpenCode history; no model invocation is needed to verify copying it.
  const markers = ["Asset routing finding: cache key includes path", "ChangeText finding: transaction panel reproduction", "SDK finding: severity must remain consistent"]
  for (const text of markers) await api("session.synthetic", original.id, { text })
  const source = await api("session.message.list", original.id)
  for (const marker of markers) assert.ok(JSON.stringify(source).includes(marker), "source history admitted")
  for (let index = 0; index < 3; index++) {
    const branch = `feature/context-${index + 1}`
    const tree = path.join(root, `../${path.basename(root)}-${index + 1}`)
    await command("git", ["worktree", "add", "-q", "-b", branch, tree])
    const fork = await api("session.fork", original.id, {})
    receipt.sessions.push(fork.id)
    await api("session.update", fork.id, { title: `Feature ${index + 1}` })
    await api("session.move", fork.id, { directory: tree })
    const deadline = Date.now() + 30_000
    let moved
    do {
      moved = await api("session.get", fork.id)
      if (moved.location.directory === tree) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    assert.equal(moved.location.directory, tree)
    const messages = await api("session.message.list", fork.id)
    for (const marker of markers) assert.ok(JSON.stringify(messages).includes(marker), "full history survived fork and move")
    const context = await api("session.context", fork.id)
    for (const marker of markers) assert.ok(JSON.stringify(context).includes(marker), "inherited findings are available in model context")
    await api("session.synthetic", fork.id, { text: `Assigned only feature ${index + 1}` })
    receipt.checks.push({ branch, tree, sessionID: fork.id, inheritedMarkers: markers, history: messages })
    await command("git", ["worktree", "remove", tree])
  }
  assert.equal((await api("session.get", original.id)).location.directory, root)
  assert.ok(!JSON.stringify(await api("session.message.list", original.id)).includes("Assigned only feature"))
  assert.equal(new Set(receipt.sessions).size, 4)
  receipt.status = "passed"
} catch (error) {
  receipt.status = "failed"
  receipt.error = String(error)
  throw error
} finally {
  for (const sessionID of receipt.sessions.toReversed()) {
    try { await api("session.remove", sessionID) }
    catch (error) { (receipt.cleanupErrors ??= []).push(String(error)) }
  }
  if (receipt.status === "passed" && !receipt.cleanupErrors) await rm(root, { recursive: true })
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Fork E2E ${receipt.status}: ${receiptPath}`)
}
