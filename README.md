# herdr-ops

Small, host-specific tools for Herdr-based coding workspaces.

## Components

- `opencode/`: OpenCode workflow, dispatch, maintenance, sidebar metadata, and tab titles.
- `herdr/`: small Herdr adapter for an on-demand `ghpr` split pane.
- `cli/ghpr/`: standalone GitHub pull request viewer built with Bun, React, and OpenTUI.

The tools are intentionally separate packages. They share one repository without introducing a workspace manager or a cross-package runtime dependency.

## Local Setup

The OpenCode plugin owns maintenance and sidebar refresh at startup and every
15 minutes, coordinated by repository locks. The Herdr adapter has no timers.
For SSH, install and register these components on the host owning the checkout.

Original Git histories are retained in local `archive/dispatch/*` and
`archive/ghpr/*` branches. Include those branches when publishing the repository.

### `ghpr`

```sh
cd cli/ghpr
bun install
bun run typecheck
bun run build
```

Run it directly with an explicit pull request reference:

```sh
bun run dev owner/repo#123
```

### OpenCode dispatch

```sh
cd opencode
npm ci
npm test
npm run typecheck
npm run build
```

Register the resulting `dist/index.js` in `~/.config/opencode/opencode.json` using an absolute `file://` URL, then restart OpenCode.

### Herdr PR plugin

Build `ghpr` first, then link the Herdr plugin:

```sh
herdr plugin link "$HOME/Work/herdr-ops/herdr"
herdr plugin enable herdr-ops.pr
```

The plugin uses Herdr `0.9.0` workspace metadata tokens. Add its action to `~/.config/herdr/config.toml` as shown below, keeping the existing `prefix+g` lazygit and `prefix+p` previous-tab bindings:

```toml
[[keys.command]]
key = "prefix+alt+p"
type = "plugin_action"
command = "herdr-ops.pr.open"
description = "open pull request"

[ui.sidebar.spaces]
rows = [
  ["workspace"],
  [
    { token = "branch", dim = true },
    { token = "$pr_open", fg = "#3fb950", bold = true },
    { token = "$pr_draft", fg = "#d29922", bold = true },
    { token = "$pr_merged", fg = "#a371f7", bold = true },
    { token = "$pr_closed", fg = "#f85149", bold = true },
  ],
]
```

PR tokens are display-only. The pane is opened only by the configured keybinding or the Herdr action API. Restart the Herdr server after upgrading the client so its protocol matches the mise-managed binary; do not stop a live server if doing so would interrupt active panes.

## Herdr Version

This checkout expects Herdr `0.9.0`. Omarchy packages Herdr system-wide, but this machine uses the user-level mise override:

```sh
mise use -g herdr@0.9.0
herdr --version
```
