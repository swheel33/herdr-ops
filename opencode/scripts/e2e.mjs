import assert from "node:assert/strict"
import { execFile as callback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFile = promisify(callback)
const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmpRoot = "/tmp/opencode"
const receiptDirectory = path.join(tmpRoot, "herdr-feature-e2e", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`)
const receipt = { startedAt: new Date().toISOString(), pluginDirectory, scenarios: [], checks: [], cleanup: [], status: "running" }

async function command(executable, args, cwd = pluginDirectory) {
  const { stdout } = await execFile(executable, args, { cwd, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

async function json(executable, args, cwd) {
  return JSON.parse(await command(executable, args, cwd)).result
}

async function api(operation, sessionID, data, cwd) {
  const args = ["api", operation]
  if (sessionID) args.push("--param", `sessionID=${sessionID}`)
  if (data) args.push("--data", JSON.stringify(data))
  const output = await command("opencode", args, cwd)
  return output ? JSON.parse(output).data : undefined
}

async function until(label, action, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await action()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function record(check, actual) {
  receipt.checks.push({ check, actual })
  assert.ok(actual, check)
}

async function scenario(spareTab) {
  const name = spareTab ? "multiple-primary-tabs" : "last-primary-tab"
  const result = { name, resource: {}, observations: {}, status: "running" }
  receipt.scenarios.push(result)
  const resource = result.resource
  try {
    resource.repo = await mkdtemp(path.join(tmpRoot, `herdr-feature-${name}-`))
    await command("git", ["init", "-q", "-b", "main", resource.repo])
    await writeFile(path.join(resource.repo, "opencode.json"), `${JSON.stringify({ plugins: [`file://${pluginDirectory}`] })}\n`)
    await command("git", ["add", "opencode.json"], resource.repo)
    await command("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "e2e base"], resource.repo)
    resource.base = await command("git", ["rev-parse", "HEAD"], resource.repo)

    const primary = await json("herdr", ["workspace", "create", "--cwd", resource.repo, "--label", `e2e-${name}`, "--no-focus"])
    resource.primaryWorkspace = primary.workspace.workspace_id
    resource.originTab = primary.tab.tab_id
    resource.originPane = primary.root_pane.pane_id
    if (spareTab) {
      const spare = await json("herdr", ["tab", "create", "--workspace", resource.primaryWorkspace, "--cwd", resource.repo, "--label", "e2e-spare", "--no-focus"])
      resource.spareTab = spare.tab.tab_id
    }

    const session = await api("session.create", undefined, { title: `E2E ${name}`, location: { directory: resource.repo } }, resource.repo)
    resource.sessionID = session.id
    const marker = `E2E planning context ${name} ${path.basename(resource.repo)}`
    const prompt = await api("session.prompt", resource.sessionID, { text: `${marker}. Reply exactly ACK without using tools or reading files.`, resume: true }, resource.repo)
    resource.messageID = prompt.id
    await api("experimental.session.wait", resource.sessionID, undefined, resource.repo)
    await until(`${name}: marker admitted to history`, async () => {
      const messages = await api("session.message.list", resource.sessionID, undefined, resource.repo)
      return messages.some((message) => message.id === resource.messageID) && messages.some((message) => message.type === "idle" && message.outcome === "succeeded")
    })
    record(`${name}: marker message is saved before move`, true)

    const started = await json("herdr", ["agent", "start", `e2e-${spareTab ? "multi" : "single"}-${process.pid}`.slice(0, 32), "--kind", "opencode", "--pane", resource.originPane, "--timeout", "60000", "--", "--session", resource.sessionID], resource.repo)
    record(`${name}: primary pane has the session`, started.agent?.agent_session?.value === resource.sessionID)

    resource.branch = `feature/e2e-${spareTab ? "multi" : "single"}-${process.pid}`
    await api("session.prompt", resource.sessionID, {
      text: `Implement a small feature: create FEATURE.txt containing the line "${name}". Before any changes, call herdr_start_feature with branch "${resource.branch}". Once in the new worktree, complete the implementation.`,
      resume: true,
    }, resource.repo)

    const worktree = await until(`${name}: linked Herdr workspace`, async () => {
      const worktrees = await json("herdr", ["worktree", "list", "--cwd", resource.repo])
      return worktrees.worktrees.find((item) => item.branch === resource.branch && item.open_workspace_id)
    }, 120_000)
    resource.featureWorkspace = worktree.open_workspace_id
    resource.featurePath = worktree.path
    const linked = await json("herdr", ["workspace", "get", resource.featureWorkspace])
    result.observations.linkedWorkspace = linked.workspace
    record(`${name}: workspace belongs to original repository`, linked.workspace?.worktree?.repo_root === resource.repo && linked.workspace.worktree.is_linked_worktree === true)
    record(`${name}: worktree starts at the base commit`, await command("git", ["rev-parse", "HEAD"], resource.featurePath) === resource.base)

    const pane = await until(`${name}: same session attached in new pane`, async () => {
      const agents = await json("herdr", ["agent", "list"])
      return agents.agents.find((agent) => agent.workspace_id === resource.featureWorkspace && agent.agent_session?.value === resource.sessionID)
    }, 90_000)
    resource.featurePane = pane.pane_id
    result.observations.newAgent = pane
    const moved = await api("session.get", resource.sessionID, undefined, resource.repo)
    record(`${name}: original session moved into worktree`, moved.location.directory === resource.featurePath)
    const messages = await api("session.message.list", resource.sessionID, undefined, resource.repo)
    record(`${name}: planning message survived session move`, messages.some((message) => message.id === resource.messageID && message.text?.includes(marker)))
    record(`${name}: agent requested handoff with tool`, messages.some((message) => JSON.stringify(message).includes("herdr_start_feature")))
    await until(`${name}: agent implemented in worktree`, async () => {
      try { return (await readFile(path.join(resource.featurePath, "FEATURE.txt"), "utf8")).trim() === name }
      catch { return false }
    }, 120_000)
    record(`${name}: primary checkout remains untouched`, !await readFile(path.join(resource.repo, "FEATURE.txt")).then(() => true, () => false))
    await command("git", ["add", "FEATURE.txt"], resource.featurePath)
    await command("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "e2e feature"], resource.featurePath)

    const tabs = await until(`${name}: origin tab disposition`, async () => {
      const current = (await json("herdr", ["tab", "list", "--workspace", resource.primaryWorkspace])).tabs
      return current.some((tab) => tab.tab_id === resource.originTab) === !spareTab ? current : undefined
    })
    result.observations.primaryTabs = tabs
    record(`${name}: primary workspace retained`, Boolean((await json("herdr", ["workspace", "get", resource.primaryWorkspace])).workspace))
    record(`${name}: original tab ${spareTab ? "closed" : "retained"}`, tabs.some((tab) => tab.tab_id === resource.originTab) === !spareTab)
    if (spareTab) record(`${name}: spare tab retained`, tabs.some((tab) => tab.tab_id === resource.spareTab))
    else {
      const home = await until(`${name}: blank OpenCode home`, async () => {
        const screen = await command("herdr", ["pane", "read", resource.originPane, "--source", "visible", "--lines", "45"], resource.repo)
        return screen.includes("Ask anything") && !screen.includes(marker)
      })
      record(`${name}: final primary tab is blank OpenCode home`, Boolean(home))
    }
    const focused = await until(`${name}: feature workspace focused`, async () => {
      const current = await json("herdr", ["workspace", "get", resource.featureWorkspace])
      return current.workspace?.focused
    })
    record(`${name}: feature workspace focused`, focused)
    result.status = "passed"
  } catch (error) {
    result.status = "failed"
    result.error = error instanceof Error ? error.message : String(error)
    if (resource.originPane) {
      try { result.observations.originScreen = await command("herdr", ["pane", "read", resource.originPane, "--source", "visible", "--lines", "50"], resource.repo) }
      catch { /* pane might already be closed */ }
    }
    if (resource.featurePane) {
      try { result.observations.featureScreen = await command("herdr", ["pane", "read", resource.featurePane, "--source", "visible", "--lines", "60"], resource.repo) }
      catch { /* pane might already have exited */ }
    }
    if (resource.sessionID) {
      try { result.observations.messages = await api("session.message.list", resource.sessionID, undefined, resource.repo) }
      catch { /* session might not be available */ }
    }
    throw error
  } finally {
    // Never force-remove a dirty worktree; retain failed resources for inspection.
    if (resource.featurePane) {
      try { await command("herdr", ["agent", "send-keys", resource.featurePane, "ctrl+c"], resource.repo) } catch { /* agent may have exited */ }
      await until(`${name}: feature agent stopped`, async () => {
        const pane = await json("herdr", ["pane", "get", resource.featurePane])
        return !pane.pane.agent
      }).catch(() => {})
    }
    if (resource.featureWorkspace) {
      try {
        const removed = await json("herdr", ["worktree", "remove", "--workspace", resource.featureWorkspace], resource.repo)
        receipt.cleanup.push({ name, worktree: removed.path, forced: removed.forced })
      } catch (error) { receipt.cleanup.push({ name, worktreeError: String(error) }) }
    }
    if (resource.primaryWorkspace) {
      if (resource.originPane) {
        try { await command("herdr", ["agent", "send-keys", resource.originPane, "ctrl+c"], resource.repo) }
        catch { /* tab may already have closed */ }
      }
      try {
        await json("herdr", ["workspace", "close", resource.primaryWorkspace], resource.repo)
        receipt.cleanup.push({ name, primaryWorkspace: resource.primaryWorkspace })
      } catch (error) { receipt.cleanup.push({ name, workspaceError: String(error) }) }
    }
    if (resource.sessionID) {
      try {
        await api("session.remove", resource.sessionID, undefined, resource.repo)
        receipt.cleanup.push({ name, sessionID: resource.sessionID })
      } catch (error) { receipt.cleanup.push({ name, sessionError: String(error) }) }
    }
    if (resource.repo && !receipt.cleanup.some((entry) => entry.name === name && /Error/.test(JSON.stringify(entry)))) {
      // Only the directory created by mkdtemp above is removed.
      await rm(resource.repo, { recursive: true })
    }
  }
}

await mkdir(receiptDirectory, { recursive: true })
let originalWorkspace
let error
try {
  assert.equal(process.env.HERDR_ENV, "1", "Run the E2E suite from a Herdr-managed pane")
  const configPath = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode", "cli.json")
  const config = JSON.parse(await readFile(configPath, "utf8"))
  assert.ok(config.plugins?.some((entry) => typeof entry === "string" && entry.replace(/^file:\/\//, "") === pluginDirectory), `Configure ${pluginDirectory} as a CLI plugin in ${configPath}`)
  receipt.opencode = await command("opencode", ["--version"])
  receipt.herdr = await command("herdr", ["--version"])
  const workspaces = await json("herdr", ["workspace", "list"])
  originalWorkspace = workspaces.workspaces.find((workspace) => workspace.focused)?.workspace_id
  await scenario(false)
  await scenario(true)
  receipt.status = "passed"
} catch (cause) {
  error = cause
  receipt.status = "failed"
  receipt.error = cause instanceof Error ? cause.message : String(cause)
} finally {
  if (originalWorkspace) {
    try { await json("herdr", ["workspace", "focus", originalWorkspace]) }
    catch (cause) { receipt.cleanup.push({ focusError: String(cause) }) }
  }
  if (receipt.cleanup.some((entry) => Object.keys(entry).some((key) => key.endsWith("Error")))) {
    receipt.status = "failed"
    error ??= new Error("E2E cleanup failed; inspect the JSON receipt before removing retained resources")
    receipt.error ??= error.message
  }
  receipt.finishedAt = new Date().toISOString()
  await writeFile(path.join(receiptDirectory, "result.json"), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  console.log(`E2E ${receipt.status}: ${path.join(receiptDirectory, "result.json")}`)
}
if (error) throw error
