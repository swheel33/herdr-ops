import { execFile as execFileCallback } from "node:child_process"
import { lstat, mkdir, readlink, realpath, stat, symlink } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

import { Plugin } from "@opencode/plugin/tui"
import { Feature } from "./rpc.js"

const execFile = promisify(execFileCallback)

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile(command, args, { cwd, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return run("git", args, cwd)
}

async function isAncestor(cwd: string, earlier: string, later: string): Promise<boolean> {
  try {
    await git(cwd, "merge-base", "--is-ancestor", earlier, later)
    return true
  } catch (error) {
    if ((error as { code?: string | number }).code === 1) return false
    // execFile sets the numeric exit code on a failed Git invocation.
    throw error
  }
}

async function herdr(cwd: string, ...args: string[]): Promise<Record<string, any>> {
  const result = JSON.parse(await run("herdr", args, cwd)) as { result?: Record<string, any> }
  if (!result.result) throw new Error(`Herdr returned no result for ${args[0]} ${args[1]}`)
  return result.result
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 38).replace(/-$/g, "") || "work"
}

async function baseCommit(root: string): Promise<string> {
  const remotes = (await git(root, "remote")).split("\n")
  if (!remotes.includes("origin")) return git(root, "rev-parse", "HEAD")
  const response = await git(root, "ls-remote", "--symref", "origin", "HEAD")
  const branch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(response)?.[1]
  if (!branch) throw new Error("origin has no default branch; repair origin/HEAD before starting a feature")
  await git(root, "fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
  return git(root, "rev-parse", `refs/remotes/origin/${branch}`)
}

async function pullRequest(root: string, reference: string): Promise<{ branch: string; commit: string; url: string }> {
  const repo = JSON.parse(await run("gh", ["repo", "view", "--json", "nameWithOwner"], root)) as { nameWithOwner: string }
  const pr = JSON.parse(await run("gh", ["pr", "view", reference.replace(/^#(?=\d+$)/, ""), "--json", "url,state,headRefName,headRefOid,isCrossRepository,headRepository"], root)) as {
    url: string; state: string; headRefName: string; headRefOid: string
    isCrossRepository: boolean; headRepository?: { nameWithOwner: string }
  }
  if (pr.state !== "OPEN" || pr.isCrossRepository || pr.headRepository?.nameWithOwner !== repo.nameWithOwner) {
    throw new Error("Only open pull requests from this repository can be continued")
  }
  const branch = pr.headRefName
  await git(root, "check-ref-format", "--branch", branch)
  await git(root, "fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
  const commit = await git(root, "rev-parse", `refs/remotes/origin/${branch}`)
  if (commit !== pr.headRefOid) throw new Error("Pull request head changed during fetch; try again")
  return { branch, commit, url: pr.url }
}

async function existingBranch(root: string, branch: string, remote: string): Promise<void> {
  let local: string
  try {
    local = await git(root, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`)
  } catch {
    return
  }
  if (local === remote) return
  if (await isAncestor(root, local, remote)) {
    await git(root, "update-ref", `refs/heads/${branch}`, remote, local)
    return
  }
  if (!await isAncestor(root, remote, local)) throw new Error(`Local branch ${branch} has diverged from the pull request`)
}

async function branchCommit(root: string, branch: string): Promise<{ base: string; upstream?: string; existing: boolean }> {
  let local: string | undefined
  try {
    local = await git(root, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`)
  } catch {
    // The branch may only exist on origin, or may be a new name.
  }
  const remotes = (await git(root, "remote")).split("\n")
  if (remotes.includes("origin")) {
    const head = await git(root, "ls-remote", "--heads", "origin", `refs/heads/${branch}`)
    if (head) {
      await git(root, "fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`)
      const remote = await git(root, "rev-parse", `refs/remotes/origin/${branch}`)
      if (local && !await isAncestor(root, local, remote) && !await isAncestor(root, remote, local)) {
        throw new Error(`Local branch ${branch} has diverged from origin/${branch}`)
      }
      return { base: local && await isAncestor(root, remote, local) ? local : remote, upstream: `origin/${branch}`, existing: true }
    }
  }
  if (local) return { base: local, existing: true }
  return { base: await baseCommit(root), existing: false }
}

async function linkEnvironment(root: string, tree: string): Promise<void> {
  const { stdout } = await execFile("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ":(glob).env", ":(glob).env.*", ":(glob)**/.env", ":(glob)**/.env.*"], { cwd: root, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 })
  for (const relative of stdout.toString().split("\0").filter(Boolean)) {
    const segments = relative.split("/")
    const name = segments.at(-1)!
    if (segments.some((part) => [".git", ".herdr", ".worktrees", "node_modules"].includes(part)) || name.endsWith(".example")) continue
    const source = path.join(root, relative)
    const destination = path.join(tree, relative)
    const sourceStat = await lstat(source)
    if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) continue
    try {
      const destinationStat = await lstat(destination)
      if (destinationStat.isSymbolicLink() && path.resolve(path.dirname(destination), await readlink(destination)) === source) continue
      throw new Error(`Refusing to replace worktree environment file ${relative}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(path.dirname(destination), { recursive: true })
    await symlink(source, destination)
  }
}

async function installDependencies(tree: string): Promise<void> {
  try {
    await stat(path.join(tree, "pnpm-lock.yaml"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  await run("pnpm", ["install", "--frozen-lockfile"], tree)
}

function message(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const stderr = "stderr" in error ? String(error.stderr).trim() : ""
  return stderr || error.message
}

export default Plugin.define({
  id: "herdr.feature.move",
  setup(ctx) {
    let moving = false
    let resumeAfterMove = false
    const feature = ctx.client.rpc(Feature)
    const stop = ctx.data.on("session.execution.succeeded", (event) => {
      const sessionID = event.data.sessionID
      const route = ctx.ui.router.current()
      if (moving || route.type !== "session" || route.sessionID !== sessionID) return
      void (async () => {
        const session = await ctx.client.session.get({ sessionID })
        const request = await feature.take({ sessionID }, { location: session.location }) as { pending: boolean; branch?: string; pr?: string }
        if (!request.pending) return
        const branch = request.branch || `feature/${slug(session.title ?? "work")}-${Date.now().toString(36)}`
        resumeAfterMove = true
        ctx.keymap.dispatch("herdr.feature", request.pr ? `continue ${request.pr}` : branch)
      })().catch((error) => ctx.ui.toast.show({ title: "Feature handoff failed", message: message(error), variant: "error" }))
    })
    const slot = ctx.ui.slot({ append: "app", render: () => {
      ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "herdr.feature",
        title: "Start feature in a Herdr worktree",
        group: "Herdr",
        palette: true,
        slash: { name: "feature", arguments: true },
        enabled: () => process.env.HERDR_ENV === "1" && !moving,
        run: async (input) => {
          if (moving) return
          moving = true
          let workspace: string | undefined
          let tree: string | undefined
          let sessionID: string | undefined
          try {
            const route = ctx.ui.router.current()
            if (route.type !== "session") throw new Error("Open a root conversation before starting a feature")
            sessionID = route.sessionID
            const session = await ctx.client.session.get({ sessionID })
            if (session.parentID) throw new Error("/feature requires a root conversation")
            const root = await realpath(await git(session.location.directory, "rev-parse", "--show-toplevel"))
            const common = await realpath(path.resolve(root, await git(root, "rev-parse", "--git-common-dir")))
            const localGit = await realpath(path.resolve(root, await git(root, "rev-parse", "--git-dir")))
            if (common !== localGit) throw new Error("This conversation is already in a linked worktree")
            const initialTab = process.env.HERDR_TAB_ID
            const initialPane = process.env.HERDR_PANE_ID
            if (!initialTab || !initialPane) throw new Error("Start OpenCode inside a Herdr pane")
            const currentPane = (await herdr(root, "pane", "get", initialPane)).pane
            if (currentPane?.agent_session?.value !== sessionID || await realpath(await git(currentPane.cwd, "rev-parse", "--show-toplevel")) !== root) {
              throw new Error("The selected conversation must belong to this Herdr pane and checkout")
            }
            if (await git(root, "status", "--porcelain", "--untracked-files=all")) {
              throw new Error("The primary checkout is dirty; commit or move its changes before creating a feature")
            }
            const requested = input?.trim() ?? ""
            const continuing = requested.startsWith("continue ")
            const pr = continuing ? await pullRequest(root, requested.slice("continue ".length).trim()) : undefined
            const suggested = `feature/${slug(session.title ?? "work")}-${Date.now().toString(36)}`
            const branch = pr?.branch ?? (requested || await ctx.ui.dialog.prompt({ title: "New feature branch", placeholder: suggested }))
            if (branch === undefined) return
            const selected = branch.trim() || suggested
            await git(root, "check-ref-format", "--branch", selected)
            if (await git(root, "branch", "--show-current") === selected) throw new Error(`Branch ${selected} is checked out in the primary checkout; cannot open it in another worktree`)
            const title = session.title || selected
            const target = pr ? { base: pr.commit, upstream: `origin/${selected}`, existing: true } : await branchCommit(root, selected)
            const base = target.base
            let existing: { path: string; open_workspace_id?: string; is_prunable?: boolean } | undefined
            if (target.existing) {
              const worktrees = (await herdr(root, "worktree", "list", "--cwd", root)).worktrees as Array<{ branch: string; path: string; open_workspace_id?: string; is_prunable?: boolean }>
              existing = worktrees.find((tree) => tree.branch === selected)
              if (existing?.is_prunable || existing?.open_workspace_id) throw new Error("The branch worktree is already open or stale; inspect it before continuing")
              if (existing && await git(existing.path, "status", "--porcelain", "--untracked-files=all")) {
                throw new Error("The branch worktree has uncommitted changes")
              }
              if (existing) {
                const local = await git(existing.path, "rev-parse", "HEAD")
                if (local !== base && await isAncestor(existing.path, local, base)) {
                  await git(existing.path, "merge", "--ff-only", base)
                } else if (local !== base && !await isAncestor(existing.path, base, local)) {
                  throw new Error("The branch worktree has diverged from its remote head")
                }
              } else if (target.upstream) {
                await existingBranch(root, selected, base)
              }
            }
            const created = existing
              ? await herdr(root, "worktree", "open", "--cwd", root, "--path", existing.path, "--label", title, "--no-focus")
              : await herdr(root, "worktree", "create", "--cwd", root, "--branch", selected, "--base", base, "--label", title, "--no-focus")
            workspace = created.workspace?.workspace_id
            tree = created.worktree?.path ?? created.workspace?.worktree_path
            const pane = created.root_pane?.pane_id
            if (!workspace || !tree || !pane) throw new Error("Herdr created a worktree but did not return its workspace, path, and pane IDs")
            tree = await realpath(tree)
            if (await git(tree, "rev-parse", "--abbrev-ref", "HEAD") !== selected || (!pr && await git(tree, "rev-parse", "HEAD") !== base)) {
              throw new Error("Herdr worktree does not match the selected branch and base")
            }
            if (target.upstream) await git(tree, "branch", "--set-upstream-to", target.upstream, selected)
            await linkEnvironment(root, tree)
            if (!existing) await installDependencies(tree)
            await ctx.client.session.move({ sessionID, directory: tree })
            let arrived = false
            for (let i = 0; i < 60; i++) {
              const current = await ctx.client.session.get({ sessionID })
              if (current.location.directory === tree) { arrived = true; break }
              await new Promise((resolve) => setTimeout(resolve, 200))
            }
            if (!arrived) throw new Error("The session move has not completed; inspect the session before retrying")
            const name = `f-${slug(selected).slice(0, 15)}-${Date.now().toString(36)}`.slice(0, 32)
            await herdr(root, "agent", "start", name, "--kind", "opencode", "--pane", pane, "--timeout", "60000", "--", "--session", sessionID)
            const agent = (await herdr(root, "agent", "get", name)).agent
            if (agent?.agent_session?.value !== sessionID) throw new Error("New pane has not reported the original session; old tab remains open")
            if (resumeAfterMove) {
              await ctx.client.session.prompt({ sessionID, text: "The requested feature worktree is ready. Continue implementing the original user request in this worktree now.", resume: true })
            }
            ctx.ui.router.navigate({ type: "home" })
            await herdr(root, "workspace", "focus", workspace)
            // Herdr closing the last primary tab can close its linked workspaces.
            // Keep that tab on OpenCode's blank home screen instead.
            try {
              const oldTab = (await herdr(root, "tab", "get", initialTab)).tab
              const tabs = (await herdr(root, "tab", "list", "--workspace", currentPane.workspace_id)).tabs as Array<{ tab_id: string }>
              if (oldTab?.pane_count === 1 && tabs.some((tab) => tab.tab_id !== initialTab)) {
                await herdr(root, "tab", "close", initialTab)
              }
            } catch {
              // The original tab stays on OpenCode home when closing is unavailable.
            }
            ctx.ui.toast.show({ title: "Feature ready", message: `${selected} · ${tree}`, variant: "success" })
          } catch (error) {
            ctx.ui.toast.show({ title: "Feature move stopped", message: `${message(error)}${sessionID ? ` · Session: ${sessionID}` : ""}${tree ? ` · Worktree: ${tree}` : ""}${workspace ? ` · Workspace: ${workspace}` : ""}`, variant: "error", duration: 12000 })
          } finally {
            moving = false
            resumeAfterMove = false
          }
        },
      }],
      }))
      return null
    } })
    return () => { stop(); slot() }
  },
})
