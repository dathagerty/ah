import { expect, test } from "vitest"
import { type InboxComment, parseSkepsisComment, reviewRequest } from "./inbox.ts"

/** What skepsis's --send command gets on stdin (its public contract, v1) */
const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    root: "/state/ah/reviews/acme-widgets-7",
    diff: { command: "jj diff …", toWorkingCopy: false },
    file: "src/lib.rs",
    side: "additions",
    lines: [10, 12],
    columns: null,
    code: null,
    blob: "abc",
    text: "This can overflow.",
    prompt: "src/lib.rs:10-12\nThis can overflow.",
    ...over,
  })

test("a skepsis comment keeps where it is and what it says", () => {
  expect(parseSkepsisComment(payload())).toEqual({
    file: "src/lib.rs",
    side: "additions",
    lines: [10, 12],
    text: "This can overflow.",
    prompt: "src/lib.rs:10-12\nThis can overflow.",
  })
})

test("a comment on the whole diff, with no file or lines, is kept too", () => {
  expect(parseSkepsisComment(payload({ file: null, side: null, lines: null }))).toEqual({
    file: null,
    side: null,
    lines: null,
    text: "This can overflow.",
    prompt: "src/lib.rs:10-12\nThis can overflow.",
  })
})

test("anything that isn't skepsis's comment is refused", () => {
  for (const bad of [
    "not json",
    payload({ version: 2 }),
    payload({ text: "  " }),
    payload({ lines: [10] }),
    payload({ lines: ["a", "b"] }),
    payload({ side: "middle" }),
  ])
    expect(parseSkepsisComment(bad)).toBeNull()
})

const comment = (over: Partial<InboxComment>): InboxComment => ({
  id: "1",
  file: "src/lib.rs",
  side: "additions",
  lines: [10, 10],
  text: "Nit.",
  prompt: "",
  to: "github",
  ...over,
})

test("the review posts the comments marked for GitHub, each on its side and lines", () => {
  expect(
    reviewRequest(
      [
        comment({ id: "a", lines: [10, 10], text: "One line." }),
        comment({ id: "b", lines: [3, 5], side: "deletions", text: "Why drop these?" }),
        comment({ id: "c", to: "agent" }),
        comment({ id: "d", to: null }),
      ],
      "REQUEST_CHANGES",
      "A couple of things.",
    ),
  ).toEqual({
    event: "REQUEST_CHANGES",
    body: "A couple of things.",
    comments: [
      { path: "src/lib.rs", line: 10, side: "RIGHT", body: "One line." },
      {
        path: "src/lib.rs",
        start_line: 3,
        start_side: "LEFT",
        line: 5,
        side: "LEFT",
        body: "Why drop these?",
      },
    ],
  })
})

test("a comment on no file goes into the review's own text", () => {
  expect(
    reviewRequest(
      [comment({ file: null, side: null, lines: null, text: "Overall: nice." })],
      "COMMENT",
      "",
    ),
  ).toEqual({ event: "COMMENT", body: "Overall: nice.", comments: [] })
  expect(
    reviewRequest(
      [comment({ file: null, side: null, lines: null, text: "Second thought." })],
      "APPROVE",
      "LGTM.",
    ).body,
  ).toBe("LGTM.\n\nSecond thought.")
})
