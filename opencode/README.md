# opencode-herdr-dispatch

An OpenCode plugin for turning agreed implementation plans into background Herdr worktrees and OpenCode Build agents.

## Scope

The plugin intentionally handles one workflow:

1. `/feature` authorizes one batch of one to eight independent features.
2. For each feature, the plugin creates a new branch or checks out one explicitly supplied existing pull request branch in a linked worktree.
3. It links ignored local environment files into each new worktree.
4. It installs worktree dependencies with `pnpm install`.
5. It starts one Build agent per feature in a 70/30 agent and shell layout.
6. It delivers each plan and waits for that agent to begin working.
7. It reports each feature independently and continues the batch after failures.
8. It periodically refreshes pull-request metadata, safely advances local `develop`, and removes only clean, inactive worktrees for closed or merged pull requests.

Arbitrary branch continuation and fork pull requests are outside this plugin's scope.

## Requirements

- OpenCode V1
- Herdr 0.9.1
- Herdr's OpenCode integration
- Git
- GitHub CLI (`gh`), authenticated for PR dispatch and metadata maintenance
- Node.js 20 or newer
- `pnpm` for installing dependencies in new worktrees

Install Herdr's OpenCode integration once:

```sh
herdr integration install opencode
```

## Install

```sh
cd ~/Work/herdr-ops/opencode
npm ci
npm run typecheck
npm run build
```

Register the resulting `dist/index.js` in `~/.config/opencode/opencode.json` using an absolute `file://` URL, then restart OpenCode:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/YOUR_USER/Work/herdr-ops/opencode/dist/index.js"
  ]
}
```

The plugin registers `/feature`, its Build-agent settings, and its dispatch tool at runtime. Do not install a separate command file or agent definition.

## Model Selection

The implementor inherits the active provider/model from the orchestrator session
that invokes `/feature`. Different sessions can dispatch different models, and no
separate implementor model setting is required. OpenCode's configured `model` is
used as a fallback when the session does not provide one.

## Usage

Run `/feature` in the same conversation as the settled plan. The command is explicit authorization; ordinary conversation cannot dispatch. The primary checkout must be clean unless the user explicitly approves `allowDirtyRoot`, and the plugin never resets or repairs it.

When the settled scope explicitly contains independent outcomes, one `/feature` invocation dispatches them as an ordered batch of up to eight worktrees. Dispatches run sequentially, and a validation, setup, or launch failure for one feature does not block the remaining features. A normal single-feature dispatch uses the same path as a one-item batch. Cohesive changes remain one feature, and unrelated backlog is not inferred from earlier plans.

To continue an existing pull request, include its URL or number in the invocation:

```text
/feature continue https://github.com/OWNER/REPOSITORY/pull/123
```

The plugin resolves the open pull request with `gh`, freshly fetches its head from `origin`, and creates or safely reuses a linked worktree on that exact branch. It configures `origin/<branch>` as the upstream and instructs the implementor to push completed commits to the existing pull request instead of creating another branch or pull request. Closed, merged, unrelated, or fork pull requests are rejected.

An existing worktree is reused only when it is clean, has no active agent, and has not diverged from the pull request. A worktree behind the remote is fast-forwarded; one with clean local commits ahead of the remote is preserved. Prunable worktree registrations are repaired when possible; unrepaired registrations are rejected rather than automatically pruning a potentially unavailable mount. A surviving local PR branch without a registered worktree is verified against the fetched PR head before Herdr recreates its linked worktree; branches with divergent commits are rejected rather than reset.

The default base is the freshly fetched branch advertised by `origin/HEAD`. An explicit base may be supplied when needed. All commands run on the host owning the checkout, which is also the supported SSH setup.

The batch request and ordered results are recorded in `<git-common-dir>/opencode-herdr-dispatch/handoffs.jsonl`. Failed features include any workspace, pane, or agent identifiers already created. A submitted plan whose agent does not become working is not reported as dispatched and is never retried automatically.

Agents in linked worktrees receive the implementation instructions and cannot invoke `/feature` recursively.

OpenCode root-session titles are synchronized to their Herdr tabs, including retrying while Herdr registers the agent. Titles owned by the plugin are cleared on disposal only when the tab still has that title. Dispatch lifecycle events are emitted through OpenCode application logs; implementation plans and environment file contents are not logged.

## Development

Build and typecheck the plugin:

```sh
npm run typecheck
npm run build
```

Run the real end-to-end workflow with a running Herdr server, OpenCode provider credentials, the configured plugin, and Herdr's OpenCode integration:

```sh
npm run test:e2e
```

The E2E workflow creates a disposable repository, worktree, pane, and Build agent and may incur model usage. Set `E2E_MODEL=provider/model-id` or `E2E_TIMEOUT_MS=<milliseconds>` when needed.

Repository maintenance runs immediately and every minute. PR sidebar metadata is reported with a two-hour TTL. Because continued pull requests use their actual head branch, the existing cleanup pass recognizes them after closure or merge. Cleanup skips dirty worktrees and workspaces with active agents, requires the worktree commit to match the closed pull request head, retains the local branch, and never uses forced worktree removal.
