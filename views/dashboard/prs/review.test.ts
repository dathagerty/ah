import { expect, test } from "vitest"
import type { Pr } from "./github.ts"
import {
  bringInCommands,
  cleanupCommands,
  isReviewDir,
  planReview,
  remoteFor,
  reviewMessage,
} from "./review.ts"

const REMOTES = [
  "origin git@github.com:dathagerty/ah.git",
  "upstream https://github.com/david-crespo/ah.git",
].join("\n")

const pr: Pr = {
  repo: "david-crespo/ah",
  number: 42,
  title: "Show time dividers",
  url: "https://github.com/david-crespo/ah/pull/42",
  branch: "dividers",
  base: "main",
  author: "someone",
  state: "open",
  review: null,
  updatedAt: "",
  checks: [],
}

test("the remote for a repo is the one whose URL is it", () => {
  expect(remoteFor("david-crespo/ah", REMOTES)).toBe("upstream")
  expect(remoteFor("dathagerty/ah", REMOTES)).toBe("origin")
  expect(remoteFor("elsewhere/thing", REMOTES)).toBeNull()
})

test("a review gets a name, a bookmark and a directory of its own under ah's reviews", () => {
  expect(planReview(pr, REMOTES, "/state/ah/reviews")).toEqual({
    name: "review-david-crespo-ah-42",
    bookmark: "ah-review/david-crespo-ah-42",
    dir: "/state/ah/reviews/david-crespo-ah-42",
    remote: "upstream",
    base: "main",
    number: 42,
    from: "fork_point(main@upstream | ah-review/david-crespo-ah-42)",
    to: "ah-review/david-crespo-ah-42",
  })
  expect(planReview({ ...pr, repo: "elsewhere/x" }, REMOTES, "/r")).toBeNull()
})

test("names keep to what's safe in a path, a bookmark and a revset", () => {
  const plan = planReview(
    { ...pr, repo: "we.ird_org/re po" },
    "o https://github.com/we.ird_org/re po",
    "/r",
  )
  expect(plan?.name).toBe("review-we.ird_org-re-po-42")
})

test("bringing a PR in fetches its head and base, imports them, and adds a workspace at its head", () => {
  const plan = planReview(pr, REMOTES, "/state/ah/reviews")!
  expect(bringInCommands(plan, "/ws/.git")).toEqual([
    [
      "git",
      [
        "--git-dir",
        "/ws/.git",
        "fetch",
        "upstream",
        "+refs/pull/42/head:refs/heads/ah-review/david-crespo-ah-42",
        "+refs/heads/main:refs/remotes/upstream/main",
      ],
    ],
    ["jj", ["git", "import"]],
    [
      "jj",
      [
        "workspace",
        "add",
        "--name",
        "review-david-crespo-ah-42",
        "-r",
        "ah-review/david-crespo-ah-42",
        "/state/ah/reviews/david-crespo-ah-42",
      ],
    ],
  ])
})

test("cleaning up drops the workspace's commit, the workspace, the PR's own commits and the bookmark", () => {
  const plan = planReview(pr, REMOTES, "/state/ah/reviews")!
  expect(cleanupCommands(plan.name, plan.bookmark)).toEqual([
    ["jj", ["abandon", "review-david-crespo-ah-42@"]],
    ["jj", ["workspace", "forget", "review-david-crespo-ah-42"]],
    [
      "jj",
      [
        "abandon",
        '::bookmarks(exact:"ah-review/david-crespo-ah-42") ~ ::(remote_bookmarks() | (bookmarks() ~ bookmarks(exact:"ah-review/david-crespo-ah-42")) | tags() | working_copies())',
      ],
    ],
    ["jj", ["bookmark", "delete", "ah-review/david-crespo-ah-42"]],
  ])
})

test("only a directory ah made for a review, right under its reviews, is one to delete", () => {
  expect(isReviewDir("/state/ah/reviews/david-crespo-ah-42", "/state/ah/reviews")).toBe(
    true,
  )
  for (const dir of [
    "/state/ah/reviews",
    "/state/ah/reviews/",
    "/state/ah/reviews/a/b",
    "/state/ah/reviews/../x",
    "/state/ah/reviews/..",
    "/home/me/code/ah",
    "/state/ah/reviews/has space",
  ])
    expect(isReviewDir(dir, "/state/ah/reviews")).toBe(false)
})

test("the agent's review request says what to look at and what not to do", () => {
  const plan = planReview(pr, REMOTES, "/state/ah/reviews")!
  const m = reviewMessage(pr, plan)
  expect(m).toContain("david-crespo/ah#42 (Show time dividers)")
  expect(m).toContain("https://github.com/david-crespo/ah/pull/42")
  expect(m).toContain("/state/ah/reviews/david-crespo-ah-42")
  expect(m).toContain(
    "jj diff --from 'fork_point(main@upstream | ah-review/david-crespo-ah-42)'",
  )
  expect(m).toMatch(/don't push|do not push/i)
})
