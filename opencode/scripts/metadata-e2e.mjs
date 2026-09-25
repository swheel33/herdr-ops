import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { refreshPRMetadata } from "../dist/pr-metadata.js"
import { syncTabTitles } from "../dist/tab-titles.js"

const base = "/tmp/opencode/herdr-metadata-e2e"
await mkdir(base, { recursive: true })
const fixture = await mkdtemp(path.join(base, "fixture-"))
const result = path.join(base, `result-${Date.now()}.json`)
const commands = path.join(fixture, "commands.jsonl")
const bin = path.join(fixture, "bin")
await mkdir(bin)
const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const cmd = path.basename(process.argv[1]); const args = process.argv.slice(2)
fs.appendFileSync(process.env.MOCK_COMMANDS, JSON.stringify({cmd,args})+'\\n')
const root = process.env.MOCK_ROOT
function out(value) { process.stdout.write(JSON.stringify(value)) }
if (cmd === 'gh') out([{number:105,headRefName:'feature/demo',state:'OPEN',isDraft:false,isCrossRepository:false},{number:106,headRefName:'feature/draft',state:'OPEN',isDraft:true,isCrossRepository:false}])
else if (cmd === 'git') {
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') process.stdout.write(path.basename(process.cwd()) === 'demo' ? 'feature/demo' : 'feature/draft')
  else process.exit(2)
} else if (args[0] === 'session') out({sessions:[{name:'default',running:true},{name:'work',running:true},{name:'off',running:false}]})
else if (args.includes('workspace') && args.includes('list')) {
  const name = args[1]; out({result:{workspaces:[{workspace_id:name+'-ws',worktree:{repo_root:root,checkout_path:path.join(root,name === 'default' ? 'demo' : 'draft'),is_linked_worktree:true}},{workspace_id:'unrelated',worktree:{repo_root:'/other',checkout_path:'/other',is_linked_worktree:true}}]}})
} else if (args.includes('pane') && args.includes('get')) out({result:{pane:{tab_id:'tab-1',agent_session:{value:'session-1'}}}})
else if (args.includes('tab') && args.includes('get')) out({result:{tab:{label:process.env.MOCK_TAB_LABEL ?? 'First title'}}})
else if (args.includes('tab') && args.includes('rename')) out({result:{tab:{label:args.at(-1)}}})
else if (args.includes('report-metadata')) out({result:{ok:true}})
else process.exit(2)
`
for (const command of ["gh", "git", "herdr"]) {
  await writeFile(path.join(bin, command), script, { mode: 0o755 })
}
await mkdir(path.join(fixture, "demo"))
await mkdir(path.join(fixture, "draft"))
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.MOCK_COMMANDS = commands
process.env.MOCK_ROOT = fixture
const checks = []
try {
  await refreshPRMetadata(fixture)
  const recorded = async () => (await readFile(commands, "utf8")).trim().split("\n").map(JSON.parse)
  const reports = (await recorded()).filter((call) => call.args.includes("report-metadata"))
  assert.equal(reports.length, 2)
  assert(reports.some((call) => call.args.includes("default-ws") && call.args.includes("pr_open=#105") && call.args.includes("pr_branch=feature/demo")))
  assert(reports.some((call) => call.args.includes("work-ws") && call.args.includes("pr_draft=#106") && call.args.includes("pr_branch=feature/draft")))
  assert(reports.every((call) => call.args.includes("--clear-token") && call.args.includes("pr_closed")))
  checks.push("PR badges refreshed in default and named sessions with appropriate state and stale-token clearing")

  let title = "First title"
  const titles = syncTabTitles("pane-1", async (id) => { assert.equal(id, "session-1"); return { title } })
  assert.equal(await titles.update("another-session"), false)
  assert.equal(await titles.update(), true)
  title = "New title"
  assert.equal(await titles.update("session-1"), true)
  process.env.MOCK_TAB_LABEL = "New title"
  await titles.dispose()
  const renames = (await recorded()).filter((call) => call.args.includes("rename"))
  assert.deepEqual(renames.map((call) => call.args.at(-1)), ["First title", "New title", ""])
  checks.push("Pane-owned tab followed title changes and cleared only its own title at shutdown")

  const manual = syncTabTitles("pane-1", async () => ({ title: "First title" }))
  await manual.update()
  process.env.MOCK_TAB_LABEL = "Manual override"
  await manual.dispose()
  assert.equal((await recorded()).filter((call) => call.args.includes("rename") && call.args.at(-1) === "").length, 1)
  checks.push("Manually changed tab label was preserved at shutdown")
  await writeFile(result, JSON.stringify({ status: "passed", checks, reports, renames, platform: os.platform() }, null, 2))
  console.log(result)
} catch (error) {
  await writeFile(result, JSON.stringify({ status: "failed", checks, error: String(error), commands: await readFile(commands, "utf8").catch(() => "") }, null, 2))
  console.error(result)
  throw error
} finally {
  await rm(fixture, { recursive: true })
}
