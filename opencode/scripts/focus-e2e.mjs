import assert from "node:assert/strict"
import { execFile as callback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { register } from "node:module"
import { promisify } from "node:util"

const execFile = promisify(callback)
const base = "/tmp/opencode/herdr-focus-e2e"
await mkdir(base, { recursive: true })
const fixture = await mkdtemp(path.join(base, "fixture-"))
const receiptPath = path.join(base, `result-${Date.now()}.json`)
const receipt = { status: "running", scenarios: [] }
// Load the actual CLI workflow without mounting an interactive terminal.
const loader = path.join(fixture, "loader.mjs")
await writeFile(loader, `export async function resolve(specifier, context, next) {
  if (specifier === '@opencode/plugin/tui') return { url: 'data:text/javascript,export const Plugin = { define: value => value }', shortCircuit: true }
  return next(specifier, context)
}`)
register(loader, import.meta.url)
const { default: plugin } = await import("../dist/tui.js")
const bin = path.join(fixture, "bin")
await mkdir(bin)
await writeFile(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require('node:fs')
const cp = require('node:child_process')
const args = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(process.env.FOCUS_STATE, 'utf8'))
fs.appendFileSync(process.env.FOCUS_COMMANDS, JSON.stringify(args)+'\\n')
let result
if (args[0] === 'pane') result = {pane:{cwd:state.root,workspace_id:'primary',focused:state.focused,agent_session:{value:'original'}}}
else if (args[0] === 'worktree' && args[1] === 'create') {
  cp.execFileSync('git', ['worktree','add','-q','-b',args[args.indexOf('--branch')+1],state.tree,args[args.indexOf('--base')+1]], {cwd:state.root})
  result = {workspace:{workspace_id:'feature'},worktree:{path:state.tree},root_pane:{pane_id:'new-pane'}}
} else if (args[0] === 'agent') result = {agent:{agent_session:{value:'original'}}}
else if (args[0] === 'tab' && args[1] === 'get') result = {tab:{pane_count:1}}
else if (args[0] === 'tab' && args[1] === 'list') result = {tabs:[{tab_id:'old-tab'},{tab_id:'spare-tab'}]}
else if (args[0] === 'workspace' || args[0] === 'tab') result = {ok:true}
else process.exit(2)
process.stdout.write(JSON.stringify({result}))
`, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.HERDR_ENV = "1"
process.env.HERDR_TAB_ID = "old-tab"
// Disable the unrelated periodic tab-title synchronizer during setup.
delete process.env.HERDR_PANE_ID
try {
  for (const [name, focused, switchRoute] of [
    ["still-on-original", true, false],
    ["different-herdr-pane", false, false],
    ["different-opencode-conversation", true, true],
  ]) {
    const root = path.join(fixture, name)
    const tree = `${root}-feature`
    await mkdir(root)
    const git = async (...args) => execFile("git", args, { cwd: root })
    await git("init", "-q", "-b", "main")
    await git("-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "--allow-empty", "-qm", "base")
    process.env.FOCUS_STATE = path.join(fixture, `${name}.json`)
    process.env.FOCUS_COMMANDS = path.join(fixture, `${name}.jsonl`)
    await writeFile(process.env.FOCUS_STATE, JSON.stringify({ root, tree, focused: true }))
    await writeFile(process.env.FOCUS_COMMANDS, "")
    let route = { type: "session", sessionID: "original" }
    let directory = root
    let command
    const navigation = []
    const prompts = []
    const toasts = []
    delete process.env.HERDR_PANE_ID
    const dispose = plugin.setup({
      client: {
        rpc: () => ({}),
        session: {
          get: async () => ({ title: "Focus E2E", location: { directory } }),
          move: async ({ sessionID, directory: target }) => {
            assert.equal(sessionID, "original")
            directory = target
            if (switchRoute) route = { type: "session", sessionID: "other" }
            await writeFile(process.env.FOCUS_STATE, JSON.stringify({ root, tree, focused }))
          },
          prompt: async (input) => prompts.push(input),
        },
      },
      data: { on: () => () => {} },
      keymap: { layer: (get) => { command = get().commands[0] } },
      ui: {
        router: { current: () => route, navigate: (next) => { navigation.push(next); route = next } },
        slot: ({ render }) => { render(); return () => {} },
        toast: { show: (toast) => toasts.push(toast) },
      },
    })
    process.env.HERDR_PANE_ID = "old-pane"
    await command.run(`feature/${name}`)
    dispose()
    assert(toasts.some((toast) => toast.title === "Feature ready"), JSON.stringify(toasts))
    const commands = (await readFile(process.env.FOCUS_COMMANDS, "utf8")).trim().split("\n").map(JSON.parse)
    assert.equal(directory, tree, "same session moved even when focus changes")
    assert.ok(commands.some(args => args[0] === "agent" && args[1] === "start" && args.slice(args.indexOf("--") + 1).includes("--auto")), "moved session launches with auto approval")
    const follows = focused && !switchRoute
    assert.equal(commands.some((args) => args[0] === "workspace" && args[1] === "focus"), follows)
    assert.equal(navigation.length, switchRoute ? 0 : 1)
    assert.equal(commands.some((args) => args[0] === "tab" && args[1] === "close"), !switchRoute)
    receipt.scenarios.push({ name, status: "passed", commands, navigation, toasts })
    await git("worktree", "remove", tree)
  }
  receipt.status = "passed"
} catch (error) {
  receipt.status = "failed"
  receipt.error = String(error)
  throw error
} finally {
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`Focus E2E ${receipt.status}: ${receiptPath}`)
  if (receipt.status === "passed") await rm(fixture, { recursive: true })
}
