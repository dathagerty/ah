import { expect, test } from "vitest"
import { blockForLine } from "./block_for_line.ts"

// Each block's source lines, [start, end), as its data-line has them

test("is the block holding the line", () => {
  expect(
    blockForLine(
      [
        [0, 2],
        [3, 5],
        [6, 9],
      ],
      4,
    ),
  ).toEqual(1)
  expect(
    blockForLine(
      [
        [0, 2],
        [3, 5],
        [6, 9],
      ],
      6,
    ),
  ).toEqual(2)
})

test("is the innermost of the blocks holding it", () => {
  // A list and its items, a blockquote and its paragraph
  expect(
    blockForLine(
      [
        [0, 10],
        [2, 4],
        [4, 10],
        [5, 7],
      ],
      6,
    ),
  ).toEqual(3)
  expect(
    blockForLine(
      [
        [0, 10],
        [2, 4],
      ],
      3,
    ),
  ).toEqual(1)
})

test("between blocks, is the one before", () => {
  expect(
    blockForLine(
      [
        [0, 2],
        [3, 5],
      ],
      2,
    ),
  ).toEqual(0)
})

test("before the first block, is the first; past the last, the last", () => {
  expect(
    blockForLine(
      [
        [2, 4],
        [5, 6],
      ],
      0,
    ),
  ).toEqual(0)
  expect(
    blockForLine(
      [
        [0, 2],
        [3, 4],
      ],
      50,
    ),
  ).toEqual(1)
})

test("is none without blocks", () => {
  expect(blockForLine([], 3)).toBeNull()
})
