// GitHub PRs for the dashboard's PRs tab: which repos a workspace's remotes
// are, which of their PRs come from the workspace's bookmarks, and those
// PRs' state, review and checks, from `gh pr list --json`. No Node imports:
// the page uses the types and the badge.

export type CheckState = "passed" | "failed" | "pending" | "skipped"

export interface Check {
  name: string
  state: CheckState
  url: string
}

export interface Pr {
  /** owner/name */
  repo: string
  number: number
  title: string
  url: string
  branch: string
  state: "open" | "draft" | "merged" | "closed"
  review: "approved" | "changes" | "required" | null
  updatedAt: string
  checks: Check[]
}

/** The owner/name of each GitHub remote in `jj git remote list` */
export function githubRepos(remoteList: string): string[] {
  const repos = new Set<string>()
  for (const line of remoteList.split("\n")) {
    const url = line.trim().split(/\s+/)[1] ?? ""
    const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)
    if (m) repos.add(`${m[1]}/${m[2]}`)
  }
  return [...repos]
}

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
])

/** A CheckRun's conclusion once it's completed, or a StatusContext's state */
export function checkState(c: Record<string, unknown>): CheckState {
  if (c.__typename === "StatusContext") {
    const state = String(c.state)
    return state === "SUCCESS" ? "passed" : FAILED.has(state) ? "failed" : "pending"
  }
  if (c.status !== "COMPLETED") return "pending"
  const conclusion = String(c.conclusion)
  if (conclusion === "SKIPPED") return "skipped"
  return FAILED.has(conclusion) ? "failed" : "passed"
}

const REVIEW: Record<string, Pr["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "required",
}

interface Listed {
  number: number
  title: string
  state: string
  isDraft: boolean
  reviewDecision: string | null
  headRefName: string
  headRepositoryOwner: { login: string } | null
  url: string
  updatedAt: string
  statusCheckRollup: Record<string, unknown>[] | null
}

/**
 * `gh pr list --repo <repo> --json …` narrowed to PRs whose head is one of
 * `branches` in a repo owned by one of `owners` (the remotes'), so another
 * fork's branch of the same name isn't taken for ours.
 */
export function parsePrs(
  json: string,
  repo: string,
  branches: Set<string>,
  owners: Set<string>,
): Pr[] {
  const listed = JSON.parse(json) as Listed[]
  return listed
    .filter(
      (p) => branches.has(p.headRefName) && owners.has(p.headRepositoryOwner?.login ?? ""),
    )
    .map((p) => ({
      repo,
      number: p.number,
      title: p.title,
      url: p.url,
      branch: p.headRefName,
      state:
        p.state === "MERGED"
          ? "merged"
          : p.state === "CLOSED"
            ? "closed"
            : p.isDraft
              ? "draft"
              : "open",
      review: REVIEW[p.reviewDecision ?? ""] ?? null,
      updatedAt: p.updatedAt,
      checks: (p.statusCheckRollup ?? []).map((c) => {
        const name =
          c.__typename === "StatusContext"
            ? String(c.context)
            : c.workflowName
              ? `${String(c.workflowName)} / ${String(c.name)}`
              : String(c.name)
        const url = String(
          (c.__typename === "StatusContext" ? c.targetUrl : c.detailsUrl) ?? "",
        )
        return { name, state: checkState(c), url }
      }),
    }))
}

const isLive = (p: Pr) => p.state === "open" || p.state === "draft"

/** Soon while an open PR's checks are running, so their result shows up
 * shortly after; slow once everything's settled */
export function pollDelay(prs: Pr[]): number {
  const running = prs.some((p) => isLive(p) && p.checks.some((c) => c.state === "pending"))
  return running ? 45_000 : 300_000
}

/** The PRs tab's label: open PRs with failing checks or changes requested,
 * else a run in progress, else how many are open and fine */
export function prsBadge(prs: Pr[]): string {
  const live = prs.filter(isLive)
  const attention = live.filter(
    (p) => p.review === "changes" || p.checks.some((c) => c.state === "failed"),
  )
  if (attention.length) return `✗ ${attention.length}`
  if (live.some((p) => p.checks.some((c) => c.state === "pending"))) return "…"
  return live.length ? `✓ ${live.length}` : ""
}
