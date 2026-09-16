# herdr-ops

Small, host-specific tools for Herdr-based coding workspaces.

## Components

- `opencode/`: OpenCode workflow and one-feature Herdr dispatch.
- `herdr/`: small Herdr adapter for an on-demand `ghpr` split pane.
- `cli/ghpr/`: standalone GitHub pull request viewer built with Bun, React, and OpenTUI.

The tools are intentionally separate packages. They share one repository without introducing a workspace manager or a cross-package runtime dependency.

## Local Setup

The OpenCode plugin owns the feature handoff only. The Herdr adapter has no timers.
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
npm run typecheck
npm run build
```

Register the resulting `dist/index.js` in `~/.config/opencode/opencode.json` using an absolute `file://` URL, then restart OpenCode.

### Herdr PR plugin

Build `ghpr` first, then install the committed full Herdr configuration and link the plugin:

```sh
cd ~/Work/herdr-ops
bun run --cwd cli/ghpr build
./herdr/setup.sh
```

`herdr/setup.sh` backs up an existing differing config, installs the committed config, enables `herdr-ops.pr`, and reloads the running Herdr server. It is safe to run again; an unchanged config is not backed up again. The config is based on Omarchy's `/usr/share/omarchy/config/herdr/config.toml` and includes the PR sidebar metadata, `prefix+e` Neovim popup, `prefix+g` Lazygit popup, `prefix+p` PR action, and tab navigation bindings.

PR tokens are display-only. The pane is opened only by the configured keybinding or the Herdr action API. Restart the Herdr server after upgrading the client so its protocol matches the mise-managed binary; do not stop a live server if doing so would interrupt active panes.

## Herdr Version

This checkout expects Herdr `0.9.0`. Omarchy packages Herdr system-wide, but this machine uses the user-level mise override:

```sh
mise use -g herdr@0.9.0
herdr --version
```
