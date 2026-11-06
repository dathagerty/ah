import { expect, test } from "vitest"
import type { Pr } from "./github.ts"
import {
  parseThreads,
  REPLY_MUTATION,
  replyArgs,
  RESOLVE_MUTATION,
  resolveArgs,
  threadMessage,
  UNRESOLVE_MUTATION,
} from "./threads.ts"

const node = (over: Record<string, unknown>) => ({
  id: "PRRT_1",
  isResolved: false,
  isOutdated: false,
  path: "internal/attachments/client.go",
  line: 74,
  originalLine: 74,
  comments: {
    nodes: [
      {
        author: { login: "williammartin" },
        body: "Is this _all_ the token types now?",
        bodyHTML: "<p>Is this <em>all</em> the token types now?</p>",
        createdAt: "2026-10-23T18:41:21Z",
        url: "https://github.com/cli/cli/pull/14804#discussion_r1",
      },
    ],
  },
  ...over,
})

const response = (nodes: unknown[]) =>
  JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } })

test("a PR's review threads, each with where it is and its comments", () => {
  expect(parseThreads(response([node({})]))).toEqual([
    {
      id: "PRRT_1",
      path: "internal/attachments/client.go",
      line: 74,
      resolved: false,
      outdated: false,
      comments: [
        {
          author: "williammartin",
          body: "Is this _all_ the token types now?",
          html: "<p>Is this <em>all</em> the token types now?</p>",
          url: "https://github.com/cli/cli/pull/14804#discussion_r1",
        },
      ],
    },
  ])
})

test("an outdated thread keeps the line it was left on", () => {
  const [t] = parseThreads(
    response([node({ isOutdated: true, line: null, originalLine: 61 })]),
  )
  expect([t.outdated, t.line]).toEqual([true, 61])
})

test("unresolved threads come first", () => {
  const threads = parseThreads(
    response([
      node({ id: "a", isResolved: true }),
      node({ id: "b" }),
      node({ id: "c", isResolved: true }),
    ]),
  )
  expect(threads.map((t) => t.id)).toEqual(["b", "a", "c"])
})

test("a comment by a deleted account still shows", () => {
  const [t] = parseThreads(
    response([node({ comments: { nodes: [{ author: null, body: "x", url: "u" }] } })]),
  )
  expect(t.comments[0].author).toBe("ghost")
})

const pr: Pr = {
  repo: "cli/cli",
  number: 14804,
  title: "Drop token types",
  url: "https://github.com/cli/cli/pull/14804",
  branch: "drop-tokens",
  base: "trunk",
  author: "me",
  state: "open",
  review: "changes",
  updatedAt: "",
  checks: [],
}

test("the agent gets the PR, where the thread is, and the whole thread, to answer or fix", () => {
  const [t] = parseThreads(
    response([
      node({
        comments: {
          nodes: [
            { author: { login: "reviewer" }, body: "Why keep this?", url: "https://x/1" },
            {
              author: { login: "me" },
              body: "Refresh tokens still need it.",
              url: "https://x/2",
            },
          ],
        },
      }),
    ]),
  )
  const message = threadMessage(pr, t)
  expect(message).toContain("cli/cli#14804 (Drop token types)")
  expect(message).toContain("internal/attachments/client.go:74")
  expect(message).toContain("reviewer: Why keep this?")
  expect(message).toContain("me: Refresh tokens still need it.")
  expect(message).toContain("https://x/1")
  expect(message.indexOf("reviewer:")).toBeLessThan(message.indexOf("me:"))
})

test("an outdated thread says so, since the line may have moved", () => {
  const [t] = parseThreads(
    response([node({ isOutdated: true, line: null, originalLine: 61 })]),
  )
  expect(threadMessage(pr, t)).toContain("internal/attachments/client.go:61 (outdated")
})

test("a reply goes to the thread by id, its text as a string, not a number or a flag", () => {
  expect(replyArgs("PRRT_1", "-5 or true")).toEqual([
    "api",
    "graphql",
    "-f",
    `query=${REPLY_MUTATION}`,
    "-f",
    "threadId=PRRT_1",
    "-f",
    "body=-5 or true",
  ])
  expect(REPLY_MUTATION).toContain("addPullRequestReviewThreadReply")
})

test("resolving and unresolving are each their own mutation", () => {
  expect(resolveArgs("PRRT_1", true)).toEqual([
    "api",
    "graphql",
    "-f",
    `query=${RESOLVE_MUTATION}`,
    "-f",
    "threadId=PRRT_1",
  ])
  expect(resolveArgs("PRRT_1", false)[3]).toBe(`query=${UNRESOLVE_MUTATION}`)
  expect(RESOLVE_MUTATION).toContain("resolveReviewThread")
  expect(UNRESOLVE_MUTATION).toContain("unresolveReviewThread")
})
