import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { lstat, mkdtemp, readlink, realpath, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { createOpencode } from "@opencode-ai/sdk"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { HerdrDispatcher } from "../dist/dispatch.js"

const execFile = promisify(execFileCallback)
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 10 * 60_000)
const model = process.env.E2E_MODEL

async function run(executable, args, cwd) {
  const result = await execFile(executable, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  return result.stdout
}

function unwrap(response, label) {
  if (response.error) {
    throw new Error(`${label}: ${JSON.stringify(response.error)}`)
  }
  return response.data
}

async function withTimeout(promise, label, duration = timeoutMs, onTimeout) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          Promise.resolve(onTimeout?.()).catch(() => undefined)
          reject(new Error(`${label} timed out`))
        }, duration)
      }),
    ])
  } finally {
    clearTimeout(timer)
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

async function createFixture(name) {
  const root = await mkdtemp(path.join(tmpdir(), `opencode-herdr-${name}-`))
  const origin = `${root}-origin.git`
  const publisher = await mkdtemp(path.join(tmpdir(), `opencode-herdr-${name}-publisher-`))
  await mkdir(path.join(root, "src"))
  await mkdir(path.join(root, "apps", "demo"), { recursive: true })
  await writeFile(
    path.join(root, ".gitignore"),
    ".env\n.env.local\n.pnpm-install-complete\n",
  )
  await writeFile(path.join(root, ".env"), "E2E_SECRET=root\n")
  await writeFile(path.join(root, ".env.local"), "E2E_LOCAL=local\n")
  await writeFile(
    path.join(root, "apps", "demo", ".env.local"),
    "VITE_NEST_API_URL=https://api.example.invalid/v1\n",
  )
  await writeFile(path.join(root, ".env.example"), "E2E_SECRET=example\n")
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({
      name: `herdr-${name}`,
      private: true,
      type: "module",
      scripts: {
        postinstall:
          "node -e \"require('node:fs').writeFileSync('.pnpm-install-complete', '')\"",
      },
    }, null, 2)}\n`,
  )
  await writeFile(
    path.join(root, "src", "server.js"),
    "export function handleRequest(pathname) { return pathname === '/' ? 'ok' : 'not found' }\n",
  )
  await writeFile(
    path.join(root, "src", "cli.js"),
    "export function runCli(args) { return args.join(' ') }\n",
  )
  await writeFile(path.join(root, "README.md"), "# Herdr dispatch E2E fixture\n")
  await writeFile(
    path.join(root, "AGENTS.md"),
    "Keep implementations direct. Do not add compatibility layers or documentation unless requested. Use only verification relevant to the changed behavior.\n",
  )
  await run("git", ["init", "-b", "trunk"], root)
  await run("git", ["config", "user.name", "Herdr E2E"], root)
  await run("git", ["config", "user.email", "herdr-e2e@example.invalid"], root)
  await run("git", ["add", "."], root)
  await run("git", ["commit", "-m", "Initial fixture"], root)
  await run("git", ["init", "--bare", origin], root)
  await run("git", ["symbolic-ref", "HEAD", "refs/heads/trunk"], origin)
  await run("git", ["remote", "add", "origin", origin], root)
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
}

async function rootFingerprint(root) {
  const [branch, commit, status, server] = await Promise.all([
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root),
    run("git", ["rev-parse", "--verify", "HEAD"], root),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root),
    run("git", ["hash-object", "src/server.js"], root),
  ])
  return { branch, commit, status, server }
}

async function assertFreshOriginBase(fixture, worktree) {
  const fetched = (await run(
    "git",
    ["rev-parse", "refs/remotes/origin/trunk"],
    fixture.root,
  )).trim()
  assert.equal(fetched, fixture.remoteCommit, "dispatch must freshly fetch origin/trunk")
  const mergeBase = (await run(
    "git",
    ["merge-base", fixture.remoteCommit, "HEAD"],
    worktree.path,
  )).trim()
  assert.equal(mergeBase, fixture.remoteCommit, "feature branch must contain the fresh origin commit")
}

async function listLinkedWorktrees(root) {
  const output = JSON.parse(await run("herdr", ["worktree", "list", "--cwd", root], root))
  const worktrees = output.result?.worktrees
  assert.ok(Array.isArray(worktrees), "Herdr worktree list must include worktrees")
  const canonicalRoot = await realpath(root)
  return worktrees.filter((worktree) => path.resolve(worktree.path) !== canonicalRoot)
}

async function assertEnvironmentLinks(root, worktreePath) {
  for (const relativePath of [".env", ".env.local", "apps/demo/.env.local"]) {
    const destination = path.join(worktreePath, relativePath)
    assert.ok((await lstat(destination)).isSymbolicLink(), `${relativePath} must be a symlink`)
    const target = await readlink(destination)
    assert.equal(
      path.resolve(path.dirname(destination), target),
      path.join(await realpath(root), relativePath),
      `${relativePath} must link to the primary checkout`,
    )
  }
  assert.ok(
    !(await lstat(path.join(worktreePath, ".env.example"))).isSymbolicLink(),
    ".env.example must remain a tracked regular file",
  )
}

async function assertDependenciesInstalled(worktreePath) {
  assert.ok(
    (await lstat(path.join(worktreePath, ".pnpm-install-complete"))).isFile(),
    "pnpm install must run in the new worktree",
  )
}

async function assertWorkspace(worktree, root) {
  assert.equal(typeof worktree.open_workspace_id, "string", "worktree must be open in Herdr")
  const workspaceID = worktree.open_workspace_id
  const panes = await waitFor("two-pane workspace setup", async () => {
    const panesOutput = JSON.parse(
      await run("herdr", ["pane", "list", "--workspace", workspaceID], root),
    )
    const current = panesOutput.result?.panes
    return Array.isArray(current) && current.length === 2 ? current : undefined
  })

  const paneIDs = panes.map((pane) => pane.pane_id)
  const layoutOutput = JSON.parse(
    await run("herdr", ["pane", "layout", "--pane", paneIDs[0]], root),
  )
  const layout = layoutOutput.result?.layout
  assert.equal(layout?.panes?.length, 2, "layout must report two panes")
  assert.equal(layout?.splits?.length, 1, "layout must report one split")
  assert.equal(layout.splits[0].direction, "down", "panes must be split top/bottom")
  assert.ok(Math.abs(layout.splits[0].ratio - 0.7) <= 0.02, "top pane must use 70%")
  const ordered = [...layout.panes].sort((left, right) => left.rect.y - right.rect.y)
  assert.ok(ordered[0].rect.height > ordered[1].rect.height, "agent pane must be above and larger")

  const agent = await waitFor("Build agent registration", async () => {
    const agentsOutput = JSON.parse(await run("herdr", ["agent", "list"], root))
    const agents = agentsOutput.result?.agents
    if (!Array.isArray(agents)) return undefined
    const registered = agents.find((entry) => entry.pane_id === ordered[0].pane_id)
    return registered?.agent_session?.value ? registered : undefined
  })
  await assertEnvironmentLinks(root, worktree.path)
  await assertDependenciesInstalled(worktree.path)
  return agent
}

async function cleanupFixture(fixture) {
  const { root, origin } = fixture
  try {
    const worktrees = await listLinkedWorktrees(root)
    for (const worktree of worktrees) {
      if (typeof worktree.open_workspace_id === "string") {
        await run(
          "herdr",
          ["worktree", "remove", "--workspace", worktree.open_workspace_id, "--force"],
          root,
        )
      } else {
        await run("git", ["worktree", "remove", "--force", worktree.path], root)
      }
    }
    await run("git", ["worktree", "prune"], root)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(origin, { recursive: true, force: true })
  }
}

async function createSession(client, root, title) {
  const session = unwrap(
    await client.session.create({ directory: root, title }),
    "create OpenCode session",
  )
  assert.equal(typeof session?.id, "string", "OpenCode must return a session ID")
  return session.id
}

async function closeSession(client, sessionID, root) {
  await client.session.abort({ sessionID, directory: root }).catch(() => undefined)
  await client.session.delete({ sessionID, directory: root }).catch(() => undefined)
}

async function promptPlan(client, parameters, label) {
  let lastResponse
  for (let attempt = 0; attempt < 2; attempt += 1) {
    lastResponse = await withTimeout(
      client.session.prompt(parameters),
      label,
      timeoutMs,
      () => client.session.abort({
        sessionID: parameters.sessionID,
        directory: parameters.directory,
      }),
    )
    if (!lastResponse.error) return lastResponse.data
  }
  return unwrap(lastResponse, label)
}

async function executeFeature(client, sessionID, root, request) {
  return withTimeout(
    client.session.command({
      sessionID,
      directory: root,
      command: "feature",
      arguments: request,
      ...(model ? { model } : {}),
    }),
    "real /feature command",
    timeoutMs,
    () => client.session.abort({ sessionID, directory: root }),
  )
}

async function runCohesiveScenario(client) {
  const fixture = await createFixture("cohesive")
  const { root } = fixture
  let sessionID
  try {
    const before = await rootFingerprint(root)
    sessionID = await createSession(client, root, "Herdr E2E cohesive feature")
    await promptPlan(
      client,
      {
          sessionID,
          directory: root,
          agent: "plan",
          parts: [{
            type: "text",
            text: "Produce a concise implementation-ready plan, not code, for one account display-name outcome. Preserve these literal decisions in the plan: PLAN_DECISION_DIRECT_HANDLER means change the existing server handler directly; GREENFIELD_NO_COMPAT means add no migration, fallback, or compatibility layer. Include the browser form and validation in the same outcome. Do not add documentation or broad verification.",
          }],
      },
      "parent planning response",
    )
    const command = executeFeature(
      client,
      sessionID,
      root,
      "",
    ).catch(() => undefined)
    const worktrees = await waitFor("one cohesive Herdr dispatch", async () => {
      const current = await listLinkedWorktrees(root)
      return current.length === 1 ? current : undefined
    })
    const agent = await assertWorkspace(worktrees[0], root)
    await assertFreshOriginBase(fixture, worktrees[0])
    assert.deepEqual(await rootFingerprint(root), before, "dispatch must not change the root checkout")
    const agentSessionID = agent.agent_session?.value
    assert.equal(typeof agentSessionID, "string", "Herdr must report the Build agent session")
    const agentMessages = unwrap(
      await client.session.messages({
        sessionID: agentSessionID,
        directory: worktrees[0].path,
      }),
      "read Build agent messages",
    )
    const deliveredPlan = agentMessages
      .filter((message) => message.info?.role === "user")
      .flatMap((message) => message.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
    assert.match(deliveredPlan, /PLAN_DECISION_DIRECT_HANDLER/u)
    assert.match(deliveredPlan, /GREENFIELD_NO_COMPAT/u)
    process.stdout.write("PASS existing plan was reused in one origin-based dispatch\n")
    void command
  } finally {
    if (sessionID) {
      await closeSession(client, sessionID, root)
    }
    await cleanupFixture(fixture)
  }
}

async function runIndependentScenario(client) {
  const fixture = await createFixture("independent")
  const { root } = fixture
  let sessionID
  try {
    const before = await rootFingerprint(root)
    sessionID = await createSession(client, root, "Herdr E2E independent features")
    const pendingBefore = unwrap(await client.question.list({ directory: root }), "list questions")
    const previousQuestionIDs = new Set(pendingBefore.map((question) => question.id))
    const command = executeFeature(
      client,
      sessionID,
      root,
      "Implement two explicitly separate and independently releasable outcomes on separate branches: F1 adds a server health endpoint with its own tests and docs; F2 adds a standalone CLI command that prints parsed arguments with its own tests and docs. They share no contract or prerequisite work.",
    )
    const question = await waitFor("real multi-feature question", async () => {
      const pending = unwrap(await client.question.list({ directory: root }), "list questions")
      return pending.find((entry) => !previousQuestionIDs.has(entry.id))
    })
    assert.equal(question.questions.length, 1, "coordinator must ask one combined question")
    const prompt = question.questions[0]
    assert.equal(prompt.multiple, true, "feature question must allow multiple selection")
    assert.notEqual(prompt.custom, false, "feature question must allow grouping corrections")
    assert.ok(prompt.options.length >= 2, "feature question must offer at least two features")
    await client.question.reply({
      requestID: question.id,
      directory: root,
      answers: [prompt.options.map((option) => option.label)],
    })
    unwrap(await command, "independent /feature command")
    const worktrees = await waitFor("two independent Herdr dispatches", async () => {
      const current = await listLinkedWorktrees(root)
      return current.length === 2 ? current : undefined
    })
    for (const worktree of worktrees) {
      await assertWorkspace(worktree, root)
      await assertFreshOriginBase(fixture, worktree)
    }
    assert.deepEqual(await rootFingerprint(root), before, "batch dispatch must not change root")
    process.stdout.write("PASS independent request created two real dispatches\n")
  } finally {
    if (sessionID) {
      await closeSession(client, sessionID, root)
    }
    await cleanupFixture(fixture)
  }
}

async function runMissingOriginScenario() {
  const fixture = await createFixture("missing-origin")
  const { root } = fixture
  try {
    await run("git", ["remote", "remove", "origin"], root)
    const before = await rootFingerprint(root)
    await assert.rejects(
      new HerdrDispatcher().dispatch(root, {
        mode: "new",
        title: "Missing origin safety",
        branch: "feature/greeting-endpoint",
        plan: "Implement one small greenfield greeting endpoint directly without compatibility layers or unrelated changes.",
      }),
      /origin/u,
    )
    assert.equal((await listLinkedWorktrees(root)).length, 0, "missing origin must create no worktree")
    assert.equal(
      (await run("git", ["branch", "--format=%(refname:short)"], root)).trim(),
      "trunk",
      "missing origin must create no feature branch",
    )
    assert.deepEqual(await rootFingerprint(root), before, "failed dispatch must not change root")
    process.stdout.write("PASS missing origin failed without side effects\n")
  } finally {
    await cleanupFixture(fixture)
  }
}

async function runRootTargetScenario() {
  const fixture = await createFixture("root-target")
  const { root } = fixture
  try {
    const before = await rootFingerprint(root)
    await assert.rejects(
      new HerdrDispatcher().dispatch(root, {
        mode: "continue",
        title: "Unsafe root target",
        branch: "trunk",
        source: "trunk",
        plan: "Implement the requested change directly while preserving the primary checkout and all existing project instructions.",
      }),
      /primary checkout/u,
    )
    assert.equal((await listLinkedWorktrees(root)).length, 0, "root branch must not be reopened")
    assert.deepEqual(await rootFingerprint(root), before, "root-target rejection must preserve root")
    process.stdout.write("PASS primary checkout was rejected as a dispatch target\n")
  } finally {
    await cleanupFixture(fixture)
  }
}

async function runLinkedWorktreePluginScenario() {
  const fixture = await createFixture("linked-plugin")
  const linkedPath = `${fixture.root}-linked`
  try {
    await run(
      "git",
      ["worktree", "add", "-b", "feature/plugin-inert", linkedPath, "HEAD"],
      fixture.root,
    )
    const config = JSON.parse(await run("opencode", ["debug", "config"], linkedPath))
    assert.equal(
      config.command?.feature,
      undefined,
      "plugin must not register /feature in a linked worktree",
    )
    assert.equal(
      config.agent?.["herdr-feature-coordinator"],
      undefined,
      "plugin must not register its coordinator in a linked worktree",
    )
    process.stdout.write("PASS plugin stayed inert in a linked worktree\n")
  } finally {
    await cleanupFixture(fixture)
    await rm(linkedPath, { recursive: true, force: true })
  }
}

async function runAgentsConflictScenario(client) {
  const fixture = await createFixture("agents-conflict")
  const { root } = fixture
  let sessionID
  try {
    sessionID = await createSession(client, root, "Herdr E2E AGENTS conflict")
    await promptPlan(
      client,
      {
          sessionID,
          directory: root,
          agent: "plan",
          parts: [{
            type: "text",
            text: "Produce an implementation-ready plan, not code, for a new greeting endpoint. Include the literal decision PLAN_REQUIRES_LEGACY_ALIAS and require a legacy compatibility alias. Keep the plan concise.",
          }],
      },
      "conflicting parent planning response",
    )
    await run("git", ["pull", "--ff-only", "origin", "trunk"], root)
    await writeFile(
      path.join(root, "AGENTS.md"),
      "Implement greenfield endpoints directly. Legacy aliases and compatibility layers are prohibited.\n",
    )
    await run("git", ["add", "AGENTS.md"], root)
    await run("git", ["commit", "-m", "Prohibit compatibility aliases"], root)
    await run("git", ["push", "origin", "trunk"], root)
    fixture.remoteCommit = (await run("git", ["rev-parse", "HEAD"], root)).trim()
    const before = await rootFingerprint(root)
    const pendingBefore = unwrap(await client.question.list({ directory: root }), "list questions")
    const previousQuestionIDs = new Set(pendingBefore.map((question) => question.id))
    const command = executeFeature(client, sessionID, root, "").catch(() => undefined)
    const question = await waitFor("AGENTS.md conflict question", async () => {
      const pending = unwrap(await client.question.list({ directory: root }), "list questions")
      return pending.find((entry) => !previousQuestionIDs.has(entry.id))
    })
    const questionText = question.questions.map((entry) => entry.question).join("\n")
    assert.match(questionText, /AGENTS|project instruction|conflict/iu)
    await client.question.reply({
      requestID: question.id,
      directory: root,
      answers: [["Follow AGENTS.md and remove the legacy alias"]],
    })
    const worktrees = await waitFor("resolved AGENTS dispatch", async () => {
      const current = await listLinkedWorktrees(root)
      return current.length === 1 ? current : undefined
    })
    await assertWorkspace(worktrees[0], root)
    await assertFreshOriginBase(fixture, worktrees[0])
    assert.deepEqual(await rootFingerprint(root), before, "AGENTS resolution must preserve root")
    process.stdout.write("PASS AGENTS.md conflict required explicit resolution\n")
    void command
  } finally {
    if (sessionID) {
      await closeSession(client, sessionID, root)
    }
    await cleanupFixture(fixture)
  }
}

async function runDispatchSafetyScenario() {
  await runMissingOriginScenario()
  await runRootTargetScenario()
  await runLinkedWorktreePluginScenario()
}

const controller = new AbortController()
const { server } = await createOpencode({ signal: controller.signal, timeout: 30_000 })
const client = createOpencodeClient({ baseUrl: server.url })

try {
  const commands = unwrap(await client.command.list(), "list OpenCode commands")
  assert.ok(commands.some((command) => command.name === "feature"), "plugin must register /feature")
  const scenarios = {
    cohesive: runCohesiveScenario,
    independent: runIndependentScenario,
    "missing-origin": runMissingOriginScenario,
    "root-target": runRootTargetScenario,
    "linked-plugin": runLinkedWorktreePluginScenario,
    "agents-conflict": runAgentsConflictScenario,
    safety: runDispatchSafetyScenario,
  }
  const selected = process.env.E2E_SCENARIO?.split(",").filter(Boolean) ?? ["cohesive", "safety"]
  for (const name of selected) {
    const scenario = scenarios[name]
    assert.equal(typeof scenario, "function", `unknown E2E scenario ${JSON.stringify(name)}`)
    await scenario(client)
  }
} finally {
  controller.abort()
  server.close()
}
