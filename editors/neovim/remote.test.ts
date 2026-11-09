import { describe, expect, test } from "vitest"
import { hasNvim, inNvim } from "./testing.ts"

const LINES = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"

/** Lua that runs ah.remote's reveal and returns where the cursor ended up
 * (1-based line, 0-based column), the screen row its line is on in the window
 * (0-based), the window's height and the mode */
function reveal(line: number, column: number, row: number) {
  return `
    require("ah.remote").reveal(${line}, ${column}, ${row})
    sleep(50)
    local win = vim.api.nvim_get_current_win()
    local cursor = vim.api.nvim_win_get_cursor(win)
    local top = vim.fn.win_screenpos(win)[1]
    return {
      cursor = cursor,
      row = vim.fn.screenpos(win, cursor[1], 1).row - top,
      height = vim.api.nvim_win_get_height(win),
      mode = vim.api.nvim_get_mode().mode,
    }
  `
}

interface Revealed {
  cursor: [number, number]
  row: number
  height: number
  mode: string
}

describe.skipIf(!hasNvim).concurrent("revealing a line, for ⌘-click in the preview", () => {
  test("puts the cursor on the line and column", async () => {
    const result = await inNvim<Revealed>({
      file: LINES,
      lua: `vim.cmd.edit(file) ${reveal(49, 3, 5)}`,
    })
    expect(result.cursor).toEqual([50, 3])
  })

  test("puts the line on the given screen row", async () => {
    const result = await inNvim<Revealed>({
      file: LINES,
      lua: `vim.cmd.edit(file) ${reveal(49, 0, 5)}`,
    })
    expect(result.row).toEqual(5)
  })

  // Line 47 wraps to 4 rows in the 80-column headless window, so the three
  // lines above line 50 take 6 rows
  const wrapped = (() => {
    const lines = LINES.split("\n")
    lines[46] = "word ".repeat(60)
    return lines.join("\n")
  })()

  test("counts a wrapped line above as the rows it takes", async () => {
    const result = await inNvim<Revealed>({
      file: wrapped,
      lua: `vim.cmd.edit(file) ${reveal(49, 0, 7)}`,
    })
    expect(result.row).toEqual(7)
  })

  test("where a wrapped line above can't be split, takes the nearer row", async () => {
    // Row 5 falls inside line 47's rows: row 6 (line 47 shown) is nearer
    // than row 2 (line 48 at the top)
    const result = await inNvim<Revealed>({
      file: wrapped,
      lua: `vim.cmd.edit(file) ${reveal(49, 0, 5)}`,
    })
    expect(result.row).toEqual(6)
  })

  test("near the top of the file, puts the line as low as it goes", async () => {
    const result = await inNvim<Revealed>({
      file: LINES,
      lua: `vim.cmd.edit(file) ${reveal(2, 0, 10)}`,
    })
    expect(result).toMatchObject({ cursor: [3, 0], row: 2 })
  })

  test("keeps a row past the window's bottom in the window", async () => {
    const result = await inNvim<Revealed>({
      file: LINES,
      lua: `vim.cmd.edit(file) ${reveal(49, 0, 999)}`,
    })
    expect(result.row).toEqual(result.height - 1)
  })

  test("goes to the last line for a line past the end", async () => {
    const result = await inNvim<Revealed>({
      file: LINES,
      lua: `vim.cmd.edit(file) ${reveal(500, 0, 5)}`,
    })
    expect(result.cursor).toEqual([100, 0])
  })

  test("leaves insert mode for normal mode", async () => {
    const result = await inNvim<Revealed>({
      file: LINES,
      lua: `vim.cmd.edit(file) keys("ifoo") ${reveal(49, 0, 5)}`,
    })
    expect(result).toMatchObject({ cursor: [50, 0], mode: "n" })
  })

  test("leaves visual mode for normal mode", async () => {
    const result = await inNvim<Revealed>({
      file: LINES,
      lua: `vim.cmd.edit(file) keys("Vjj") ${reveal(49, 0, 5)}`,
    })
    expect(result).toMatchObject({ cursor: [50, 0], mode: "n" })
  })
})
