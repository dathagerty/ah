import { expect, test } from "vitest"
import { conversationMessage, parseConversation } from "./conversation.ts"
import type { Pr } from "./github.ts"

const response = (pr: Record<string, unknown>) =>
  JSON.stringify({ data: { repository: { pullRequest: pr } } })

const comment = (author: string, body: string, createdAt: string, url = `u-${author}`) => ({
  author: { login: author },
  body,
  bodyHTML: `<p>${body}</p>`,
  createdAt,
  url,
})

const review = (author: string, state: string, body: string, submittedAt: string) => ({
  author: { login: author },
  state,
  body,
  bodyHTML: body ? `<p>${body}</p>` : "",
  submittedAt,
  url: `r-${author}`,
})

test("the description, then comments and reviews in the order they came", () => {
  const conversation = parseConversation(
    response({
      author: { login: "martinajir" },
      body: "Drops the old token types.",
      bodyHTML: "<p>Drops the old token types.</p>",
      createdAt: "2026-10-20T10:00:00Z",
      comments: { nodes: [comment("bot", "Thanks!", "2026-10-20T10:05:00Z")] },
      reviews: {
        nodes: [
          review(
            "williammartin",
            "CHANGES_REQUESTED",
            "Remove the whole thing?",
            "2026-10-21T09:00:00Z",
          ),
          review("BagToad", "APPROVED", "", "2026-10-22T09:00:00Z"),
        ],
      },
    }),
  )
  expect(conversation.description).toEqual({
    author: "martinajir",
    body: "Drops the old token types.",
    html: "<p>Drops the old token types.</p>",
  })
  expect(conversation.items.map((i) => [i.kind, i.author, i.state])).toEqual([
    ["comment", "bot", null],
    ["review", "williammartin", "changes"],
    ["review", "BagToad", "approved"],
  ])
})

test("a review that's only a wrapper for line comments is left out: the threads show those", () => {
  const conversation = parseConversation(
    response({
      author: { login: "a" },
      body: "",
      bodyHTML: "",
      createdAt: "t",
      comments: { nodes: [] },
      reviews: {
        nodes: [
          review("x", "COMMENTED", "", "2026-10-21T09:00:00Z"),
          review("y", "COMMENTED", "Overall fine.", "2026-10-21T10:00:00Z"),
        ],
      },
    }),
  )
  expect(conversation.items.map((i) => i.author)).toEqual(["y"])
})

test("a deleted account is ghost, and a missing PR is an empty conversation", () => {
  const conversation = parseConversation(
    response({
      author: null,
      body: "x",
      bodyHTML: "<p>x</p>",
      createdAt: "t",
      comments: { nodes: [{ ...comment("z", "hi", "t2"), author: null }] },
      reviews: { nodes: [] },
    }),
  )
  expect([conversation.description.author, conversation.items[0].author]).toEqual([
    "ghost",
    "ghost",
  ])
  expect(parseConversation(JSON.stringify({ data: { repository: null } }))).toEqual({
    description: { author: "ghost", body: "", html: "" },
    items: [],
  })
})

const pr: Pr = {
  repo: "cli/cli",
  number: 14804,
  title: "Drop token types",
  url: "https://github.com/cli/cli/pull/14804",
  branch: "b",
  base: "trunk",
  author: "martinajir",
  state: "open",
  review: null,
  updatedAt: "",
  checks: [],
}

test("the agent gets the PR, who said it, and what, to act on or answer", () => {
  const [item] = parseConversation(
    response({
      author: { login: "a" },
      body: "",
      bodyHTML: "",
      createdAt: "t",
      comments: { nodes: [] },
      reviews: {
        nodes: [
          review("williammartin", "CHANGES_REQUESTED", "Remove the whole thing?", "t"),
        ],
      },
    }),
  ).items
  const m = conversationMessage(pr, item)
  expect(m).toContain("cli/cli#14804 (Drop token types)")
  expect(m).toContain("williammartin requested changes")
  expect(m).toContain("Remove the whole thing?")
  expect(m).toContain("r-williammartin")
})
