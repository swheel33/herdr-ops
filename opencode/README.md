# opencode-herdr-dispatch

An OpenCode plugin for turning one agreed implementation plan into a background Herdr worktree and OpenCode Build agent.

## Scope

The plugin intentionally handles one workflow:

1. `/feature` authorizes one dispatch.
2. The plugin creates one new branch and linked worktree.
3. It links ignored local environment files into the worktree.
4. It installs worktree dependencies with `pnpm install`.
5. It starts one Build agent in a 70/30 agent and shell layout.
6. It delivers the plan and waits for the agent to begin working.
7. It reports `dispatched` only after that working state is confirmed.
8. It periodically refreshes pull-request metadata, safely advances local `develop`, and removes only clean, inactive worktrees for closed or merged pull requests.

Batch dispatches and existing-branch continuation are outside this plugin's scope.

## Requirements

- OpenCode V1
- Herdr 0.9.0
- Herdr's OpenCode integration
- Git
- GitHub CLI (`gh`), authenticated for PR metadata maintenance
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

## Model Configuration

Configure the Build agent with plugin options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["file:///home/YOUR_USER/Work/herdr-ops/opencode/dist/index.js", {
      "implementor": { "model": "openai/gpt-5.6-luna-fast", "variant": "high" }
    }]
  ]
}
```

## Usage

Run `/feature` in the same conversation as the settled plan. The command is explicit authorization; ordinary conversation cannot dispatch. The primary checkout must be clean unless the user explicitly approves `allowDirtyRoot`, and the plugin never resets or repairs it.

The default base is the freshly fetched branch advertised by `origin/HEAD`. An explicit base may be supplied when needed. All commands run on the host owning the checkout, which is also the supported SSH setup.

The handoff and final result are recorded in `<git-common-dir>/opencode-herdr-dispatch/handoffs.jsonl`. Failed handoffs include any workspace, pane, or agent identifiers already created. A submitted plan whose agent does not become working is not reported as dispatched and is never retried automatically.

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

Repository maintenance runs immediately and every minute. PR sidebar metadata is reported with a two-hour TTL. Cleanup skips dirty worktrees and workspaces with active agents, and never uses forced worktree removal.
