import type { PR, Sections } from "./github"

const date = new Date(Date.now() - 28 * 60_000).toISOString()
const sha = "c41b6e5c0000000000000000000000000000000000"
const findingUrl = "https://github.com/acme/frontend/pull/861#discussion_r123"
export const demoPR: PR = {
  number: 861, title: "Unify the frontend applications", body: `## Summary

Bring the applications together with shared components and separate deployment profiles.

- Preserve each application's branding and routes.
- Share **navigation**, typography, and layouts.
- Keep previews isolated while we validate the rollout.

### Validation

- [x] Build the shared components
- [x] Check preview deployments
- [ ] Finish the accessibility review

| Project | Preview | Status |
| --- | --- | --- |
| nest-cms | [Open preview](https://example.com/nest) | Ready |
| plume-hub | [Open preview](https://example.com/hub) | Ready |

\`\`\`ts
export const profile = process.env.APP_PROFILE ?? "default"
\`\`\`
`, html_url: "https://github.com/acme/frontend/pull/861", state: "open", draft: false, merged: false, mergeable: true,
  user: { login: "alex" }, updated_at: date, created_at: date, head: { ref: "feature/unify-apps", sha }, base: { ref: "develop" },
  labels: [{ name: "frontend" }], assignees: [], requested_reviewers: [{ login: "sam" }], requested_teams: [], milestone: null,
  additions: 4730, deletions: 1067, changed_files: 233, commits: 12,
}
export const demoSections: Sections = {
  checks: [{ id: "build", name: "Build", state: "success", url: "https://github.com" }, { id: "types", name: "Typecheck", state: "failure", url: "https://github.com" },
    ...["nest-cms", "plume-hub", "plume-vaults"].map(name => ({ id: name, name: `Vercel – ${name}`, state: "success", url: `https://example.com/${name}` })),
    { id: "preview", name: "Vercel – pusd-preview", state: "failure", url: "https://example.com/pusd" },
  ],
  activity: [
    { id: "summary", author: "greptile-apps", action: "commented", date, body: `<!-- greptile_summary -->\n<h2>Confidence Score: 4/5</h2>\nThe implementation looks safe, with one sizing issue to address.\n<h2>Findings</h2>\n1. <img alt="P2" src="https://example.com/p2.svg"> **Raw sizing values** <a href="${findingUrl}">▶</a>\n<details><summary><h3>Summary</h3></summary>\n- Shares navigation and branding through typed product profiles.\n- Keeps application-specific caches isolated.\n</details>` },
    { id: "review", author: "sam", action: "changes requested", date, body: "The layout looks good. Please keep the navigation labels consistent across the three applications." },
    { id: "thread", author: "sam", action: "review thread", date, url: findingUrl, body: "Can we handle an empty profile here?", context: "src/profile.ts:12 · unresolved", code: '@@ -12,1 +12,1 @@\n+const profile = profiles[name]', replies: [{ id: "reply", author: "alex", action: "replied", date, body: "Added a fallback to the default profile." }] },
    { id: "bot", author: "vercel[bot]", action: "commented", date, body: "### Deployment complete\n\nAll three preview environments are ready.\n\n[Visit the preview](https://example.com)" },
  ],
}
