# opencode-herdr-dispatch

An OpenCode plugin for turning one agreed implementation plan into a background Herdr worktree and OpenCode Build agent.

## Scope

The plugin intentionally handles one workflow:

1. `/feature` authorizes one dispatch.
2. The plugin creates one new branch and linked worktree.
3. It starts one Build agent in a 70/30 agent and shell layout.
4. It delivers the plan and waits for the agent to begin working.
5. It reports `dispatched` only after that working state is confirmed.
6. It periodically refreshes pull-request metadata, safely advances local `develop`, and removes only clean, inactive worktrees for closed or merged pull requests.

Batch dispatches and existing-branch continuation are outside this plugin's scope.

## Requirements

- OpenCode V1
- Herdr 0.9.0
- Herdr's OpenCode integration
- Git
- Node.js 20 or newer

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

Repository maintenance runs immediately and every five minutes. PR sidebar metadata is reported with a two-hour TTL. Cleanup skips dirty worktrees and workspaces with active agents, and never uses forced worktree removal.
