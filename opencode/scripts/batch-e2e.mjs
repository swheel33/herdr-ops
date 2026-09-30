import assert from "node:assert/strict"
import { execFile as callback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { register } from "node:module"
import { promisify } from "node:util"

const execFile = promisify(callback)
const base = "/tmp/opencode/herdr-batch-e2e"
await mkdir(base, { recursive: true })
const fixture = await mkdtemp(path.join(base, "fixture-"))
const receiptPath = path.join(base, `result-${Date.now()}.json`)
const receipt = { status: "running", scenarios: [] }
// Exercise both real plugins, their RPC handoff, and real Git worktrees.
// Substitute the terminal/agent host so this workflow is deterministic and offline.
const loader = path.join(fixture, "loader.mjs")
await writeFile(loader, `export async function resolve(specifier, context, next) {
  if (specifier === '@opencode/plugin/tui' || specifier === '@opencode/plugin') return { url: 'data:text/javascript,export const Plugin = { define: value => value }', shortCircuit: true }
  return next(specifier, context)
}`)
register(loader, import.meta.url)
const { default: server } = await import("../dist/index.js")
const { default: tui } = await import("../dist/tui.js")
const bin = path.join(fixture, "bin")
await mkdir(bin)
await writeFile(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require('node:fs')
const cp = require('node:child_process')
let args = process.argv.slice(2)
if (args[0] === '--session') args = args.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.BATCH_STATE, 'utf8'))
fs.appendFileSync(process.env.BATCH_COMMANDS, JSON.stringify(args)+'\\n')
const value = flag => args[args.indexOf(flag)+1]
let result
if (args[0] === 'session') { console.log(JSON.stringify({sessions:[{name:'e2e',running:true}]})); process.exit(0) }
if (args[0] === 'workspace' && args[1] === 'list') result = {workspaces:[]}
else if (args[0] === 'pane') result = {pane:{cwd:state.root,workspace_id:'primary',focused:true,agent_session:{value:'original'}}}
else if (args[0] === 'worktree' && args[1] === 'create') {
  const branch = value('--branch')
  if (branch.includes('fail')) { console.error('injected worktree failure'); process.exit(1) }
  const tree = state.root + '-' + branch.replaceAll('/', '-')
  cp.execFileSync('git', ['worktree','add','-q','-b',branch,tree,value('--base')], {cwd:state.root})
  result = {workspace:{workspace_id:branch},worktree:{path:tree},root_pane:{pane_id:branch}}
} else if (args[0] === 'worktree' && args[1] === 'list') result = {worktrees:[]}
else if (args[0] === 'agent' && args[1] === 'list') result = {agents:[{agent_session:{value:'original'}}]}
else if (args[0] === 'agent' && args[1] === 'start') {
  state.agents[args[2]] = value('--session')
  fs.writeFileSync(process.env.BATCH_STATE, JSON.stringify(state))
  result = {ok:true}
} else if (args[0] === 'agent' && args[1] === 'get') result = {agent:{agent_session:{value:state.agents[args[2]]}}}
else { console.error('Unexpected command: '+args.join(' ')); process.exit(2) }
console.log(JSON.stringify({result}))
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.HERDR_ENV = "1"
process.env.HERDR_TAB_ID = "old-tab"
delete process.env.HERDR_PANE_ID

try {
  for (const failure of [false, true]) {
    const name = failure ? "partial-failure" : "three-independent-features"
    const root = path.join(fixture, name)
    await mkdir(root)
    const git = async (...args) => (await execFile("git", args, { cwd: root })).stdout.trim()
    await git("init", "-q", "-b", "main")
    await git("-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-qm", "base")
    const commit = await git("rev-parse", "HEAD")
    process.env.BATCH_STATE = path.join(fixture, `${name}.json`)
    process.env.BATCH_COMMANDS = path.join(fixture, `${name}.jsonl`)
    await writeFile(process.env.BATCH_STATE, JSON.stringify({ root, agents: {} }))
    await writeFile(process.env.BATCH_COMMANDS, "")
    const history = ["Investigated asset caching", "ChangeText reproduction details", "SDK diagnostics findings"]
    const sessions = new Map([["original", { id: "original", title: name, location: { directory: root }, history }]])
    const storage = new Map()
    const summaries = []
    const prompts = []
    const toasts = []
    const events = new Map()
    const tools = new Map()
    let rpc, command, running
    let route = { type: "session", sessionID: "original" }
    const session = {
      get: async ({ sessionID }) => sessions.get(sessionID),
      create: async () => { throw new Error("Batch must fork history, not create an empty session") },
      fork: async ({ sessionID }) => {
        assert.equal(sessionID, "original")
        const created = { ...structuredClone(sessions.get(sessionID)), id: `session-${sessions.size}` }
        sessions.set(created.id, created)
        // A user changing conversations during setup must not redirect later tasks.
        route = { type: "home" }
        return created
      },
      update: async ({ sessionID, title }) => { sessions.get(sessionID).title = title },
      move: async ({ sessionID, directory }) => {
        assert.notEqual(sessionID, "original", "Batch must never move original session")
        sessions.get(sessionID).location.directory = directory
      },
      prompt: async (input) => prompts.push(input),
      synthetic: async (input) => summaries.push(input),
      hook: async () => {},
    }
    const stopServer = await server.setup({
      location: { directory: root }, session,
      storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value), remove: async key => storage.delete(key) },
      rpc: { register: async (_, methods) => { rpc = methods } },
      tool: { transform: async edit => edit({ add: tool => tools.set(tool.name, tool) }) },
    })
    delete process.env.HERDR_PANE_ID
    const stopTui = tui.setup({
      client: { rpc: () => rpc, session },
      data: { on: (name, handler) => { events.set(name, handler); return () => {} } },
      keymap: {
        layer: get => { command = get().commands[0] },
        dispatch: (_, input) => { running = command.run(input) },
      },
      ui: {
        router: { current: () => route, navigate: () => { throw new Error("Batch must preserve origin route") } },
        slot: ({ render }) => { render(); return () => {} },
        toast: { show: input => toasts.push(input) },
      },
    })
    process.env.HERDR_PANE_ID = "old-pane"
    try {
      const tool = tools.get("herdr_start_feature")
      const call = input => tool.execute(input, { sessionID: "original" })
      for (const invalid of [
        { features: [] },
        { features: [{ task: " " }] },
        { branch: "x", features: [{ task: "a" }] },
        { features: [{ task: "a", branch: "x", pr: "1" }] },
        { features: [{ task: "a", branch: "x" }, { task: "b", branch: "x" }] },
      ]) {
        await call(invalid)
        assert.equal(storage.size, 0, "invalid batch must not queue")
      }
      const features = [
        { branch: "feature/assets", task: "Fix missing assets. Verify locally and open a PR." },
        { branch: failure ? "feature/fail-text" : "feature/text", task: "Harden ChangeText. Reproduce locally, then open a PR." },
        { task: "Improve SDK diagnostics. Verify severity cleanup and open a PR." },
      ]
      const queued = await Promise.all([call({ features }), call({ features })])
      assert.equal(queued.filter(result => /3 feature sessions queued/.test(result.content)).length, 1)
      assert.equal(queued.filter(result => /already queued/.test(result.content)).length, 1)
      assert.match((await call({ branch: "feature/unwanted" })).content, /already queued/)
      const event = events.get("session.execution.succeeded")
      event({ data: { sessionID: "original" } })
      event({ data: { sessionID: "original" } })
      const deadline = Date.now() + 10_000
      while (!running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.ok(running, "handoff dispatched")
      await running
      const expected = failure ? 2 : 3
      assert.equal(sessions.size, expected + 1)
      assert.equal(prompts.length, expected)
      assert.equal(sessions.get("original").location.directory, root)
      assert.equal(await git("branch", "--show-current"), "main")
      assert.equal(await git("status", "--porcelain"), "")
      assert.equal(storage.size, 0)
      assert.equal(summaries.length, 1)
      assert.equal(summaries[0].sessionID, "original")
      assert.equal((summaries[0].text.match(/Started /g) ?? []).length, expected + 1)
      if (failure) assert.match(summaries[0].text, /Failed feature\/fail-text: injected worktree failure/)
      for (const [index, prompt] of prompts.entries()) {
        const task = features[failure && index === 1 ? 2 : index]
        assert.ok(prompt.text.endsWith(task.task), "task retains exact scope, verification, and PR instructions")
        assert.equal(prompt.resume, true)
        const tree = sessions.get(prompt.sessionID).location.directory
        assert.deepEqual(sessions.get(prompt.sessionID).history, history, "every fork inherits all findings")
        assert.equal((await execFile("git", ["rev-parse", "HEAD"], { cwd: tree })).stdout.trim(), commit)
      }
      const commands = (await readFile(process.env.BATCH_COMMANDS, "utf8")).trim().split("\n").map(JSON.parse)
      assert.equal(commands.filter(args => args[0] === "agent" && args[1] === "start").length, expected)
      assert.ok(!commands.some(args => args[0] === "workspace" && args[1] === "focus" || args[0] === "tab" && args[1] === "close"), "batch never steals focus or closes tabs")
      receipt.scenarios.push({ name, status: "passed", sessions: [...sessions.values()], prompts, summaries, commands, toasts })
      for (const value of [...sessions.values()].slice(1)) await git("worktree", "remove", value.location.directory)
    } finally {
      stopTui()
      stopServer()
    }
  }
  receipt.status = "passed"
} catch (error) {
  receipt.status = "failed"
  receipt.error = String(error)
  throw error
} finally {
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Batch E2E ${receipt.status}: ${receiptPath}`)
  if (receipt.status === "passed") await rm(fixture, { recursive: true })
}
