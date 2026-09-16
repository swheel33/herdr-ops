#!/usr/bin/env bun
import { resolveRef } from "./github"

const args = process.argv.slice(2)
if (!args.length || args.includes("--help") || args.includes("-h")) {
  console.log(`ghpr — a GitHub pull request, in one terminal pane

Usage:
  ghpr https://github.com/owner/repo/pull/123
  ghpr owner/repo#123
  ghpr 123                     Use the current checkout's repository
  ghpr --demo                  Preview the UI without GitHub access

Requires Bun and authenticated GitHub CLI (gh auth login).
Read-only. Scroll with the mouse or keyboard; press h inside for help.`)
  process.exit(0)
}
try {
  if (args.length !== 1) throw new Error("Expected one PR reference. See ghpr --help.")
  if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error("ghpr needs an interactive terminal.")
  const demo = args[0] === "--demo"
  const ref = demo ? { repo: "acme/frontend", number: 861, url: "https://github.com/acme/frontend/pull/861" } : await resolveRef(args[0])
  const { start } = await import("./app")
  await start(ref, demo)
} catch (error) {
  console.error(`ghpr: ${(error as Error).message}`)
  process.exit(1)
}
