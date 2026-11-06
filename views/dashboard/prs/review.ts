// Reviewing someone else's PR locally from the PRs tab: its head fetched
// (GitHub keeps every PR at refs/pull/N/head) as a bookmark, a jj workspace
// at it under ah's own reviews directory so the user's @ isn't touched, and
// skepsis on its diff from the base; and the cleanup that takes all of that
// away again. These are the plans and checks; routes.ts runs them. Paths and
// names come from the PR, so each is reduced to what's safe in a path, a
// bookmark and a revset. No Node imports: the page names reviews too.

import type { Pr } from "./github.ts"

export interface ReviewPlan {
  /** The jj workspace's name */
  name: string
  bookmark: string
  dir: string
  /** The remote the PR's repo is */
  remote: string
  base: string
  number: number
  /** skepsis's diff: from the fork point with the base, to the PR's head */
  from: string
  to: string
}

/** The remote in `jj git remote list` whose URL is the GitHub repo */
export function remoteFor(repo: string, remoteList: string): string | null {
  for (const line of remoteList.split("\n")) {
    const [name, url] = line.trim().split(/\s+(.*)/)
    const m = /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url ?? "")
    if (name && m?.[1] === repo) return name
  }
  return null
}

/** Letters, digits and . _ - only; anything else becomes - */
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-")

/** A branch name git and a revset both take as is */
const safeRef = (s: string) => s.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/\.\.+/g, ".")

/** A review's id, from its PR: what its workspace, bookmark and directory
 * are named for */
export const reviewId = (repo: string, number: number) =>
  `${safe(repo.replace("/", "-"))}-${number}`

export function planReview(
  pr: Pr,
  remoteList: string,
  reviewsRoot: string,
): ReviewPlan | null {
  const remote = remoteFor(pr.repo, remoteList)
  if (!remote) return null
  const id = reviewId(pr.repo, pr.number)
  const bookmark = `ah-review/${id}`
  const base = safeRef(pr.base)
  return {
    name: `review-${id}`,
    bookmark,
    dir: `${reviewsRoot}/${id}`,
    remote,
    base,
    number: pr.number,
    from: `fork_point(${base}@${remote} | ${bookmark})`,
    to: bookmark,
  }
}

type Command = [string, string[]]

/** Fetch the PR's head as the bookmark and its base as the remote's, import
 * them into jj, and add the workspace at the head. `gitDir` is `jj git
 * root`'s. */
export function bringInCommands(plan: ReviewPlan, gitDir: string): Command[] {
  return [
    [
      "git",
      [
        "--git-dir",
        gitDir,
        "fetch",
        plan.remote,
        `+refs/pull/${plan.number}/head:refs/heads/${plan.bookmark}`,
        `+refs/heads/${plan.base}:refs/remotes/${plan.remote}/${plan.base}`,
      ],
    ],
    ["jj", ["git", "import"]],
    ["jj", ["workspace", "add", "--name", plan.name, "-r", plan.bookmark, plan.dir]],
  ]
}

/** Undo bringInCommands, but for the directory: the workspace's empty
 * working-copy commit, the workspace, the commits only the PR brought in
 * (deleting a bookmark leaves its commits visible), and the bookmark. What
 * any remote, other bookmark, tag or working copy reaches stays. */
export function cleanupCommands(name: string, bookmark: string): Command[] {
  const own = `bookmarks(exact:"${bookmark}")`
  const kept = `remote_bookmarks() | (bookmarks() ~ ${own}) | tags() | working_copies()`
  return [
    ["jj", ["abandon", `${name}@`]],
    ["jj", ["workspace", "forget", name]],
    ["jj", ["abandon", `::${own} ~ ::(${kept})`]],
    ["jj", ["bookmark", "delete", bookmark]],
  ]
}

/** Whether `dir` is one ah made for a review: right under `reviewsRoot`,
 * named as planReview names them. Only such a directory is ever deleted. */
export function isReviewDir(dir: string, reviewsRoot: string): boolean {
  if (!dir.startsWith(`${reviewsRoot}/`)) return false
  const rest = dir.slice(reviewsRoot.length + 1)
  return /^[A-Za-z0-9._-]+$/.test(rest) && rest !== "." && rest !== ".."
}

/** What the tab's agent gets when asked to review the PR */
export function reviewMessage(pr: Pr, plan: ReviewPlan): string {
  return [
    `Review ${pr.repo}#${pr.number} (${pr.title}) for me: ${pr.url}`,
    `It's checked out in a jj workspace of its own at ${plan.dir}, at bookmark ${plan.bookmark}.`,
    `The change is jj diff --from '${plan.from}' --to '${plan.to}', run in that directory.`,
    "Tell me what you find: bugs, risks, and anything unclear. Don't push or comment on GitHub; I'll decide what to post.",
  ].join("\n")
}
