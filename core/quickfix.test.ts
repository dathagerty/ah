import { expect, test } from "vitest"
import { parseQuickfix } from "./quickfix.ts"

test("takes JSON lines, the column optional", () => {
  const text = [
    '{"file":"/r/a.ts","line":3,"col":5,"text":"fails: expected 2"}',
    '{"file":"b.ts","line":7,"text":"document this"}',
  ].join("\n")
  expect(parseQuickfix(text, "/r")).toEqual({
    ok: true,
    items: [
      { file: "/r/a.ts", line: 3, col: 5, text: "fails: expected 2" },
      { file: "/r/b.ts", line: 7, col: 1, text: "document this" },
    ],
  })
})

test("takes file:line:col: text, as rg --vimgrep and compilers print it", () => {
  const text =
    "src/a.ts:12:3: missing return\nsrc/b.ts:40: unused\n/abs/c.ts:1:1:no space after\n"
  expect(parseQuickfix(text, "/r")).toEqual({
    ok: true,
    items: [
      { file: "/r/src/a.ts", line: 12, col: 3, text: "missing return" },
      { file: "/r/src/b.ts", line: 40, col: 1, text: "unused" },
      { file: "/abs/c.ts", line: 1, col: 1, text: "no space after" },
    ],
  })
})

test("skips blank lines, and mixes the two", () => {
  const text = '\n  \na.ts:1: one\n\n{"file":"b.ts","line":2,"text":"two"}\n'
  expect(parseQuickfix(text, "/r")).toMatchObject({
    ok: true,
    items: [{ file: "/r/a.ts" }, { file: "/r/b.ts" }],
  })
})

test("an empty list is a list, which clears the one with that title", () => {
  expect(parseQuickfix("", "/r")).toEqual({ ok: true, items: [] })
})

test("refuses a line it can't read, by its number", () => {
  for (const [text, bad] of [
    ["a.ts:1: fine\njust words", 2],
    ['{"file":"a.ts","line":0,"text":"x"}', 1],
    ['{"file":"a.ts","line":2}', 1],
    ['{"line":2,"text":"x"}', 1],
    ["{not json", 1],
  ] as const)
    expect(parseQuickfix(text, "/r")).toEqual({
      ok: false,
      error: expect.stringContaining(`line ${bad}`),
    })
})
