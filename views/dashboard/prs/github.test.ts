import { expect, test } from "vitest"
import {
  checkState,
  githubRepos,
  parsePrs,
  pollDelay,
  type Pr,
  prsBadge,
} from "./github.ts"

test("GitHub repos come from the remotes, over ssh or https, once each", () => {
  const remotes = [
    "origin git@github.com:dathagerty/ah.git",
    "upstream https://github.com/david-crespo/ah.git",
    "mirror ssh://git@github.com/dathagerty/ah",
    "work git@gitlab.example.com:team/thing.git",
  ].join("\n")
  expect(githubRepos(remotes)).toEqual(["dathagerty/ah", "david-crespo/ah"])
})

test("a check run's state is its conclusion once it's done, pending before", () => {
  const run = (status: string, conclusion: string | null) => ({
    __typename: "CheckRun",
    name: "ci",
    status,
    conclusion,
    detailsUrl: "u",
  })
  expect(checkState(run("COMPLETED", "SUCCESS"))).toBe("passed")
  expect(checkState(run("COMPLETED", "NEUTRAL"))).toBe("passed")
  expect(checkState(run("COMPLETED", "FAILURE"))).toBe("failed")
  expect(checkState(run("COMPLETED", "TIMED_OUT"))).toBe("failed")
  expect(checkState(run("COMPLETED", "CANCELLED"))).toBe("failed")
  expect(checkState(run("COMPLETED", "SKIPPED"))).toBe("skipped")
  expect(checkState(run("IN_PROGRESS", null))).toBe("pending")
  expect(checkState(run("QUEUED", null))).toBe("pending")
})

test("an older status context's state maps the same way", () => {
  const ctx = (state: string) => ({
    __typename: "StatusContext",
    context: "ci",
    state,
    targetUrl: "u",
  })
  expect(checkState(ctx("SUCCESS"))).toBe("passed")
  expect(checkState(ctx("FAILURE"))).toBe("failed")
  expect(checkState(ctx("ERROR"))).toBe("failed")
  expect(checkState(ctx("PENDING"))).toBe("pending")
})

const pr = (over: Record<string, unknown>) => ({
  number: 1,
  title: "A change",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "",
  headRefName: "feature",
  headRepositoryOwner: { login: "dathagerty" },
  url: "https://github.com/david-crespo/ah/pull/1",
  updatedAt: "2026-11-06T14:00:00Z",
  statusCheckRollup: [],
  ...over,
})

test("only PRs from the stack's bookmarks, on one of the remotes' owners, are kept", () => {
  const json = JSON.stringify([
    pr({ number: 1, headRefName: "feature" }),
    pr({ number: 2, headRefName: "elsewhere" }),
    // Someone else's fork, with a branch of the same name
    pr({ number: 3, headRefName: "feature", headRepositoryOwner: { login: "stranger" } }),
  ])
  const prs = parsePrs(
    json,
    "david-crespo/ah",
    new Set(["feature"]),
    new Set(["dathagerty"]),
  )
  expect(prs.map((p) => p.number)).toEqual([1])
})

test("a PR's state, review and checks come through in the page's terms", () => {
  const json = JSON.stringify([
    pr({
      number: 7,
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          name: "test",
          workflowName: "CI",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://ci/1",
        },
        {
          __typename: "StatusContext",
          context: "lint",
          state: "SUCCESS",
          targetUrl: "https://ci/2",
        },
      ],
    }),
    pr({ number: 8, isDraft: true, reviewDecision: "REVIEW_REQUIRED" }),
    pr({ number: 9, state: "MERGED", reviewDecision: "APPROVED" }),
  ])
  const prs = parsePrs(
    json,
    "david-crespo/ah",
    new Set(["feature"]),
    new Set(["dathagerty"]),
  )
  expect(prs[0]).toEqual({
    repo: "david-crespo/ah",
    number: 7,
    title: "A change",
    url: "https://github.com/david-crespo/ah/pull/1",
    branch: "feature",
    state: "open",
    review: "changes",
    updatedAt: "2026-11-06T14:00:00Z",
    checks: [
      { name: "CI / test", state: "failed", url: "https://ci/1" },
      { name: "lint", state: "passed", url: "https://ci/2" },
    ],
  })
  expect([prs[1].state, prs[1].review]).toEqual(["draft", "required"])
  expect([prs[2].state, prs[2].review]).toEqual(["merged", "approved"])
})

const open = (checks: Pr["checks"]): Pr => ({
  repo: "r",
  number: 1,
  title: "t",
  url: "u",
  branch: "b",
  state: "open",
  review: null,
  updatedAt: "",
  checks,
})

test("polling is quick while an open PR's checks are running, and slow otherwise", () => {
  expect(pollDelay([open([{ name: "ci", state: "pending", url: "" }])])).toBe(45_000)
  expect(pollDelay([open([{ name: "ci", state: "passed", url: "" }])])).toBe(300_000)
  expect(
    pollDelay([{ ...open([{ name: "ci", state: "pending", url: "" }]), state: "merged" }]),
  ).toBe(300_000)
  expect(pollDelay([])).toBe(300_000)
})

test("the PRs tab's label says what needs a look", () => {
  expect(prsBadge([])).toBe("")
  expect(prsBadge([open([{ name: "ci", state: "passed", url: "" }])])).toBe("✓ 1")
  expect(prsBadge([open([{ name: "ci", state: "pending", url: "" }])])).toBe("…")
  expect(
    prsBadge([
      open([{ name: "ci", state: "failed", url: "" }]),
      { ...open([]), review: "changes" },
      open([]),
    ]),
  ).toBe("✗ 2")
})
