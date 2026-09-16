# ghpr

A GitHub pull request in one scrollable terminal pane. Built with Bun, React,
and OpenTUI. No tabs or dashboard.

## Run

Requires **Bun**, **GitHub CLI**, and an interactive Linux or macOS terminal.
Authenticate with `gh auth login` for private repositories and normal API limits.

```sh
bun install
bun run dev --demo
bun run dev https://github.com/owner/repo/pull/123
bun run dev owner/repo#123
bun run dev 123
```

A bare number uses the GitHub repository selected by `gh repo view` in the current
checkout (including any `gh repo set-default` selection). Use an explicit reference
when working with forks or multiple remotes. Only github.com is currently supported.

To put `ghpr` on your PATH:

```sh
bun link
ghpr owner/repo#123
```

Bun's global bin directory must be on PATH. The linked command runs the source
checkout, so updates take effect next time you launch it.

## The pane

- Compact header with title, state, author, branches, files changed, additions,
  deletions, and commit count.
- The PR description comes first, expanded by default.
- Recognized AI reviews next: Greptile and CodeRabbit summaries are grouped by
  provider, with the provider summary expanded. Other AI findings and inline
  threads appear below it as short, expandable previews.
- Comments next, collapsed by default: ordinary comments and inline threads
  appear newest first as short, expandable previews, with replies kept together.
- Review outcomes, reactions, resolved/outdated labels, and optional diff context.
  Bot HTML is cleaned up while useful severity labels and links are retained.
- Checks include Vercel deployment statuses and detail links. Failures and pending
  checks appear first; passing and skipped/neutral/cancelled groups are collapsed.
- Mouse-first action bar for comments, approval, squash merge, close, and reopen.
  Merge and close use a gh-style y/N confirmation prompt and refresh the PR afterward.

Vercel's generated deployment-table comment is hidden from the comment feed.
Other review-bot comments remain visible. Commit and timeline events are not
included, and there is no separate deployment section.

GitHub collections are paginated. Comments initially render the latest 30 entries
plus the pinned summary; press `m` for older entries. Comments and checks load
independently after the header. Refresh runs every two minutes and keeps previous
content if a section fails. Checks are cleared when a new head SHA is observed.

The first version does not reproduce every GitHub widget: project boards,
embedded media, all timeline-event-specific details, and required-check policy
are not implemented. Images are links; arbitrary GitHub HTML cannot render like a
browser. The original PR is always available with `o`.

## Controls

| Input | Action |
| --- | --- |
| Mouse wheel, arrows, Page Up/Down | Scroll |
| `j` / `k` | Scroll down/up |
| `g` / `G` | Top/bottom |
| `1` / `2` / `3` / `4`, or click a section heading | Toggle description / AI reviews / comments / checks |
| Click a comment heading or preview | Collapse/expand its body |
| Click a check group or diff-context label | Collapse/expand its contents |
| Click an in-PR comment link | Focus, expand, and scroll to that comment |
| Click another link | Open in browser |
| `m` | Show older comments |
| `r` | Refresh |
| Click action buttons | Comment, approve, merge, close, or reopen the PR |
| `y` / `n` after merge or close | Confirm / cancel the gh-style prompt |
| `o` | Open the PR on GitHub |
| `y` | Copy PR URL using terminal clipboard support |
| `h` / `?` | Toggle help |
| `q` / Ctrl+C | Quit |

For Herdr, the umbrella repository includes an optional Herdr plugin that reports
the current branch and pull request in the sidebar and opens this viewer on demand.
Run `ghpr <reference>` in an ordinary pane when the plugin is not installed.
Diffs can stay in Hunk or lazygit.

## Development

```sh
bun run typecheck
bun run build
bun dist/cli.js --demo
```

The build keeps dependencies external; retain `node_modules` alongside the project.
Use the synthetic `--demo` for visual development and
manually check a real PR for API integration. Actions are unavailable in `--demo`.
No credentials or PR data are saved by ghpr; the running process keeps its data
in memory and uses the authenticated GitHub CLI for mutations.
