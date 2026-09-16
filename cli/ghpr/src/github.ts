import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)
export type Ref = { repo: string; number: number; url: string }
type User = { login: string }
export type PR = {
  number: number; title: string; body: string | null; html_url: string
  state: string; draft: boolean; merged: boolean; mergeable: boolean | null
  user: User; updated_at: string; created_at: string
  head: { ref: string; sha: string }; base: { ref: string }
  labels: { name: string }[]; assignees: User[]; requested_reviewers: User[]
  requested_teams: { name: string }[]; milestone: { title: string } | null
  additions: number; deletions: number; changed_files: number; commits: number
}
export type Activity = {
  id: string; author: string; action: string; date: string; body?: string
  url?: string; context?: string; code?: string; reactions?: string; replies?: Activity[]; resolved?: boolean
}
export type Check = { id: string; name: string; state: string; url?: string }
export type Sections = { activity: Activity[]; checks: Check[] }

export type AIReviewProvider = { id: string; name: string }
export type AIReview = { provider: AIReviewProvider; summary?: Activity; comments: Activity[] }

type AIProviderDefinition = AIReviewProvider & { authors: RegExp; markers: RegExp }
const aiProviders: AIProviderDefinition[] = [
  { id: "greptile", name: "Greptile", authors: /^greptile-apps(?:\[bot\])?$/i, markers: /greptile(?:_summary|-status)|confidence score:/i },
  { id: "coderabbit", name: "CodeRabbit", authors: /^coderabbitai(?:\[bot\])?$/i, markers: /coderabbit|code\s*rabbit/i },
]

export function isDeploymentComment(item: Activity) {
  return /^vercel(?:\[bot\])?$/i.test(item.author) && /\[vc\]:|deployment|preview environments/i.test(item.body || "")
}

export function detectAIProvider(item: Activity): AIReviewProvider | undefined {
  const definition = aiProviders.find(provider => provider.authors.test(item.author) || provider.markers.test(item.body || ""))
  return definition && { id: definition.id, name: definition.name }
}

function isSummary(item: Activity, provider: AIReviewProvider) {
  if (item.action === "review thread") return false
  const body = item.body || ""
  return provider.id === "greptile" && /greptile_summary|confidence score:/i.test(body)
    || provider.id === "coderabbit" && /(?:^|\n)#{1,3}\s+(?:code\s*rabbit\s+)?summary\b|coderabbit.*summary|summary.*coderabbit/i.test(body)
    || /(?:^|\n)#{1,3}\s+(?:review\s+)?summary\b|<h[1-3]\b[^>]*>\s*(?:review\s+)?summary\b/i.test(body)
}

export function aiReviewFeed(items: Activity[]): AIReview[] {
  const groups = new Map<string, { provider: AIReviewProvider; items: Activity[] }>()
  for (const item of items) {
    if (isDeploymentComment(item)) continue
    const provider = detectAIProvider(item)
    if (!provider || !item.body?.trim() && !item.replies?.length) continue
    const group = groups.get(provider.id) || { provider, items: [] }
    group.items.push(item)
    groups.set(provider.id, group)
  }
  return [...groups.values()].map(({ provider, items }) => {
    const ordered = [...items].sort((a, b) => a.date.localeCompare(b.date))
    const summary = ordered.find(item => isSummary(item, provider))
    return { provider, summary, comments: items.filter(item => item.id !== summary?.id).sort((a, b) => b.date.localeCompare(a.date)) }
  }).sort((a, b) => (a.summary?.date || a.comments.at(-1)?.date || "").localeCompare(b.summary?.date || b.comments.at(-1)?.date || ""))
}

export function commentFeed(items: Activity[]) {
  const aiIds = new Set(items.filter(item => detectAIProvider(item)).map(item => item.id))
  const comments = items.filter(item => !isDeploymentComment(item) && !aiIds.has(item.id) && Boolean(item.body?.trim() || item.replies?.length))
  // Pin the earliest summary, not the latest status message from the same bot.
  const summary = [...comments].sort((a, b) => a.date.localeCompare(b.date)).find(item =>
    item.action !== "review thread" && /(?:^|\n)#{1,3}\s+(?:\w+\s+)?summary\b|<h[1-3]\b[^>]*>\s*(?:\w+\s+)?summary\b/i.test(item.body || ""))
  return { summary, comments: comments.filter(item => item.id !== summary?.id).sort((a, b) => b.date.localeCompare(a.date)) }
}

export async function gh<T>(args: string[], signal?: AbortSignal): Promise<T> {
  try {
    const { stdout } = await exec("gh", args, {
      signal, timeout: 45_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    })
    return JSON.parse(stdout) as T
  } catch (error) {
    if (signal?.aborted) throw error
    const e = error as Error & { stderr?: string; code?: string }
    throw new Error(e.code === "ENOENT" ? "Install GitHub CLI (gh), then run gh auth login." : e.stderr?.trim() || e.message)
  }
}

async function apiMutation<T>(args: string[], signal?: AbortSignal) {
  return gh<T>(["api", "--hostname", "github.com", ...args], signal)
}

export async function addComment(ref: Ref, body: string, signal?: AbortSignal) {
  await apiMutation(["--method", "POST", `repos/${ref.repo}/issues/${ref.number}/comments`, "-f", `body=${body}`], signal)
}

export async function approvePR(ref: Ref, signal?: AbortSignal) {
  await apiMutation(["--method", "POST", `repos/${ref.repo}/pulls/${ref.number}/reviews`, "-f", "event=APPROVE"], signal)
}

export async function setPRState(ref: Ref, state: "open" | "closed", signal?: AbortSignal) {
  await apiMutation(["--method", "PATCH", `repos/${ref.repo}/pulls/${ref.number}`, "-f", `state=${state}`], signal)
}

export async function mergePR(ref: Ref, headSha: string, signal?: AbortSignal) {
  const result = await apiMutation<{ merged: boolean; message: string }>([
    "--method", "PUT", `repos/${ref.repo}/pulls/${ref.number}/merge`,
    "-f", "merge_method=squash", "-f", `sha=${headSha}`,
  ], signal)
  if (!result.merged) throw new Error(result.message || "GitHub did not merge the pull request.")
}

export async function resolveRef(input: string): Promise<Ref> {
  let repo: string | undefined
  let number: string | undefined
  const url = input.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)(?:[/?#].*)?$/)
  const short = input.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/)
  if (url || short) [, repo, number] = (url || short)!
  else if (/^[1-9]\d*$/.test(input)) {
    number = input
    const result = await gh<{ nameWithOwner: string; url: string }>(["repo", "view", "--json", "nameWithOwner,url"])
    if (!result.url.startsWith("https://github.com/")) throw new Error("Only github.com is supported. Supply owner/repo#123.")
    repo = result.nameWithOwner
  }
  if (!repo || !number || !Number.isSafeInteger(Number(number))) throw new Error("Use a GitHub PR URL, owner/repo#123, or a PR number inside a checkout.")
  return { repo, number: Number(number), url: `https://github.com/${repo}/pull/${number}` }
}

function api<T>(endpoint: string, signal: AbortSignal) {
  return gh<T>(["api", "--hostname", "github.com", endpoint], signal)
}
async function pages<T>(endpoint: string, signal: AbortSignal): Promise<T[]> {
  const separator = endpoint.includes("?") ? "&" : "?"
  const result = await gh<T[][]>(["api", "--hostname", "github.com", "--paginate", "--slurp", `${endpoint}${separator}per_page=100`], signal)
  return result.flat()
}
export function loadPR(ref: Ref, signal: AbortSignal) {
  return api<PR>(`repos/${ref.repo}/pulls/${ref.number}`, signal)
}

type Comment = {
  id: number; user: User | null; body: string; html_url: string
  created_at: string; submitted_at?: string; state?: string
  reactions?: Record<string, number | string>
}
type ThreadComment = {
  id: string; author: User | null; body: string; url: string; createdAt: string; diffHunk: string
}
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
type Thread = {
  id: string; path: string; line: number | null; originalLine: number | null
  isResolved: boolean; isOutdated: boolean; comments: Connection<ThreadComment>
}
const commentFields = "nodes { id author { login } body url createdAt diffHunk } pageInfo { hasNextPage endCursor }"

async function reviewThreads(ref: Ref, signal: AbortSignal): Promise<Activity[]> {
  const [owner, name] = ref.repo.split("/")
  const threads: Thread[] = []
  let cursor: string | null = null
  do {
    const query = `query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}) {
      pullRequest(number:${ref.number}) { reviewThreads(first:100, after:${JSON.stringify(cursor)}) {
        nodes { id path line originalLine isResolved isOutdated comments(first:100) { ${commentFields} } }
        pageInfo { hasNextPage endCursor }
      } }
    } }`
    const result: { data: { repository: { pullRequest: { reviewThreads: Connection<Thread> } } } } = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`], signal)
    const connection = result.data.repository.pullRequest.reviewThreads
    threads.push(...connection.nodes)
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null
  } while (cursor)
  for (const thread of threads) {
    let page = thread.comments.pageInfo
    while (page.hasNextPage) {
      const query = `query { node(id:${JSON.stringify(thread.id)}) { ... on PullRequestReviewThread {
        comments(first:100, after:${JSON.stringify(page.endCursor)}) { ${commentFields} }
      } } }`
      const next = await gh<{ data: { node: { comments: Connection<ThreadComment> } } }>(["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`], signal)
      thread.comments.nodes.push(...next.data.node.comments.nodes)
      page = next.data.node.comments.pageInfo
    }
  }
  return threads.filter(t => t.comments.nodes.length).map(t => {
    const [first, ...replies] = t.comments.nodes
    return {
      id: t.id, author: first.author?.login || "ghost", action: "review thread",
      date: first.createdAt, body: first.body, url: first.url, resolved: t.isResolved,
      code: first.diffHunk,
      context: `${t.path}:${t.line ?? t.originalLine ?? "?"}${t.isResolved ? " · resolved" : " · unresolved"}${t.isOutdated ? " · outdated" : ""}`,
      replies: replies.map(c => ({ id: c.id, author: c.author?.login || "ghost", action: "replied", date: c.createdAt, body: c.body, url: c.url })),
    }
  })
}

export async function loadActivity(ref: Ref, signal: AbortSignal): Promise<Activity[]> {
  const root = `repos/${ref.repo}`
  const [comments, reviews, threads] = await Promise.all([
    pages<Comment>(`${root}/issues/${ref.number}/comments`, signal),
    pages<Comment>(`${root}/pulls/${ref.number}/reviews`, signal),
    reviewThreads(ref, signal),
  ])
  return [
    ...comments.map(c => ({ id: `comment-${c.id}`, author: c.user?.login || "ghost", action: "commented", date: c.created_at, body: c.body, url: c.html_url,
      reactions: Object.entries(c.reactions || {}).filter(([key, value]) => !["url", "total_count"].includes(key) && typeof value === "number" && value > 0).map(([key, value]) => `${key} ${value}`).join(" · "),
    })),
    ...reviews.filter(r => r.state !== "PENDING").map(r => ({ id: `review-${r.id}`, author: r.user?.login || "ghost", action: r.state?.toLowerCase().replaceAll("_", " ") || "reviewed", date: r.submitted_at || r.created_at, body: r.body, url: r.html_url })),
    ...threads,
  ].sort((a, b) => a.date.localeCompare(b.date))
}

export async function loadChecks(ref: Ref, pr: PR, signal: AbortSignal): Promise<Check[]> {
  const root = `repos/${ref.repo}/commits/${pr.head.sha}`
  const [runs, statuses] = await Promise.all([
    gh<{ check_runs: { id: number; name: string; status: string; conclusion: string | null; details_url: string }[] }[]>(["api", "--hostname", "github.com", "--paginate", "--slurp", `${root}/check-runs?per_page=100&filter=latest`], signal),
    pages<{ id: number; context: string; state: string; target_url: string }>(`${root}/statuses`, signal),
  ])
  const latest = new Map<string, Check>()
  for (const s of statuses) if (!latest.has(s.context)) latest.set(s.context, { id: `status-${s.id}`, name: s.context, state: s.state, url: s.target_url })
  return [...runs.flatMap(p => p.check_runs).map(c => ({ id: `check-${c.id}`, name: c.name, state: c.conclusion || c.status, url: c.details_url })), ...latest.values()]
}
