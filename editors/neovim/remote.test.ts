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

/** Lua that runs ah.remote's open on `path` (relative to the test's
 * directory) at the 1-based `line`, and returns the current buffer's name
 * (relative), the cursor, the window count and the mode */
function open(path: string, line: number) {
  return `
    local dir = vim.fs.dirname(file)
    require("ah.remote").open(dir .. "/" .. ${JSON.stringify(path)}, ${line})
    sleep(50)
    return {
      name = vim.fs.basename(vim.api.nvim_buf_get_name(0)),
      cursor = vim.api.nvim_win_get_cursor(0),
      windows = #vim.api.nvim_tabpage_list_wins(0),
      mode = vim.api.nvim_get_mode().mode,
    }
  `
}

interface Opened {
  name: string
  cursor: [number, number]
  windows: number
  mode: string
}

/** Lua that writes `name` next to the test's file with 100 lines */
const writeOther = (name: string) => `
  write(${JSON.stringify(LINES)}, vim.fs.dirname(file) .. "/" .. ${JSON.stringify(name)})
`

describe
  .skipIf(!hasNvim)
  .concurrent("opening a file, for the dashboard and ah edit", () => {
    test("opens it at the line, in normal mode", async () => {
      const result = await inNvim<Opened>({
        file: "one\n",
        lua: `vim.cmd.edit(file) ${writeOther("other.ts")} ${open("other.ts", 40)}`,
      })
      expect(result).toEqual({ name: "other.ts", cursor: [40, 0], windows: 1, mode: "n" })
    })

    test("goes to a window already showing it", async () => {
      const result = await inNvim<Opened>({
        file: "one\n",
        lua: `
        ${writeOther("other.ts")}
        vim.cmd.edit(vim.fs.dirname(file) .. "/other.ts")
        vim.cmd.split(file)
        ${open("other.ts", 7)}
      `,
      })
      expect(result).toMatchObject({ name: "other.ts", cursor: [7, 0], windows: 2 })
    })

    test("keeps the unsaved text of the buffer it leaves", async () => {
      const result = await inNvim({
        file: "one\n",
        lua: `
        vim.cmd.edit(file)
        keys("Atwo<Esc>")
        ${writeOther("other.ts")}
        require("ah.remote").open(vim.fs.dirname(file) .. "/other.ts", 1)
        sleep(50)
        local left = vim.fn.bufnr(file)
        return {
          text = table.concat(vim.api.nvim_buf_get_lines(left, 0, -1, false), "\\n"),
          modified = vim.bo[left].modified,
        }
      `,
      })
      expect(result).toEqual({ text: "onetwo", modified: true })
    })

    test("takes a path with spaces", async () => {
      const result = await inNvim<Opened>({
        file: "one\n",
        lua: `vim.cmd.edit(file) ${writeOther("a b.ts")} ${open("a b.ts", 3)}`,
      })
      expect(result).toMatchObject({ name: "a b.ts", cursor: [3, 0] })
    })

    test("goes to the last line for a line past the end, and leaves insert mode", async () => {
      const result = await inNvim<Opened>({
        file: "one\n",
        lua: `vim.cmd.edit(file) keys("ifoo") ${writeOther("other.ts")} ${open("other.ts", 500)}`,
      })
      expect(result).toMatchObject({ name: "other.ts", cursor: [100, 0], mode: "n" })
    })
  })

/** Lua that fills a quickfix list with `items`, as `{file, line, col, text}`
 * relative to the test's directory */
function quickfix(
  title: string,
  items: { file: string; line: number; text: string }[],
  open = false,
) {
  return `
    do
      local dir = vim.fs.dirname(file)
      local items = vim.json.decode(${JSON.stringify(JSON.stringify(items))})
      for _, item in ipairs(items) do item.file = dir .. "/" .. item.file; item.col = 1 end
      require("ah.remote").quickfix(${JSON.stringify(title)}, items, ${open})
      sleep(50)
    end
  `
}

/** Lua returning the quickfix stack: each list's title and item texts, the
 * current list's number, and whether a quickfix window is open */
const STACK = `
  local lists = {}
  for nr = 1, vim.fn.getqflist({ nr = "$" }).nr do
    local list = vim.fn.getqflist({ nr = nr, title = 1, items = 1 })
    table.insert(lists, {
      title = list.title,
      texts = vim.tbl_map(function(i) return i.text end, list.items),
      lines = vim.tbl_map(function(i) return i.lnum end, list.items),
    })
  end
  local open = false
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.fn.getwininfo(win)[1].quickfix == 1 then open = true end
  end
  return { lists = lists, current = vim.fn.getqflist({ nr = 0 }).nr, open = open }
`

describe.skipIf(!hasNvim).concurrent("quickfix lists, for ah edit --quickfix", () => {
  test("fills a list with its title and items, and makes it current", async () => {
    const result = await inNvim({
      file: LINES,
      lua: `
        vim.cmd.edit(file)
        ${quickfix("tests to review", [
          { file: "notes.md", line: 3, text: "fails" },
          { file: "notes.md", line: 9, text: "guard" },
        ])}
        ${STACK}
      `,
    })
    expect(result).toEqual({
      lists: [{ title: "tests to review", texts: ["fails", "guard"], lines: [3, 9] }],
      current: 1,
      open: false,
    })
  })

  test("replaces the list with the same title, and adds one with a new title", async () => {
    const result = await inNvim({
      file: LINES,
      lua: `
        vim.cmd.edit(file)
        ${quickfix("tests to review", [{ file: "notes.md", line: 3, text: "first" }])}
        ${quickfix("decisions", [{ file: "notes.md", line: 5, text: "why" }])}
        ${quickfix("tests to review", [{ file: "notes.md", line: 4, text: "second" }])}
        ${STACK}
      `,
    })
    expect(result).toEqual({
      lists: [
        { title: "tests to review", texts: ["second"], lines: [4] },
        { title: "decisions", texts: ["why"], lines: [5] },
      ],
      current: 1,
      open: false,
    })
  })

  test("opens the quickfix window when asked", async () => {
    const result = await inNvim({
      file: LINES,
      lua: `
        vim.cmd.edit(file)
        ${quickfix("tests to review", [{ file: "notes.md", line: 3, text: "fails" }], true)}
        ${STACK}
      `,
    })
    expect(result).toMatchObject({ open: true })
  })

  test("otherwise leaves the layout alone and says what came", async () => {
    const result = await inNvim({
      file: LINES,
      lua: `
        vim.cmd.edit(file)
        local windows = #vim.api.nvim_list_wins()
        ${quickfix("tests to review", [
          { file: "notes.md", line: 3, text: "a" },
          { file: "notes.md", line: 4, text: "b" },
        ])}
        return { windows = #vim.api.nvim_list_wins() - windows, notices = notices }
      `,
    })
    expect(result).toEqual({
      windows: 0,
      notices: [
        expect.objectContaining({ msg: expect.stringMatching(/2 .*tests to review/) }),
      ],
    })
  })
})
