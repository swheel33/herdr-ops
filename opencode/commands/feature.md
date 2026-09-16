---
description: Dispatch the agreed plan to a Herdr implementation worktree.
subtask: false
---

Dispatch the agreed scope from this conversation, applying later user corrections: `$ARGUMENTS`.

The plugin registers the complete command at runtime in `src/workflow.ts`; do not install this file separately. A plugin-issued, single-use authorization is required to call the dispatch tool. The primary session may also work directly; the new worktree always starts the built-in Build agent using the configured implementation model and variant.
