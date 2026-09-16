import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { createOpencode } from "@opencode-ai/sdk"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

const execFile = promisify(execFileCallback)
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 10 * 60_000)
const model = process.env.E2E_MODEL
const activeFixtures = new Set()

async function run(executable, args, cwd) {
  const result = await execFile(executable, args, { cwd, maxBuffer: 10 * 1024 * 1024 })
  return result.stdout
}

function unwrap(response, label) {
  if (response.error) throw new Error(`${label}: ${JSON.stringify(response.error)}`)
  return response.data
}

async function withTimeout(promise, label, duration = timeoutMs, onTimeout) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          Promise.resolve(onTimeout?.())
            .catch(() => undefined)
            .finally(() => reject(new Error(`${label} timed out`)))
        }, duration)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-herdr-e2e-"))
  const origin = `${root}-origin.git`
  const publisher = await mkdtemp(path.join(tmpdir(), "opencode-herdr-e2e-publisher-"))
  try {
    await mkdir(path.join(root, "src"))
    await run("git", ["init", "-b", "trunk"], root)
    await run("git", ["config", "user.name", "Herdr E2E"], root)
    await run("git", ["config", "user.email", "herdr-e2e@example.invalid"], root)
    await run("git", ["init", "--bare", origin], root)
    await run("git", ["symbolic-ref", "HEAD", "refs/heads/trunk"], origin)
    await run("git", ["remote", "add", "origin", origin], root)
    await writeFile(path.join(root, ".gitignore"), ".env*\n")
    await writeFile(path.join(root, ".env.local"), "E2E_SECRET=fixture\n")
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "herdr-e2e-fixture", private: true }, null, 2)}\n`)
    await writeFile(path.join(root, "AGENTS.md"), "Keep implementations direct. Use only verification relevant to the changed behavior.\n")
    await writeFile(path.join(root, "src", "server.js"), "export function handleRequest(pathname) { return pathname === '/' ? 'ok' : 'not found' }\n")
    await run("git", ["add", "."], root)
    await run("git", ["commit", "-m", "Initial fixture"], root)
    await run("git", ["push", "-u", "origin", "trunk"], root)
    await run("git", ["clone", origin, "."], publisher)
    await run("git", ["config", "user.name", "Herdr E2E Publisher"], publisher)
    await run("git", ["config", "user.email", "publisher@example.invalid"], publisher)
    await writeFile(path.join(publisher, "REMOTE-ONLY.md"), "fresh origin commit\n")
    await run("git", ["add", "REMOTE-ONLY.md"], publisher)
    await run("git", ["commit", "-m", "Advance origin"], publisher)
    await run("git", ["push", "origin", "trunk"], publisher)
    const remoteCommit = (await run("git", ["rev-parse", "HEAD"], publisher)).trim()
    await rm(publisher, { recursive: true, force: true })
    return { root, origin, remoteCommit }
  } catch (error) {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(origin, { recursive: true, force: true }),
      rm(publisher, { recursive: true, force: true }),
    ])
    throw error
  }
}

async function rootFingerprint(root) {
  const [branch, commit, status, source] = await Promise.all([
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
    run("git", ["rev-parse", "--verify", "HEAD"], root),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root),
    run("git", ["hash-object", "src/server.js"], root),
  ])
  return { branch, commit, status, source }
}

async function listLinkedWorktrees(root) {
  const output = JSON.parse(await run("herdr", ["worktree", "list", "--cwd", root], root))
  const worktrees = output.result?.worktrees
  assert.ok(Array.isArray(worktrees), "Herdr worktree list must include worktrees")
  const canonicalRoot = await realpath(root)
  return worktrees.filter((worktree) => path.resolve(worktree.path) !== canonicalRoot)
}

async function listE2EWorkspaces() {
  const output = JSON.parse(await run("herdr", ["workspace", "list"], process.cwd()))
  const workspaces = output.result?.workspaces
  if (!Array.isArray(workspaces)) throw new Error("Herdr workspace list must include workspaces")
  return workspaces.filter((workspace) => {
    const label = workspace.label
    const repoName = workspace.worktree?.repo_name
    return [label, repoName].some((value) => typeof value === "string" && value.startsWith("opencode-herdr-e2e-"))
  })
}

async function closeE2EWorkspace(workspace) {
  if (workspace.worktree?.is_linked_worktree === true) {
    await run("herdr", ["worktree", "remove", "--workspace", workspace.workspace_id, "--force"], process.cwd())
    return
  }
  await run("herdr", ["workspace", "close", workspace.workspace_id], process.cwd())
}

async function cleanupE2EWorkspaces(predicate = () => true) {
  let workspaces
  try {
    workspaces = await listE2EWorkspaces()
  } catch {
    return
  }
  for (const workspace of workspaces.filter(predicate)) {
    try {
      await closeE2EWorkspace(workspace)
    } catch {
      // Cleanup must not hide the E2E failure.
    }
  }
}

async function waitFor(label, callback, duration = timeoutMs) {
  const deadline = Date.now() + duration
  while (Date.now() < deadline) {
    const result = await callback()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label} timed out`)
}

async function assertWorkspace(worktree, root) {
  assert.equal(typeof worktree.open_workspace_id, "string", "worktree must be open in Herdr")
  const workspaceID = worktree.open_workspace_id
  const panes = JSON.parse(await run("herdr", ["pane", "list", "--workspace", workspaceID], root)).result?.panes
  assert.ok(Array.isArray(panes) && panes.length === 2, "dispatch must create agent and shell panes")
  const layout = JSON.parse(await run("herdr", ["pane", "layout", "--pane", panes[0].pane_id], root)).result?.layout
  assert.equal(layout?.splits?.length, 1, "dispatch must create one pane split")
  assert.equal(layout.splits[0].direction, "down", "agent and shell panes must be top/bottom")
  assert.ok(Math.abs(layout.splits[0].ratio - 0.7) <= 0.02, "agent pane must use 70%")
  const agent = await waitFor("Build agent registration", async () => {
    const agents = JSON.parse(await run("herdr", ["agent", "list"], root)).result?.agents
    if (!Array.isArray(agents)) return undefined
    return agents.find((entry) => entry.pane_id === panes[0].pane_id && entry.agent_session?.value)
  })
  return agent
}

async function cleanupFixture(fixture) {
  if (fixture.cleanupPromise) return fixture.cleanupPromise
  fixture.cleanupPromise = (async () => {
    try {
      for (const worktree of await listLinkedWorktrees(fixture.root)) {
        if (typeof worktree.open_workspace_id === "string") {
          await run("herdr", ["worktree", "remove", "--workspace", worktree.open_workspace_id, "--force"], fixture.root)
        } else {
          await run("git", ["worktree", "remove", "--force", worktree.path], fixture.root)
        }
      }
    } catch {
      // The workspace sweep below handles fixtures whose root has already disappeared.
    }
    await cleanupE2EWorkspaces((workspace) => workspace.worktree?.repo_root === fixture.root)
    await rm(fixture.root, { recursive: true, force: true })
    await rm(fixture.origin, { recursive: true, force: true })
  })()
  return fixture.cleanupPromise
}

async function promptPlan(client, sessionID, root) {
  const response = await withTimeout(client.session.prompt({
    sessionID,
    directory: root,
    agent: "plan",
    parts: [{
      type: "text",
      text: "Produce a concise implementation-ready plan, not code, for one account display-name outcome. Preserve this literal decision: PLAN_DECISION_DIRECT_HANDLER means change the existing server handler directly. Include the browser form and validation in the same outcome. Do not add documentation or broad verification.",
    }],
  }), "parent planning response")
  return unwrap(response, "parent planning response")
}

async function runCohesiveWorkflow(client) {
  await cleanupE2EWorkspaces()
  const fixture = await createFixture()
  activeFixtures.add(fixture)
  let sessionID
  try {
    const before = await rootFingerprint(fixture.root)
    sessionID = unwrap(await client.session.create({ directory: fixture.root, title: "Herdr E2E feature" }), "create session").id
    await promptPlan(client, sessionID, fixture.root)
    const response = await withTimeout(client.session.command({
      sessionID,
      directory: fixture.root,
      command: "feature",
      arguments: "",
      ...(model ? { model } : {}),
    }), "real /feature command", timeoutMs, () => client.session.abort({ sessionID, directory: fixture.root }))
    const commandResult = unwrap(response, "real /feature command")
    const commandText = typeof commandResult === "string" ? commandResult : JSON.stringify(commandResult)
    if (!/Dispatched.* to Herdr/u.test(commandText)) {
      const receiptPath = path.join(fixture.root, ".git", "opencode-herdr-dispatch", "handoffs.jsonl")
      const receipt = await readFile(receiptPath, "utf8").catch(() => "<no receipt>")
      assert.fail(`the command must report confirmed dispatch\n${commandText}\n${receipt}`)
    }

    const worktrees = await waitFor("one cohesive Herdr dispatch", async () => {
      const current = await listLinkedWorktrees(fixture.root)
      return current.length === 1 ? current : undefined
    })
    const agent = await assertWorkspace(worktrees[0], fixture.root)
    const envLink = path.join(worktrees[0].path, ".env.local")
    assert.equal((await lstat(envLink)).isSymbolicLink(), true, "worktree environment file must be a symlink")
    assert.equal(await realpath(envLink), await realpath(path.join(fixture.root, ".env.local")), "worktree environment file must point to the primary checkout")
    await readFile(path.join(worktrees[0].path, "pnpm-lock.yaml"), "utf8")
    const fetched = (await run("git", ["rev-parse", "refs/remotes/origin/trunk"], fixture.root)).trim()
    assert.equal(fetched, fixture.remoteCommit, "dispatch must freshly fetch origin/trunk")
    assert.equal((await run("git", ["merge-base", fixture.remoteCommit, "HEAD"], worktrees[0].path)).trim(), fixture.remoteCommit, "feature branch must contain fresh origin commit")
    assert.deepEqual(await rootFingerprint(fixture.root), before, "dispatch must not change the primary checkout")
    const messages = unwrap(await client.session.messages({ sessionID: agent.agent_session.value, directory: worktrees[0].path }), "read Build agent messages")
    const deliveredPlan = JSON.stringify(messages)
    assert.match(deliveredPlan, /PLAN_DECISION_DIRECT_HANDLER/u, "Build agent must receive the agreed plan")
    const receipt = await readFile(path.join(fixture.root, ".git", "opencode-herdr-dispatch", "handoffs.jsonl"), "utf8")
    assert.match(receipt, /"state":"completed"/u, "dispatch receipt must record completion")
    process.stdout.write("PASS one real feature was dispatched and confirmed\n")
  } finally {
    if (sessionID) await client.session.delete({ sessionID, directory: fixture.root }).catch(() => undefined)
    await cleanupFixture(fixture)
    activeFixtures.delete(fixture)
  }
}

const controller = new AbortController()
let server
let shutdownPromise

async function shutdown() {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    controller.abort()
    server?.close()
    await Promise.all([...activeFixtures].map((fixture) => cleanupFixture(fixture)))
    await cleanupE2EWorkspaces()
  })()
  return shutdownPromise
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown().finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143
    })
  })
}

await cleanupE2EWorkspaces()
const created = await createOpencode({ signal: controller.signal, timeout: 30_000 })
server = created.server
const client = createOpencodeClient({ baseUrl: server.url })
try {
  const commands = unwrap(await client.command.list(), "list OpenCode commands")
  assert.ok(commands.some((command) => command.name === "feature"), "plugin must register /feature")
  await runCohesiveWorkflow(client)
} finally {
  await shutdown()
}
