import assert from "node:assert/strict"
import test from "node:test"

import { CommandError } from "../dist/errors.js"
import { HerdrDispatcher } from "../dist/dispatch.js"

function result(stdout = "") {
  return { stdout, stderr: "", exitCode: 0, signal: null }
}

function failure(command, code) {
  return new CommandError(command, {
    stdout: "",
    stderr: JSON.stringify({ error: { code } }),
    exitCode: 1,
    signal: null,
  })
}

function promptCommand() {
  return {
    executable: "herdr",
    args: ["agent", "prompt", "agent-1", "implementation plan"],
    cwd: "/repo",
  }
}

test("submits the plan before independently waiting for working state", async () => {
  const commands = []
  const runner = {
    async run(command) {
      commands.push(command)
      return result()
    },
  }
  const dispatcher = new HerdrDispatcher({ runner, realpath: async (value) => value })

  const observed = await dispatcher.deliverPlan(promptCommand(), "agent-1")

  assert.equal(observed, true)
  assert.deepEqual(commands.map((command) => command.args), [
    ["agent", "prompt", "agent-1", "implementation plan"],
    ["agent", "wait", "agent-1", "--until", "working", "--timeout", "60000"],
  ])
})

test("does not resubmit after a stalled prompt observation", async () => {
  const commands = []
  const warnings = []
  const runner = {
    async run(command) {
      commands.push(command)
      if (commands.length === 1) throw failure(command, "agent_prompt_stalled")
      return result()
    },
  }
  const dispatcher = new HerdrDispatcher({
    runner,
    realpath: async (value) => value,
    logger: (level, message) => {
      if (level === "warn") warnings.push(message)
    },
  })

  const observed = await dispatcher.deliverPlan(promptCommand(), "agent-1")

  assert.equal(observed, true)
  assert.equal(commands.length, 2)
  assert.match(warnings.join("\n"), /stalled/u)
})

test("keeps an accepted plan successful when working observation times out", async () => {
  const commands = []
  const runner = {
    async run(command) {
      commands.push(command)
      if (commands.length === 2) throw failure(command, "timeout")
      return result()
    },
  }
  const dispatcher = new HerdrDispatcher({ runner, realpath: async (value) => value })

  const observed = await dispatcher.deliverPlan(promptCommand(), "agent-1")

  assert.equal(observed, false)
  assert.equal(commands.length, 2)
})

test("keeps actual prompt rejection as a failure without waiting or retrying", async () => {
  const commands = []
  const runner = {
    async run(command) {
      commands.push(command)
      throw failure(command, "agent_blocked")
    },
  }
  const dispatcher = new HerdrDispatcher({ runner, realpath: async (value) => value })

  await assert.rejects(
    dispatcher.deliverPlan(promptCommand(), "agent-1"),
    /agent_blocked/u,
  )
  assert.equal(commands.length, 1)
})
