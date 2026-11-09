import { expect, test } from "vitest"
import { revealRow } from "./reveal_row.ts"

// A 40-row terminal with 20px rows from y = 100, and Neovim's two status rows:
// 38 rows of text, so a fifth is 8 rows
const pane = { screenTop: 100, cellHeight: 20, rows: 40, statusRows: 2, scrolloff: 0 }

test("is the text row level with y", () => {
  expect(revealRow({ ...pane, y: 100 + 20 * 15 + 5 })).toEqual(15)
})

test("stays a fifth of the text rows from the top", () => {
  expect(revealRow({ ...pane, y: 110 })).toEqual(8)
})

test("stays a fifth of the text rows from the bottom", () => {
  expect(revealRow({ ...pane, y: 100 + 20 * 39 })).toEqual(38 - 1 - 8)
})

test("stays the editor's scrolloff from the edges where that's more", () => {
  expect(revealRow({ ...pane, scrolloff: 12, y: 110 })).toEqual(12)
})

test("treats a y above the pane as its top", () => {
  expect(revealRow({ ...pane, y: 0 })).toEqual(8)
})
