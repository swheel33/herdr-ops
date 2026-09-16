import { createCliRenderer, RGBA, SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { execFile } from "node:child_process"
import { addComment, aiReviewFeed, approvePR, commentFeed, loadActivity, loadChecks, loadPR, mergePR, setPRState, type Activity, type Check, type PR, type Ref, type Sections } from "./github"
import { cleanMarkdown, commentPreview } from "./content"

const color = { bg: "#16181d", panel: "#1d2027", text: "#d5d8df", muted: "#9197a5", accent: "#a8c7fa", green: "#a6d5b0", red: "#f0a0a8", yellow: "#e7cb97" }
const syntax = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex(color.text) },
  "markup.heading": { fg: RGBA.fromHex(color.text), bold: true },
  "markup.link": { fg: RGBA.fromHex(color.accent), underline: true },
  "markup.raw": { fg: RGBA.fromHex(color.yellow) },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  comment: { fg: RGBA.fromHex(color.muted) },
  keyword: { fg: RGBA.fromHex(color.accent) },
  string: { fg: RGBA.fromHex(color.green) },
})

function age(date: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 60_000))
  if (!Number.isFinite(minutes)) return ""
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`
}
function status(state: string): [string, string] {
  if (["success", "approved", "merged"].includes(state)) return ["✓", color.green]
  if (["failure", "error", "timed_out", "action_required", "startup_failure", "changes_requested"].includes(state)) return ["✗", color.red]
  if (["neutral", "skipped", "cancelled", "inactive"].includes(state)) return ["–", color.muted]
  return ["●", color.yellow]
}
function Link({ url, children }: { url?: string; children: ReactNode }) {
  return <text selectable={false} fg={color.accent} wrapMode="word">{url ? <span link={{ url }}>{children} ↗</span> : children}</text>
}
function ActionButton({ label, onClick, disabled = false, danger = false }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  const fg = disabled ? color.muted : danger ? color.red : color.accent
  return <box border borderStyle="single" borderColor={fg} paddingX={1} flexShrink={0} onMouseUp={e => {
    if (!disabled && e.button === 0 && !e.isDragging) onClick()
  }}><text selectable={false} fg={fg}>{label}</text></box>
}
function entryId(id: string) {
  return `entry-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}
function containsEntry(item: Activity, id?: string): boolean {
  return Boolean(id && (item.id === id || item.replies?.some(reply => containsEntry(reply, id))))
}
function flattenEntries(item: Activity): Activity[] {
  return [item, ...(item.replies || []).flatMap(flattenEntries)]
}
function linkKey(raw: string, base: string) {
  try {
    const url = new URL(raw, base)
    if (!['https:', 'http:'].includes(url.protocol)) return
    return `${url.origin}${url.pathname}${url.hash}`
  } catch {
    return
  }
}
function Markdown({ body }: { body: string }) {
  const content = cleanMarkdown(body)
  return <markdown content={content} syntaxStyle={syntax} fg={color.text} conceal
    tableOptions={{ style: "columns", wrapMode: "word", columnFitter: "proportional", borders: false }} />
}
function Section({ title, children, count, defaultOpen = true, reveal = 0 }: { title: string; children: ReactNode; count?: number | string; defaultOpen?: boolean; reveal?: number }) {
  const [open, setOpen] = useState(defaultOpen)
  const shortcut = ["Description", "AI Reviews", "Comments", "Checks"].indexOf(title) + 1
  useEffect(() => { if (reveal > 0) setOpen(true) }, [reveal])
  useKeyboard(key => { if (key.name === String(shortcut)) setOpen(value => !value) })
  return <box flexDirection="column" flexShrink={0} marginBottom={1}>
    <text selectable={false} fg={color.muted} marginBottom={1} onMouseUp={e => {
      if (e.button === 0 && !e.isDragging) setOpen(!open)
    }}>{open ? "▾" : "▸"} {title}{count === undefined ? "" : ` · ${count}`}</text>
    {open && children}
  </box>
}
function Entry({ item, defaultOpen = false, summary = false, focusedId }: { item: Activity; defaultOpen?: boolean; summary?: boolean; focusedId?: string }) {
  const [expanded, setExpanded] = useState(defaultOpen)
  const [showCode, setShowCode] = useState(false)
  const hasBody = Boolean(item.body || item.replies?.length)
  const focused = focusedId === item.id
  useEffect(() => { if (containsEntry(item, focusedId)) setExpanded(true) }, [focusedId, item])
  return <box id={entryId(item.id)} flexDirection="column" flexShrink={0} marginBottom={1} paddingLeft={hasBody ? 1 : 0} backgroundColor={focused ? "#2b3444" : undefined}>
    <text selectable={false} wrapMode="word" fg={color.muted} onMouseUp={e => {
      if (hasBody && e.button === 0 && !e.isDragging) setExpanded(!expanded)
    }}><span fg={color.text}>{hasBody ? (expanded ? "▾ " : "▸ ") : "· "}{item.author}</span> {summary ? "summary · pinned" : item.action} · {age(item.date)}{item.replies?.length ? ` · ${item.replies.length} replies` : ""}</text>
    {item.context && <text fg={color.yellow} wrapMode="word">{item.context}</text>}
    {!expanded && item.body && <text selectable={false} fg={color.muted} wrapMode="word" onMouseUp={e => {
      if (e.button === 0 && !e.isDragging) setExpanded(true)
    }}>{commentPreview(item.body)}</text>}
    {expanded && hasBody && <box flexDirection="column" marginTop={1} gap={1}>
      {item.body && <Markdown body={item.body} />}
      {item.reactions && <text fg={color.muted}>{item.reactions}</text>}
      {item.code && <text selectable={false} fg={color.accent} onMouseUp={e => {
        if (e.button === 0 && !e.isDragging) setShowCode(v => !v)
      }}>{showCode ? "▾ Hide" : "▸ Show"} diff context</text>}
      {showCode && <text fg={color.muted} wrapMode="word">{item.code}</text>}
      {item.replies?.map(reply => <Entry key={reply.id} item={reply} defaultOpen focusedId={focusedId} />)}
      <Link url={item.url}>View on GitHub</Link>
    </box>}
    {!hasBody && item.url && <Link url={item.url}>Details</Link>}
  </box>
}
function checkGroup(check: Check) {
  if (["failure", "error", "timed_out", "action_required", "startup_failure"].includes(check.state)) return "failed"
  if (check.state === "success") return "passed"
  if (["neutral", "skipped", "cancelled"].includes(check.state)) return "other"
  return "pending"
}
function Checks({ items }: { items: Check[] }) {
  const [showPassing, setShowPassing] = useState(false)
  const [showOther, setShowOther] = useState(false)
  const row = (c: Check) => {
    const [icon, fg] = status(c.state)
    return <text key={c.id} selectable={false} fg={fg} wrapMode="word">{icon} {c.name} <span fg={color.muted}>· {c.state.replaceAll("_", " ")}</span>{c.url && <span fg={color.accent} link={{ url: c.url }}> · Details ↗</span>}</text>
  }
  return <box flexDirection="column">
    {items.filter(c => checkGroup(c) === "failed").map(row)}
    {items.filter(c => checkGroup(c) === "pending").map(row)}
    {(["passed", "other"] as const).map(group => {
      const checks = items.filter(c => checkGroup(c) === group)
      const expanded = group === "passed" ? showPassing : showOther
      return checks.length ? <box key={group} flexDirection="column">
        <text selectable={false} fg={color.muted} onMouseUp={e => {
          if (e.button === 0 && !e.isDragging) group === "passed" ? setShowPassing(v => !v) : setShowOther(v => !v)
        }}>{expanded ? "▾" : "▸"} {checks.length} {group === "passed" ? "passing" : "skipped / neutral / cancelled"} checks</text>
        {expanded && checks.map(row)}
      </box> : null
    })}
  </box>
}

export function App({ reference, demo }: { reference: Ref; demo: boolean }) {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const scroll = useRef<ScrollBoxRenderable>(null)
  const controller = useRef<AbortController | null>(null)
  const busy = useRef(false)
  const lastHead = useRef<string | undefined>(undefined)
  const [pr, setPR] = useState<PR>()
  const [data, setData] = useState<Partial<Sections>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState("")
  const [updated, setUpdated] = useState("")
  const [help, setHelp] = useState(false)
  const [shown, setShown] = useState(30)
  const [focusedComment, setFocusedComment] = useState<string>()
  const [focusSection, setFocusSection] = useState<"AI Reviews" | "Comments">()
  const [focusVersion, setFocusVersion] = useState(0)
  const [confirmAction, setConfirmAction] = useState<"merge" | "close" | "reopen">()
  const [commenting, setCommenting] = useState(false)
  const [commentText, setCommentText] = useState("")
  const [actionBusy, setActionBusy] = useState(false)
  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    try {
      if (demo) {
        const { demoPR, demoSections } = await import("./demo")
        setPR(demoPR); setData(demoSections); setErrors({})
      } else {
        const next = await loadPR(reference, abort.signal)
        if (lastHead.current && lastHead.current !== next.head.sha) {
          setData(old => ({ activity: old.activity }))
        }
        lastHead.current = next.head.sha
        setPR(next)
        setErrors(old => { const copy = { ...old }; delete copy.PR; return copy })
        async function section<K extends keyof Sections>(key: K, task: Promise<Sections[K]>) {
          try {
            const value = await task
            if (abort.signal.aborted) return
            setData(old => ({ ...old, [key]: value }))
            setErrors(old => { const copy = { ...old }; delete copy[key]; return copy })
          } catch (error) {
            if (!abort.signal.aborted) setErrors(old => ({ ...old, [key]: String(error instanceof Error ? error.message : error) }))
          }
        }
        await Promise.all([
          section("activity", loadActivity(reference, abort.signal)),
          section("checks", loadChecks(reference, next, abort.signal)),
        ])
      }
      if (!abort.signal.aborted) setUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))
    } catch (error) {
      if (!abort.signal.aborted) setErrors(old => ({ ...old, PR: (error as Error).message }))
    } finally {
      busy.current = false
      if (!abort.signal.aborted) setLoading(false)
    }
  }, [reference, demo])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 120_000)
    return () => { clearInterval(timer); controller.current?.abort() }
  }, [refresh])
  const open = (raw: string) => {
    let url: URL
    try { url = new URL(raw, reference.url) } catch { return }
    if (!['https:', 'http:'].includes(url.protocol)) return
    execFile(process.platform === "darwin" ? "open" : "xdg-open", [url.href], { timeout: 10_000 }, error => {
      setNotice(error ? `Could not open link: ${error.message}` : "Opened in browser")
    })
  }
  const performAction = async (action: "merge" | "close" | "reopen" | "approve" | "comment", body?: string) => {
    if (!pr || demo || actionBusy) return
    setActionBusy(true)
    setConfirmAction(undefined)
    try {
      const signal = new AbortController().signal
      if (action === "merge") {
        await mergePR(reference, pr.head.sha, signal)
        setNotice("Pull request merged")
      } else if (action === "approve") {
        await approvePR(reference, signal)
        setNotice("Pull request approved")
      } else if (action === "close" || action === "reopen") {
        await setPRState(reference, action === "reopen" ? "open" : "closed", signal)
        setNotice(action === "reopen" ? "Pull request reopened" : "Pull request closed")
      } else if (body?.trim()) {
        await addComment(reference, body.trim(), signal)
        setNotice("Comment added")
      }
      await refresh()
    } catch (error) {
      setNotice(`Action failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setActionBusy(false)
    }
  }
  const requestAction = (action: "merge" | "close" | "reopen") => {
    if (demo) { setNotice("Actions are unavailable in demo mode"); return }
    if (action === "reopen") void performAction(action)
    else setConfirmAction(action)
  }
  const startComment = () => {
    if (demo) { setNotice("Actions are unavailable in demo mode"); return }
    setCommentText("")
    setCommenting(true)
  }
  const submitComment = (body: string) => {
    setCommenting(false)
    if (body.trim()) void performAction("comment", body)
  }
  const submitCommentInput = (value: unknown) => submitComment(typeof value === "string" ? value : commentText)
  const quit = () => { controller.current?.abort(); renderer.destroy() }
  useKeyboard(key => {
    if (commenting) {
      if (key.name === "escape") { setCommenting(false); setCommentText("") }
      return
    }
    if (confirmAction) {
      if (key.name === "y") void performAction(confirmAction)
      else if (key.name === "n" || key.name === "escape") setConfirmAction(undefined)
      return
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) quit()
    else if (key.name === "r") void refresh()
    else if (key.name === "o") open(reference.url)
    else if (key.name === "?" || key.name === "h") setHelp(v => !v)
    else if (key.name === "j") scroll.current?.scrollBy(3)
    else if (key.name === "k") scroll.current?.scrollBy(-3)
    else if (key.name === "g") scroll.current?.scrollTo(key.shift ? scroll.current.scrollHeight : 0)
    else if (key.name === "m") setShown(v => v + 30)
    else if (key.name === "y") {
      renderer.copyToClipboardOSC52(reference.url)
      setNotice("PR URL copied")
    }
  })
  const hint = (key: keyof Sections) => errors[key]
    ? <text fg={color.yellow} wrapMode="word">{data[key] ? "Showing previous data. " : ""}{errors[key]}</text>
    : !data[key] ? <text fg={color.muted}>Loading…</text>
    : !data[key]?.length ? <text fg={color.muted}>Nothing reported.</text> : null
  const state = pr?.merged ? "Merged" : pr?.draft ? "Draft" : pr?.state === "closed" ? "Closed" : "Open"
  const { summary, comments } = commentFeed(data.activity || [])
  const aiReviews = aiReviewFeed(data.activity || [])
  const checkCounts = ["failed", "pending", "passed", "other"].map(group => {
    const count = data.checks?.filter(c => checkGroup(c) === group).length || 0
    return count ? `${count} ${group}` : ""
  }).filter(Boolean).join(" · ")
  const reviews = [...new Map((data.activity || []).filter(a => ["approved", "changes requested", "dismissed"].includes(a.action)).map(a => [a.author, a])).values()]
  const focusLinkedComment = (raw: string) => {
    const targetKey = linkKey(raw, reference.url)
    if (!targetKey) return false
    const target = (data.activity || []).flatMap(root => flattenEntries(root).map(entry => ({ entry, root }))).find(({ entry }) => entry.url && linkKey(entry.url, reference.url) === targetKey)
    if (!target) return false
    const inAIReview = aiReviews.some(review => review.summary?.id === target.root.id || review.comments.some(item => item.id === target.root.id))
    if (!inAIReview) {
      const commentIndex = comments.findIndex(item => item.id === target.root.id)
      if (commentIndex >= 0) setShown(current => Math.max(current, commentIndex + 1))
    }
    setFocusedComment(target.entry.id)
    setFocusSection(inAIReview ? "AI Reviews" : "Comments")
    setFocusVersion(version => version + 1)
    setNotice(`Focused ${target.entry.author}'s comment`)
    return true
  }
  const followLink = (raw: string) => {
    if (focusLinkedComment(raw)) return
    setFocusedComment(undefined)
    setFocusSection(undefined)
    open(raw)
  }
  useEffect(() => {
    if (!focusedComment) return
    const timer = setTimeout(() => scroll.current?.scrollChildIntoView(entryId(focusedComment)), 25)
    return () => clearTimeout(timer)
  }, [focusedComment, focusVersion, data.activity?.length])
  return <box width={width} height={height} flexDirection="column" backgroundColor={color.bg} onMouseUp={e => {
    if (e.button !== 0) return
    const url = renderer.getLinkAt(e.x, e.y)
    if (url) { followLink(url); return }
    setFocusedComment(undefined)
    setFocusSection(undefined)
    if (e.isDragging || renderer.getSelection()?.getSelectedText()) return
  }}>
    <box paddingX={2} paddingY={1} flexShrink={0} backgroundColor={color.panel} flexDirection="column">
      <Link url={reference.url}>{reference.repo} · #{reference.number}</Link>
      <text fg={color.text} wrapMode="word"><strong>{pr?.title || "Loading pull request…"}</strong></text>
      {pr && <text fg={color.muted} wrapMode="word"><span fg={state === "Open" ? color.green : color.yellow}>{state}</span> · @{pr.user.login} · {pr.head.ref} → {pr.base.ref}</text>}
      {pr && <text fg={color.muted} wrapMode="word">{pr.changed_files.toLocaleString()} files changed · <span fg={color.green}>+{pr.additions.toLocaleString()}</span> / <span fg={color.red}>−{pr.deletions.toLocaleString()}</span> · {pr.commits} commits</text>}
    </box>
    <scrollbox ref={scroll} focused flexGrow={1} scrollX={false} contentOptions={{ paddingX: width < 60 ? 1 : 2, paddingTop: 1 }}>
      {errors.PR && <text fg={color.red} marginBottom={1} wrapMode="word">{errors.PR}</text>}
      {help && <box padding={1} marginBottom={1} backgroundColor={color.panel}>
        <text fg={color.text} wrapMode="word">Scroll: arrows, j/k, Page Up/Down, mouse wheel. g/G: top/bottom. 1: description. 2: AI reviews. 3: comments. 4: checks. Click comment headings or previews to expand; click check groups and diff context to expand. Click links to open. Use the action buttons below for PR actions. Merge and close follow a y/N confirmation prompt. m: older comments. r: refresh. o: GitHub. y: copy PR URL. h: help. q: quit.</text>
      </box>}
      {pr && <>
        <Section title="Description"><Markdown body={pr.body || "_No description provided._"} /></Section>
        {aiReviews.length > 0 && <Section title="AI Reviews" count={aiReviews.length} reveal={focusSection === "AI Reviews" ? focusVersion : 0}>
          {aiReviews.map(review => <box key={review.provider.id} flexDirection="column" marginBottom={1}>
            <text selectable={false} fg={color.accent} wrapMode="word">{review.provider.name}{review.summary ? " · summary" : " · review"}</text>
            {review.summary && <Entry item={review.summary} defaultOpen summary focusedId={focusedComment} />}
            {review.comments.map(item => <Entry key={item.id} item={item} focusedId={focusedComment} />)}
          </box>)}
        </Section>}
        <Section title="Comments" defaultOpen={false} count={data.activity ? comments.length + (summary ? 1 : 0) : undefined} reveal={focusSection === "Comments" ? focusVersion : 0}>
          {hint("activity")}
          {summary && <Entry key={summary.id} item={summary} defaultOpen summary focusedId={focusedComment} />}
          {reviews.filter(review => !review.body?.trim()).map(review => <text key={review.author} fg={review.action === "approved" ? color.green : color.yellow} wrapMode="word">{review.author} · {review.action}</text>)}
          {data.activity && !summary && !comments.length && !!data.activity.length && <text fg={color.muted}>No comments.</text>}
          {comments.slice(0, shown).map(item => <Entry key={item.id} item={item} focusedId={focusedComment} />)}
          {comments.length > shown && <text selectable={false} fg={color.accent} onMouseUp={e => { if (e.button === 0) setShown(v => v + 30) }}>Show older comments · click or press m</text>}
        </Section>
        <Section title="Checks" count={checkCounts || undefined}>
          {hint("checks")}
          {data.checks && <Checks items={data.checks} />}
        </Section>
      </>}
    </scrollbox>
    {pr && !demo && <box paddingX={1} flexShrink={0} backgroundColor={color.panel} flexDirection="column">
      {commenting ? <box flexDirection="row" gap={1}>
        <text fg={color.text}>Comment:</text>
        <input focused flexGrow={1} value={commentText} placeholder="Write a comment and press Enter" onInput={setCommentText} onSubmit={submitCommentInput} />
        <text selectable={false} fg={color.muted}>Esc cancel</text>
      </box> : confirmAction ? <text wrapMode="word" fg={color.yellow}>Confirm {confirmAction === "merge" ? "squash merge" : `${confirmAction} pull request`}? Type y to confirm or n to cancel.</text> : <box flexDirection="row" gap={1}>
        <ActionButton label="Comment" onClick={startComment} disabled={actionBusy} />
        <ActionButton label="Approve" onClick={() => void performAction("approve")} disabled={actionBusy || pr.state !== "open" || pr.merged} />
        <ActionButton label="Merge (squash)" onClick={() => requestAction("merge")} disabled={actionBusy || pr.state !== "open" || pr.merged || pr.draft} />
        {pr.state === "closed" && !pr.merged
          ? <ActionButton label="Reopen" onClick={() => requestAction("reopen")} disabled={actionBusy} />
          : <ActionButton label="Close" onClick={() => requestAction("close")} disabled={actionBusy || pr.state !== "open" || pr.merged} danger />}
      </box>}
    </box>}
    <box paddingX={1} flexShrink={0} backgroundColor={color.panel}>
      <text fg={color.muted} wrapMode="word">{notice || (loading ? "Refreshing…" : `Updated ${updated}`)} · r refresh · o GitHub · h help · q quit</text>
    </box>
  </box>
}

export async function start(reference: Ref, demo = false) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, onDestroy: () => process.exit(0) })
  createRoot(renderer).render(<App reference={reference} demo={demo} />)
}
