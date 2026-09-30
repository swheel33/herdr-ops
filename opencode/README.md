# Herdr feature worktrees (OpenCode v2)

This OpenCode v2 plugin lets an agent request a Herdr feature worktree before implementation. It moves the **existing** root session into that checkout and resumes its ID in a new Herdr workspace. It focuses the new workspace only if you are still viewing the original conversation in the focused Herdr pane when setup finishes; switching to another workspace, tab, pane, or conversation preserves your focus. No plan mode, copied plan, or second implementor session is needed. The old Herdr tab is closed only when it still shows that conversation alone **and** the primary workspace has another tab. Otherwise it stays open on OpenCode's blank home view (or the different conversation you selected), so the primary workspace and its linked worktrees remain available.

For multiple independent features, it **forks the full conversation history once per feature and moves each fork into its own worktree**, keeping the original conversation in the primary checkout. Each fork receives its specific assignment and runs independently with the inherited context.

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

The runner builds the plugin and exercises agent-requested handoffs in disposable repositories: one with only the originating primary tab, one with a spare tab, and one with an existing branch on a local bare `origin`. It verifies the agent's tool request, the linked worktree and base commit, the **same session ID** and original message after the move, implementation in the new checkout, and the appropriate old-tab behavior. The existing-branch scenario also verifies preserved branch content, its upstream, and a push back to the same remote branch. It then removes its sessions, Herdr workspaces, and worktrees without touching existing workspaces. The command prints a JSON result path under `/tmp/opencode/herdr-feature-e2e/`; the receipt includes resource IDs, checks, observations, and cleanup results. On failure, inspect that receipt; resources that could not be safely cleaned are retained for manual inspection. Restart existing OpenCode panes after rebuilding before using the new plugin interactively.

Run `npm run test:metadata-e2e` for a deterministic end-to-end check of the PR sidebar reporter and tab-title CLI commands against disposable fake Herdr, Git, and GitHub executables. It prints a repeatable JSON receipt under `/tmp/opencode/herdr-metadata-e2e/` with the reported tokens and tab renames. It does not change live workspaces.

Run `npm run test:focus-e2e` for a deterministic workflow check using real disposable Git worktrees, a fake Herdr executable, and a CLI-context harness. It verifies following the original pane, preserving focus after switching Herdr panes during setup, and leaving another OpenCode conversation and its tab untouched. It does not change live workspaces and prints a JSON receipt with commands and navigation under `/tmp/opencode/herdr-focus-e2e/`.

Run `npm run test:batch-e2e` for a deterministic workflow check spanning the server tool, RPC handoff, CLI plugin, and real disposable Git worktrees. Herdr and the OpenCode session host are fixtures. It verifies three independent branches with full-history session forks, moves of the forks rather than the original, exact task delivery, an untouched primary checkout, validation, duplicate-event handling, and continued startup after one feature fails. Its repeatable JSON receipt under `/tmp/opencode/herdr-batch-e2e/` records sessions, prompts, results, and CLI commands.

Run `npm run test:fork-e2e` against a running OpenCode v2 service to verify the actual session API. It records planning context, forks the full history three times, moves each fork into a real disposable Git worktree, and verifies the inherited history and original session location. It does not invoke a model. The repeatable receipt under `/tmp/opencode/herdr-fork-e2e/` includes session IDs and inherited history.

Run `npm run test:pruning-e2e` to exercise the cleanup loop against disposable fake Herdr, Git, and GitHub executables. Its JSON receipt under `/tmp/opencode/herdr-pruning-e2e/` records every command and removed workspace. It does not change live workspaces.

To exercise a running named Herdr session instead of the current one, set `HERDR_E2E_SESSION=<name>`. The server-side plugin discovers the conversation across running local Herdr sessions; the TUI uses its pane's inherited socket. When testing a worktree checkout before installing its TUI plugin, set `HERDR_E2E_CLI_PLUGIN` to the installed copy's absolute path (the TUI code must be compatible). Set `HERDR_E2E_ELIGIBILITY_ONLY=1` to verify discovery against real Herdr agents without attempting the handoff; this is useful before the server and TUI plugins are installed from the same checkout. The JSON receipt records these selections.

## Use

Ask for a feature or fix in a Herdr-hosted root OpenCode v2 conversation in the primary checkout. The plugin instructs the agent to call `herdr_start_feature` before implementation; once its turn finishes, the TUI moves the session into the worktree and prompts it to continue. Mention an existing PR number or URL to continue its head branch, or an exact branch name to continue that branch; the agent passes `pr` or `branch` to the tool respectively. Ambiguous references should be clarified rather than guessed. The primary checkout must be clean. A new branch starts at a freshly fetched `origin` default commit, or local `HEAD` when there is no origin. An existing branch starts at its tip (fetching its origin head when available), with divergence rejected. Ignored `.env` files are symlinked from the primary checkout, and `pnpm install --frozen-lockfile` runs when there is a `pnpm-lock.yaml`. Read-only questions and explicit in-place edits do not trigger this workflow. The handoff does not commit or push changes; push the resulting commit to the same branch to update the PR.

`/feature` remains available as a manual fallback, with an optional existing or new branch argument, while the automatic handoff is being adopted. It is not required for ordinary feature work.

### Multiple features from one request

Ask, for example: “Fix the asset caching, ChangeText, and SDK diagnostics issues in three separate branches. Reproduce each locally and open one PR per fix.” The agent queues a single batch:

```json
{
  "features": [
    { "branch": "fix/asset-caching", "task": "Fix missing-asset routing and caching. Reproduce and verify locally, then commit, push, and open a PR." },
    { "branch": "fix/change-text", "task": "Reproduce and harden ChangeText and transaction-panel text. Verify locally, then commit, push, and open a PR." },
    { "branch": "fix/sdk-diagnostics", "task": "Improve SDK transport diagnostics and finish severity cleanup. Verify locally, then commit, push, and open a PR." }
  ]
}
```

Each fork inherits the original conversation's full projected history through OpenCode's native fork API, then uses the same session-move mechanism as a single feature to relocate into its worktree. The task identifies which part of the original request that fork should implement; it does not replace or summarize the inherited history. Each fork gets a distinct session ID, and subsequent messages stay in their respective sessions. Branch names are optional; omitted names are generated from the task. Each entry can specify an existing `pr` instead of `branch`. Do not combine `features` with top-level `branch` or `pr`, or queue repeated calls in the same turn.

After the requesting turn finishes, workspaces are prepared sequentially and each session starts immediately, allowing implementation to overlap. The original conversation and tab stay open, focus stays where you left it, and a synthetic message records each started session/worktree or failure. A failed entry does not prevent the remaining entries from starting. Inspect any reported resources before retrying failed entries. The handoff itself does not commit, push, or create PRs; those instructions are carried in each task for its implementor.

To resume an existing same-repository open pull request, use `/feature continue 123` or `/feature continue https://github.com/OWNER/REPO/pull/123`. A clean, closed worktree can be reopened; already-open or stale worktrees require manual inspection. Otherwise its branch is verified against the fetched PR head before a new worktree is created.

The `/feature` CLI command remains a single-session move; batch starts use the tool's `features` array. The server plugin runs one serialized maintenance cycle at startup and every minute: refresh `develop`, refresh PR/branch sidebar badges, then check linked worktrees for merged or closed same-repository PRs (including named Herdr sessions). Overlapping cycles for the same primary repository in the server are skipped, and a failed step does not prevent the remaining steps.

The `develop` refresh fetches `origin/develop` and fast-forwards the primary checkout only when it is already on `develop`, has no staged, tracked, or untracked changes or in-progress Git operation, and no active agent is working there. If agent discovery fails, it leaves the checkout untouched. Repositories without `origin` or remote `develop` are skipped. Local commits ahead of or diverged from the remote are preserved; the plugin never switches branches, stashes, rebases, resets, or pushes. It does not update `develop` while another branch is checked out in the primary checkout.

Pruning removes open workspaces only when no agent is working and the checkout has no staged, tracked, or untracked changes; it never force-removes a checkout. Worktrees without a terminal PR are left alone. The CLI plugin synchronizes OpenCode conversation titles to their Herdr tabs. Restart the OpenCode service and existing panes after rebuilding to enable both.

Run `npm run test:maintenance-e2e` in `opencode/` to verify the maintenance cycle using disposable Git repositories and a local bare origin, with fixture Herdr/GitHub responses. The runner prints a JSON receipt under `/tmp/opencode/herdr-maintenance-e2e/` and removes its disposable repositories.

If a step fails, the toast includes any worktree and workspace already created. In particular, if the move succeeded but the new pane did not attach, resume the session manually from the reported worktree using `opencode <worktree> --session <session-id>`; do not blindly request another handoff.
