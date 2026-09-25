import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { pruneClosedPRWorktrees } from "../dist/pr-pruning.js"

const base = "/tmp/opencode/herdr-pruning-e2e"
await mkdir(base, { recursive: true })
const fixture = await mkdtemp(path.join(base, "fixture-"))
const receipt = path.join(base, `result-${Date.now()}.json`)
const commands = path.join(fixture, "commands.jsonl")
const bin = path.join(fixture, "bin")
await mkdir(bin)
const branches = ["merged", "closed", "open", "dirty", "active", "fork", "unrelated", "reopened", "named"]
for (const branch of branches) await mkdir(path.join(fixture, branch))
const mock = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const cmd = path.basename(process.argv[1]); const args = process.argv.slice(2)
fs.appendFileSync(process.env.MOCK_COMMANDS, JSON.stringify({cmd,args,cwd:process.cwd()})+'\\n')
const branch = args[args.indexOf('--head')+1]
const session = args[0] === '--session' ? args[1] : 'default'
function out(value) { process.stdout.write(JSON.stringify(value)) }
if (cmd === 'gh') {
  const state = args[args.indexOf('--state')+1]
  const prState = ['merged','named','dirty','active','reopened'].includes(branch) ? 'MERGED' : ['closed','fork'].includes(branch) ? 'CLOSED' : 'OPEN'
  const pr = {headRefName:branch,isCrossRepository:branch === 'fork',state:prState}
  out(branch === 'reopened' && state === 'open' ? [{...pr,state:'OPEN'}] : branch === 'unrelated' || (state === 'open' && prState !== 'OPEN') ? [] : [pr])
} else if (cmd === 'git') {
  if (args[0] === 'status') process.stdout.write(path.basename(process.cwd()) === 'dirty' ? '?? unsaved.txt\\n' : '')
  else process.exit(2)
} else if (args[0] === 'session') out({sessions:[{name:'default',running:true},{name:'work',running:true},{name:'stopped',running:false}]})
else if (args.includes('worktree') && args.includes('list')) {
  const names = session === 'default' ? ['merged','closed','open','dirty','active','fork','unrelated','reopened'] : ['named']
  out({result:{worktrees:names.map(name=>({branch:name,path:path.join(process.env.MOCK_ROOT,name),is_linked_worktree:true,open_workspace_id:session+'-'+name}))}})
} else if (args.includes('agent') && args.includes('list')) {
  out({result:{agents:[{workspace_id:session+'-active',agent_status:'working'}]}})
} else if (args.includes('worktree') && args.includes('remove')) out({result:{removed:true}})
else process.exit(2)
`
for (const command of ["gh", "git", "herdr"]) await writeFile(path.join(bin, command), mock, { mode: 0o755 })
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.MOCK_ROOT = fixture
process.env.MOCK_COMMANDS = commands
const checks = []
try {
  await pruneClosedPRWorktrees(fixture)
  const calls = (await readFile(commands, "utf8")).trim().split("\n").map(JSON.parse)
  const removed = calls.filter((call) => call.cmd === "herdr" && call.args.includes("remove"))
  assert.deepEqual(removed.map((call) => call.args.at(-1)), ["default-merged", "default-closed", "work-named"])
  assert(removed.every((call) => !call.args.includes("--force")))
  checks.push("Merged and closed PR workspaces removed across default and named Herdr sessions without force")
  assert(calls.some((call) => call.cmd === "git" && call.args[0] === "status" && call.cwd.endsWith("/dirty")))
  assert(!calls.some((call) => call.cmd === "git" && call.args[0] === "status" && call.cwd.endsWith("/active")))
  checks.push("Dirty and active workspaces, open/reopened/fork PRs, and branches without PRs preserved")
  await writeFile(receipt, JSON.stringify({status:"passed",checks,removed,calls},null,2))
  console.log(receipt)
} catch (error) {
  await writeFile(receipt, JSON.stringify({status:"failed",checks,error:String(error),commands:await readFile(commands,"utf8").catch(()=>"")},null,2))
  console.error(receipt)
  throw error
} finally {
  await rm(fixture, { recursive:true })
}
