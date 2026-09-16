import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { CommandError } from "../dist/errors.js"
import { RepositoryMaintenance } from "../dist/maintenance.js"
import { HerdrTabTitleSynchronizer } from "../dist/tab-titles.js"

function result(stdout = "") {
  return { stdout, stderr: "", exitCode: 0, signal: null }
}

function notFound(command) {
  return new CommandError(command, {
    stdout: "",
    stderr: "",
    exitCode: 1,
    signal: null,
  })
}

async function maintenanceForTest(t, runner, commonDir) {
  const directory = commonDir ?? await mkdtemp(path.join(tmpdir(), "opencode-herdr-test-"))
  if (!commonDir) {
    t.after(() => rm(directory, { recursive: true, force: true }))
  }
  return new RepositoryMaintenance(runner, "/repo", directory)
}

test("renames the Herdr tab mapped to an OpenCode root session", async () => {
  const commands = []
  let tabLabel
  const runner = {
    async run(command) {
      commands.push(command)
      if (command.args[0] === "agent") {
        return result(JSON.stringify({
          result: {
            agents: [{
              agent_session: { value: "session-1" },
              tab_id: "w1:t2",
            }],
          },
        }))
      }
      if (command.args[1] === "get") {
        return result(JSON.stringify({ result: { tab: { label: tabLabel } } }))
      }
      tabLabel = command.args[3]
      return result()
    },
  }
  const synchronizer = new HerdrTabTitleSynchronizer(runner, "/repo")

  await synchronizer.handle({
    type: "session.updated",
    properties: {
      info: {
        id: "session-1",
        projectID: "project-1",
        directory: "/repo",
        title: "Implement billing exports",
        version: "1",
        time: { created: 1, updated: 2 },
      },
    },
  })
  await synchronizer.dispose()

  assert.deepEqual(commands[1].args, [
    "tab",
    "rename",
    "w1:t2",
    "Implement billing exports",
  ])
  assert.deepEqual(commands.at(-1).args, ["tab", "rename", "w1:t2", ""])
})

test("keeps the newest title when session updates overlap", async () => {
  let releaseFirstRename
  const firstRenameStarted = new Promise((resolve) => {
    releaseFirstRename = resolve
  })
  let unblockFirstRename
  const firstRenameBlocked = new Promise((resolve) => {
    unblockFirstRename = resolve
  })
  const renamedTitles = []
  let tabLabel
  const runner = {
    async run(command) {
      if (command.args[0] === "agent") {
        return result(JSON.stringify({
          result: {
            agents: [{ agent_session: { value: "session-1" }, tab_id: "w1:t2" }],
          },
        }))
      }
      if (command.args[1] === "get") {
        return result(JSON.stringify({ result: { tab: { label: tabLabel } } }))
      }
      const title = command.args[3]
      tabLabel = title
      renamedTitles.push(title)
      if (title === "First title") {
        releaseFirstRename()
        await firstRenameBlocked
      }
      return result()
    },
  }
  const synchronizer = new HerdrTabTitleSynchronizer(runner, "/repo")
  const event = (title) => ({
    type: "session.updated",
    properties: {
      info: {
        id: "session-1",
        projectID: "project-1",
        directory: "/repo",
        title,
        version: "1",
        time: { created: 1, updated: 2 },
      },
    },
  })

  const first = synchronizer.handle(event("First title"))
  await firstRenameStarted
  const second = synchronizer.handle(event("Newest title"))
  unblockFirstRename()
  await Promise.all([first, second])
  assert.equal(renamedTitles.at(-1), "Newest title")
  await synchronizer.dispose()
})

test("does not clear a Herdr tab title replaced by another owner", async () => {
  const renamedTitles = []
  const runner = {
    async run(command) {
      if (command.args[0] === "agent") {
        return result(JSON.stringify({
          result: {
            agents: [{ agent_session: { value: "session-1" }, tab_id: "w1:t2" }],
          },
        }))
      }
      if (command.args[1] === "get") {
        return result(JSON.stringify({ result: { tab: { label: "New session title" } } }))
      }
      renamedTitles.push(command.args[3])
      return result()
    },
  }
  const synchronizer = new HerdrTabTitleSynchronizer(runner, "/repo")

  await synchronizer.handle({
    type: "session.updated",
    properties: {
      info: {
        id: "session-1",
        projectID: "project-1",
        directory: "/repo",
        title: "Old session title",
        version: "1",
        time: { created: 1, updated: 2 },
      },
    },
  })
  await synchronizer.dispose()

  assert.deepEqual(renamedTitles, ["Old session title"])
})

test("fast-forwards a clean checked-out develop branch", async (t) => {
  const commands = []
  let worktreeListCount = 0
  const runner = {
    async run(command) {
      commands.push(command)
      if (command.executable === "git" && command.args[0] === "rev-parse") {
        return result(command.args[2] === "refs/remotes/origin/develop" ? "new\n" : "old\n")
      }
      if (command.executable === "herdr" && command.args[0] === "worktree") {
        worktreeListCount += 1
        return result(JSON.stringify({
          result: {
            worktrees: worktreeListCount === 1
              ? [{ path: "/repo", branch: "develop", is_linked_worktree: false }]
              : [],
          },
        }))
      }
      return result()
    },
  }
  const maintenance = await maintenanceForTest(t, runner)

  await maintenance.run()
  await maintenance.dispose()

  assert.ok(commands.some((command) =>
    command.executable === "git" &&
    command.args.join(" ") === "merge --ff-only new"
  ))
})

test("force-removes a worktree whose current commit has a closed PR", async (t) => {
  const commands = []
  const runner = {
    async run(command) {
      commands.push(command)
      if (command.executable === "git" && command.args[0] === "show-ref") {
        throw notFound(command)
      }
      if (command.executable === "herdr" && command.args[0] === "worktree" && command.args[1] === "list") {
        return result(JSON.stringify({
          result: {
            worktrees: [{
              path: "/repo-feature",
              branch: "feature/billing",
              is_linked_worktree: true,
              open_workspace_id: "w2",
            }],
          },
        }))
      }
      if (command.executable === "git" && command.args[0] === "rev-parse") {
        return result("abc123\n")
      }
      if (command.executable === "gh") {
        return result(JSON.stringify([{
          headRefName: "feature/billing",
          headRefOid: "abc123",
          isCrossRepository: false,
          state: "MERGED",
        }]))
      }
      return result()
    },
  }
  const maintenance = await maintenanceForTest(t, runner)

  await maintenance.run()
  await maintenance.dispose()

  assert.ok(commands.some((command) =>
    command.executable === "herdr" &&
    command.args.join(" ") === "worktree remove --workspace w2 --force"
  ))
})

test("preserves a worktree when a matching PR remains open", async (t) => {
  const commands = []
  const runner = {
    async run(command) {
      commands.push(command)
      if (command.executable === "git" && command.args[0] === "show-ref") {
        throw notFound(command)
      }
      if (command.executable === "herdr" && command.args[0] === "worktree" && command.args[1] === "list") {
        return result(JSON.stringify({
          result: {
            worktrees: [{
              path: "/repo-feature",
              branch: "feature/billing",
              is_linked_worktree: true,
              open_workspace_id: "w2",
            }],
          },
        }))
      }
      if (command.executable === "git" && command.args[0] === "rev-parse") {
        return result("abc123\n")
      }
      if (command.executable === "gh") {
        return result(JSON.stringify([{
          headRefName: "feature/billing",
          headRefOid: "abc123",
          isCrossRepository: false,
          state: "OPEN",
        }]))
      }
      return result()
    },
  }
  const maintenance = await maintenanceForTest(t, runner)

  await maintenance.run()
  await maintenance.dispose()

  assert.equal(commands.some((command) =>
    command.executable === "herdr" && command.args[1] === "remove"
  ), false)
})

test("runs maintenance once across concurrent and staggered primary instances", async (t) => {
  const commonDir = await mkdtemp(path.join(tmpdir(), "opencode-herdr-test-"))
  t.after(() => rm(commonDir, { recursive: true, force: true }))
  let unblockFetch
  const fetchBlocked = new Promise((resolve) => {
    unblockFetch = resolve
  })
  let markFetchStarted
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve
  })
  let fetches = 0
  const runner = {
    async run(command) {
      if (command.executable === "git" && command.args[0] === "fetch") {
        fetches += 1
        markFetchStarted()
        await fetchBlocked
        return result()
      }
      if (command.executable === "git" && command.args[0] === "show-ref") {
        throw notFound(command)
      }
      if (command.executable === "herdr") {
        return result(JSON.stringify({ result: { worktrees: [] } }))
      }
      return result()
    },
  }
  const first = await maintenanceForTest(t, runner, commonDir)
  const concurrent = await maintenanceForTest(t, runner, commonDir)

  const firstRun = first.run()
  await fetchStarted
  const concurrentRun = concurrent.run()
  unblockFetch()
  await Promise.all([firstRun, concurrentRun])

  const staggered = await maintenanceForTest(t, runner, commonDir)
  await staggered.run()
  await Promise.all([first.dispose(), concurrent.dispose(), staggered.dispose()])

  assert.equal(fetches, 1)
})
