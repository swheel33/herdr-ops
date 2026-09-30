import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { refreshMaintenance } from "../dist/maintenance.js"

const base = "/tmp/opencode/herdr-maintenance-e2e"
await mkdir(base, { recursive: true })
const fixture = await mkdtemp(path.join(base, "fixture-"))
const receipt = path.join(base, `result-${Date.now()}.json`)
const checks = []
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const root = path.join(fixture, "primary")
const remote = path.join(fixture, "origin.git")
const writer = path.join(fixture, "writer")
const commands = path.join(fixture, "commands.jsonl")
try {
  await mkdir(root)
  git(root, "init", "-b", "develop")
  git(root, "config", "user.name", "E2E")
  git(root, "config", "user.email", "e2e@example.invalid")
  await writeFile(path.join(root, "tracked.txt"), "initial\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "initial")
  git(fixture, "clone", "--bare", root, remote)
  git(root, "remote", "add", "origin", remote)
  git(fixture, "clone", remote, writer)
  git(writer, "config", "user.name", "E2E")
  git(writer, "config", "user.email", "e2e@example.invalid")
  const initial = git(root, "rev-parse", "HEAD")
  await writeFile(path.join(writer, "tracked.txt"), "remote update\n")
  git(writer, "commit", "-am", "remote update")
  git(writer, "push", "origin", "develop")
  const latest = git(writer, "rev-parse", "HEAD")
  const bin = path.join(fixture, "bin")
  await mkdir(bin)
  const mock = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path')
const cmd = path.basename(process.argv[1]); const args = process.argv.slice(2)
fs.appendFileSync(process.env.MOCK_COMMANDS, JSON.stringify({cmd,args,cwd:process.cwd()})+'\\n')
function out(value) { process.stdout.write(JSON.stringify(value)) }
if (cmd === 'gh') { if (process.env.MOCK_GH_FAIL) process.exit(1); out([]) }
else if (args[0] === 'session') out({sessions:[{name:'work',running:true}]})
else if (args.includes('agent')) { if (process.env.MOCK_AGENT_FAIL) process.exit(1); out({result:{agents:[{agent_status:process.env.MOCK_ACTIVE ? 'working' : 'idle',cwd:process.env.MOCK_ROOT}]}}) }
else if (args.includes('workspace')) out({result:{workspaces:[{workspace_id:'feature',worktree:{repo_root:process.env.MOCK_ROOT,checkout_path:process.env.MOCK_ROOT,is_linked_worktree:true}}]}})
else if (args.includes('worktree')) out({result:{worktrees:[]}})
else process.exit(2)
`
  for (const command of ["herdr", "gh"]) await writeFile(path.join(bin, command), mock, { mode: 0o755 })
  process.env.PATH = `${bin}:${process.env.PATH}`
  process.env.MOCK_COMMANDS = commands
  process.env.MOCK_ROOT = root
  await writeFile(path.join(root, "unsaved.txt"), "preserve me")
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), initial)
  assert.equal(await readFile(path.join(root, "unsaved.txt"), "utf8"), "preserve me")
  await rm(path.join(root, "unsaved.txt"))
  checks.push("Dirty checkout preserved")
  await writeFile(path.join(root, "tracked.txt"), "unsaved tracked change\n")
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), initial)
  git(root, "add", "tracked.txt")
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), initial)
  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "unsaved tracked change\n")
  // Restore only the disposable fixture's known edits.
  await writeFile(path.join(root, "tracked.txt"), "initial\n")
  git(root, "add", "tracked.txt")
  checks.push("Tracked and staged edits preserved")
  const operation = path.join(root, ".git", "rebase-merge")
  await mkdir(operation)
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), initial)
  await rm(operation, { recursive: true })
  checks.push("In-progress Git operation prevents updates")
  git(root, "remote", "remove", "origin")
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), initial)
  git(root, "remote", "add", "origin", remote)
  checks.push("No-origin repository skipped")
  process.env.MOCK_ACTIVE = "1"
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), initial)
  delete process.env.MOCK_ACTIVE
  checks.push("Active primary agent prevents updates")
  process.env.MOCK_AGENT_FAIL = "1"
  await writeFile(commands, "")
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), initial)
  assert((await readFile(commands, "utf8")).includes("report-metadata"))
  assert((await readFile(commands, "utf8")).includes("worktree"))
  delete process.env.MOCK_AGENT_FAIL
  checks.push("Agent discovery failure preserves develop without blocking metadata or pruning")
  await writeFile(commands, "")
  await Promise.all([refreshMaintenance(root), refreshMaintenance(root)])
  assert.equal(git(root, "rev-parse", "HEAD"), latest)
  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "remote update\n")
  const calls = (await readFile(commands, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(calls.filter(call => call.cmd === "herdr" && call.args[0] === "session").length, 3)
  const metadata = calls.findIndex(call => call.args.includes("report-metadata"))
  const pruning = calls.findIndex(call => call.args.includes("worktree"))
  assert(metadata >= 0 && pruning > metadata)
  checks.push("Real origin fast-forward updates branch and files; overlapping cycles coalesced; metadata precedes pruning")
  await writeFile(path.join(root, "local.txt"), "local commit\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "local work")
  const local = git(root, "rev-parse", "HEAD")
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), local)
  checks.push("Ahead local commits preserved")
  await writeFile(path.join(writer, "remote.txt"), "divergence\n")
  git(writer, "add", ".")
  git(writer, "commit", "-m", "divergence")
  git(writer, "push", "origin", "develop")
  await refreshMaintenance(root)
  assert.equal(git(root, "rev-parse", "HEAD"), local)
  checks.push("Diverged local commits preserved")
  git(root, "switch", "-c", "feature/untouched")
  await refreshMaintenance(root)
  assert.equal(git(root, "branch", "--show-current"), "feature/untouched")
  assert.equal(git(root, "rev-parse", "HEAD"), local)
  checks.push("Other primary branches left untouched")
  const linked = path.join(fixture, "linked")
  git(root, "worktree", "add", "-b", "feature/linked", linked)
  await writeFile(commands, "")
  await refreshMaintenance(linked)
  assert.equal(await readFile(commands, "utf8"), "")
  checks.push("Linked checkouts do not start maintenance")
  process.env.MOCK_GH_FAIL = "1"
  await refreshMaintenance(root)
  const failedCalls = (await readFile(commands, "utf8")).trim().split("\n").map(JSON.parse)
  assert(failedCalls.some(call => call.args.includes("worktree")))
  checks.push("Metadata failure does not prevent pruning")
  await writeFile(receipt, JSON.stringify({ status: "passed", checks, initial, latest, local, calls }, null, 2))
  console.log(receipt)
} catch (error) {
  await writeFile(receipt, JSON.stringify({ status: "failed", checks, error: String(error), commands: await readFile(commands, "utf8").catch(() => "") }, null, 2))
  console.error(receipt)
  throw error
} finally {
  await rm(fixture, { recursive: true })
}
