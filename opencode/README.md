# Same-session Herdr feature worktrees (OpenCode v2)

This OpenCode v2 plugin lets an agent request a Herdr feature worktree before implementation. It moves the **existing** root session into that checkout, resumes its ID in a new Herdr workspace, and focuses it. No plan mode, copied plan, or second implementor session is needed. The old Herdr tab is closed only when it contains that conversation alone **and** the primary workspace has another tab. Otherwise it stays open on OpenCode's blank home view, so the primary workspace and its linked worktrees remain available.

## Install

Install OpenCode v2 and Herdr's OpenCode integration on the host that owns the checkout. The `opencode` command visible to Herdr panes must resolve to v2. From this directory:

```sh
npm ci
npm run typecheck
npm run build
```

Register the server half in `~/.config/opencode/opencode.json(c)` (preserving other settings):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///home/YOUR_USER/Work/herdr-ops/opencode"]
}
```

Register the TUI half and Herdr's v2 TUI integration in `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "./herdr-opencode",
    "file:///home/YOUR_USER/Work/herdr-ops/opencode"
  ]
}
```

The `./herdr-opencode` entry points at Herdr's managed integration, relative to the global config. Run `herdr integration install opencode` if it is missing. Restart the OpenCode service and existing panes after installing or rebuilding both plugin halves. No project `AGENTS.md` changes are needed. V1 sessions cannot be relocated into v2: start a new v2 conversation.

To keep the terminal-derived appearance from a V1 `"theme": "system"` setting, add `"theme": { "name": "system", "mode": "system" }` to `cli.json`. V2 does not read V1's `tui.json` theme setting.

## End-to-end verification

From a Herdr-managed pane with the CLI plugin registered and OpenCode v2 available, run:

```sh
cd opencode
npm ci
npm run test:e2e
```

The runner builds the plugin and exercises an agent-requested handoff in two disposable repositories: one with only the originating primary tab, and one with a spare tab. It verifies the agent's tool request, the linked worktree and base commit, the **same session ID** and original message after the move, implementation in the new checkout, and the appropriate old-tab behavior. It then removes its sessions, Herdr workspaces, and worktrees without touching existing workspaces. The command prints a JSON result path under `/tmp/opencode/herdr-feature-e2e/`; the receipt includes resource IDs, checks, observations, and cleanup results. On failure, inspect that receipt; resources that could not be safely cleaned are retained for manual inspection. Restart existing OpenCode panes after rebuilding before using the new plugin interactively.

Run `npm run test:metadata-e2e` for a deterministic end-to-end check of the PR sidebar reporter and tab-title CLI commands against disposable fake Herdr, Git, and GitHub executables. It prints a repeatable JSON receipt under `/tmp/opencode/herdr-metadata-e2e/` with the reported tokens and tab renames. It does not change live workspaces.

To exercise a running named Herdr session instead of the current one, set `HERDR_E2E_SESSION=<name>`. The server-side plugin discovers the conversation across running local Herdr sessions; the TUI uses its pane's inherited socket. When testing a worktree checkout before installing its TUI plugin, set `HERDR_E2E_CLI_PLUGIN` to the installed copy's absolute path (the TUI code must be compatible). Set `HERDR_E2E_ELIGIBILITY_ONLY=1` to verify discovery against real Herdr agents without attempting the handoff; this is useful before the server and TUI plugins are installed from the same checkout. The JSON receipt records these selections.

## Use

Ask for a feature or fix in a Herdr-hosted root OpenCode v2 conversation in the primary checkout. The plugin instructs the agent to call `herdr_start_feature` before implementation; once its turn finishes, the TUI moves the session into the worktree and prompts it to continue. The primary checkout must be clean. The new branch starts at a freshly fetched `origin` default commit, or local `HEAD` when there is no origin. Ignored `.env` files are symlinked from the primary checkout, and `pnpm install --frozen-lockfile` runs when there is a `pnpm-lock.yaml`. Read-only questions and explicit in-place edits do not trigger this workflow.

`/feature` remains available as a manual fallback, with an optional branch argument, while the automatic handoff is being adopted. It is not required for ordinary feature work.

To resume an existing same-repository open pull request, use `/feature continue 123` or `/feature continue https://github.com/OWNER/REPO/pull/123`. A clean, closed worktree can be reopened; already-open or stale worktrees require manual inspection. Otherwise its branch is verified against the fetched PR head before a new worktree is created.

The previous V1 plugin's background batch dispatch and automatic worktree cleanup are not part of this same-session CLI command. Manage completed worktrees explicitly with Herdr; this command never force-removes uncommitted changes. The server plugin refreshes the PR/branch sidebar badges for linked workspaces every minute (including named Herdr sessions), and the CLI plugin synchronizes OpenCode conversation titles to their Herdr tabs. Restart the OpenCode service and existing panes after rebuilding to enable both.

If a step fails, the toast includes any worktree and workspace already created. In particular, if the move succeeded but the new pane did not attach, resume the session manually from the reported worktree using `opencode <worktree> --session <session-id>`; do not blindly request another handoff.
