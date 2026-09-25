# Same-session Herdr feature worktrees (OpenCode v2)

This is a terminal-only OpenCode v2 plugin. `/feature` creates a Herdr worktree after planning, moves the **existing** root session into that checkout, resumes its ID in a new Herdr workspace, and focuses it. There is no plan copy or second implementor session. The old Herdr tab is closed only when it contains that conversation alone **and** the primary workspace has another tab. Otherwise it stays open on OpenCode's blank home view, so the primary workspace and its linked worktrees remain available.

## Install

Install OpenCode v2 and Herdr's OpenCode integration on the host that owns the checkout. The `opencode` command visible to Herdr panes must resolve to v2. From this directory:

```sh
npm ci
npm run typecheck
npm run build
```

Register the Herdr v2 TUI integration and the CLI-only feature command in `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "./herdr-opencode",
    "file:///home/YOUR_USER/Work/herdr-ops/opencode"
  ]
}
```

The `./herdr-opencode` entry points at Herdr's managed integration, relative to the global config. Run `herdr integration install opencode` if it is missing. Restart OpenCode after installing or rebuilding the CLI plugin. V1 sessions cannot be relocated into v2: start a new v2 planning conversation.

To keep the terminal-derived appearance from a V1 `"theme": "system"` setting, add `"theme": { "name": "system", "mode": "system" }` to `cli.json`. V2 does not read V1's `tui.json` theme setting.

## Use

Plan in a Herdr-hosted root OpenCode v2 conversation in the primary checkout, then run `/feature`. Supply a Git branch name as an optional argument (`/feature feature/my-change`); otherwise enter one in the prompt or accept the suggested name. The primary checkout must be clean. The new branch starts at a freshly fetched `origin` default commit, or local `HEAD` when there is no origin. Ignored `.env` files are symlinked from the primary checkout, and `pnpm install --frozen-lockfile` runs when there is a `pnpm-lock.yaml`.

To resume an existing same-repository open pull request, use `/feature continue 123` or `/feature continue https://github.com/OWNER/REPO/pull/123`. A clean, closed worktree can be reopened; already-open or stale worktrees require manual inspection. Otherwise its branch is verified against the fetched PR head before a new worktree is created.

The previous V1 plugin's background batch dispatch, PR metadata timer, and automatic worktree cleanup are not part of this same-session CLI command. Manage completed worktrees explicitly with Herdr; this command never force-removes uncommitted changes.

If a step fails, the toast includes any worktree and workspace already created. In particular, if the move succeeded but the new pane did not attach, resume the session manually from the reported worktree using `opencode <worktree> --session <session-id>`; do not blindly run `/feature` again.
