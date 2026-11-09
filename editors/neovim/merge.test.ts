import { describe, expect, test } from "vitest"
import { hasNvim, inNvim, repoAh } from "./testing.ts"

/** Lua that sets the plugin up with `cmd` as ah (the repo's by default) */
function setup(cmd: string[] = repoAh) {
  return `require("ah").setup({ cmd = vim.json.decode(${JSON.stringify(JSON.stringify(cmd))}) })`
}

const PANE = { AH_PANE: "1" }

// Longer than the pane's 650ms save delay plus a 300ms check
const SETTLE = 1500

// Longer than the harness gives nvim, so a hung nvim fails with its own error
const TIMEOUT = { timeout: 10_000 }

describe.skipIf(!hasNvim).concurrent("taking the agent's edits", TIMEOUT, () => {
  test("an unmodified buffer reloads the file on disk", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        sleep(50)
        write("one\\ntwo\\n")
        wait_for(function() return text() == "one\\ntwo\\n" end)
        return { text = text(), modified = vim.bo.modified }
      `,
    })
    expect(result).toEqual({ text: "one\ntwo\n", modified: false })
  })

  test("unsaved typing keeps the agent's edits elsewhere in the file", async () => {
    const result = await inNvim({
      file: "one\ntwo\nthree\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("ggAX<Esc>")
        write("one\\ntwo\\nthree\\nfour\\n")
        wait_for(function() return text():find("four") end)
        return { text = text(), modified = vim.bo.modified, notices = notices }
      `,
    })
    expect(result).toEqual({
      text: "oneX\ntwo\nthree\nfour\n",
      modified: true,
      notices: [],
    })
  })

  test("words both changed are marked, the user's first, with a warning", async () => {
    const result = await inNvim({
      file: "the quick fox\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("wciwslow<Esc>")
        write("the brown fox\\n")
        wait_for(function() return text():find("brown") end)
        return { text = text(), notices = notices }
      `,
    })
    expect(result).toEqual({
      text: "the {~~slow~>brown~~} fox\n",
      notices: [{ msg: expect.stringContaining("1 conflict"), level: 3 }],
    })
  })

  test("a save after a merge writes the merged text", async () => {
    const result = await inNvim({
      file: "one\ntwo\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("ggAX<Esc>")
        write("one\\ntwo\\nthree\\n")
        wait_for(function() return text():find("three") end)
        keys("<D-s>")
        wait_for(function() return read() == text() end)
        return { disk = read(), modified = vim.bo.modified }
      `,
    })
    expect(result).toEqual({ disk: "oneX\ntwo\nthree\n", modified: false })
  })

  test("after a failed merge, saves stop until a merge succeeds", async () => {
    const result = await inNvim({
      file: "one\ntwo\n",
      env: PANE,
      lua: `
        ${setup(["sh", "-c", "exit 1"])}
        vim.cmd.edit(file)
        keys("ggAX<Esc>")
        write("one\\ntwo\\nthree\\n")
        sleep(${SETTLE})
        keys("<D-s>")
        sleep(${SETTLE})
        local failed = { text = text(), disk = read(), error = notices[1] and notices[1].level }
        ${setup()}
        write("one\\ntwo\\nthree\\nfour\\n")
        wait_for(function() return read() == "oneX\\ntwo\\nthree\\nfour\\n" end)
        return { failed = failed, disk = read() }
      `,
    })
    expect(result).toEqual({
      failed: { text: "oneX\ntwo\n", disk: "one\ntwo\nthree\n", error: 4 },
      disk: "oneX\ntwo\nthree\nfour\n",
    })
  })

  test("a file without a final newline merges without a conflict", async () => {
    const result = await inNvim({
      file: "one",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("AX<Esc>")
        write("one\\ntwo")
        wait_for(function() return text():find("two") end)
        return { text = text(), notices = notices }
      `,
    })
    expect(result).toEqual({ text: "oneX\ntwo", notices: [] })
  })

  test("only the buffer whose file changed takes the change", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        local other = vim.fs.dirname(file) .. "/other.md"
        write("a\\n", other)
        vim.cmd.edit(other)
        keys("AX<Esc>")
        vim.cmd.edit(file)
        keys("AY<Esc>")
        write("a\\nb\\n", other)
        local buf = vim.fn.bufnr(other)
        local function other_text()
          return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\\n")
        end
        wait_for(function() return other_text():find("b") end)
        return { other = other_text(), current = text(), notices = notices }
      `,
    })
    expect(result).toEqual({ other: "aX\nb", current: "oneY\n", notices: [] })
  })

  test("after a merge, :w writes without asking whether to", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("AX<Esc>")
        write("one\\ntwo\\n")
        wait_for(function() return text():find("two") end)
        vim.cmd.write()
        return { disk = read() }
      `,
    })
    expect(result).toEqual({ disk: "oneX\ntwo\n" })
  })

  test("a deleted file leaves the buffer as it is", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("AX<Esc>")
        os.remove(file)
        sleep(${SETTLE})
        return { text = text(), disk = read() or vim.NIL }
      `,
    })
    expect(result).toEqual({ text: "oneX\n", disk: null })
  })
})

describe.skipIf(!hasNvim).concurrent("saving", TIMEOUT, () => {
  test("in the markdown pane, saves soon after typing stops", async () => {
    const result = await inNvim({
      file: "one\n",
      env: PANE,
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("AX<Esc>")
        wait_for(function() return read() == "oneX\\n" end)
        return { disk = read() }
      `,
    })
    expect(result).toEqual({ disk: "oneX\n" })
  })

  // Merging runs in every nvim, but auto-save only in the markdown pane,
  // where the preview follows the file
  test("outside the pane, doesn't save on its own", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        keys("AX<Esc>")
        sleep(${SETTLE})
        return { disk = read(), modified = vim.bo.modified }
      `,
    })
    expect(result).toEqual({ disk: "one\n", modified: true })
  })

  test("setting up twice, as the pane and then the user's config do, sets up once", async () => {
    const result = await inNvim({
      file: "one\n",
      env: PANE,
      lua: `
        local function count() return #vim.api.nvim_get_autocmds({ group = "ah" }) end
        ${setup()}
        local once = count()
        ${setup()}
        return { once = once, twice = count() }
      `,
    })
    expect(result.once).toBeGreaterThan(0)
    expect(result.twice).toEqual(result.once)
  })
})
