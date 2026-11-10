import { describe, expect, test } from "vitest"
import { hasNvim, inNvim, repoAh } from "./testing.ts"

// An ah that writes what it was run with to $AH_FAKE_OUT, as JSON, with the
// --file as it was on disk then (what the agent would read), and prints
// `sent` as `ah message send` does. Merges (`view merge`) go to the repo's
// ah, or fail with $AH_FAKE_MERGE_FAILS set. `workspace agents` lists
// $AH_FAKE_AGENTS (a JSON array), one per line, or fails with "fail".
const FAKE_AH = [
  process.execPath,
  "-e",
  `const fs = require("fs")
   const args = process.argv.slice(1)
   if (args[0] === "workspace") {
     const agents = process.env.AH_FAKE_AGENTS
     if (agents === "fail") process.exit(1)
     for (const agent of JSON.parse(agents || "[]")) console.log(JSON.stringify(agent))
     process.exit(0)
   }
   const stdin = fs.readFileSync(0, "utf8")
   if (args[0] === "view" && process.env.AH_FAKE_MERGE_FAILS) process.exit(1)
   if (args[0] === "view") {
     const [node, ...ah] = ${JSON.stringify(repoAh)}
     const merged = require("child_process").execFileSync(node, [...ah, ...args], { input: stdin })
     process.stdout.write(merged)
     process.exit(0)
   }
   const disk = fs.readFileSync(args[args.indexOf("--file") + 1], "utf8")
   // Renamed into place, so a reader never sees it half written
   fs.writeFileSync(process.env.AH_FAKE_OUT + ".tmp", JSON.stringify({ args, stdin, disk }))
   fs.renameSync(process.env.AH_FAKE_OUT + ".tmp", process.env.AH_FAKE_OUT)
   console.log("sent")`,
  "--",
]

interface Agent {
  id: string
  harness: string
  label: string
  summary: string | null
  busy: boolean
  target: boolean
}

/** Lua that sets the plugin up with the fake ah listing `agents` (or failing
 * to, with "fail"), leader as space and rounded borders, as in the user's
 * config. Then helpers for the comment float:
 *
 * - `float()`: its window, if it's open
 * - `title()` and `footer()`: its title and footer, trimmed
 * - `comment(open, answer)`: type `open` (the keys that open it), wait for
 *   it to open in insert mode, then type `answer` and Enter if given. False
 *   if it didn't.
 * - `sent()`: what the fake ah got for the comment, waiting for it a while,
 *   or vim.NIL
 */
function setup(agents: Agent[] | "fail" = []) {
  return `
    vim.g.mapleader = " "
    vim.o.winborder = "rounded"
    vim.env.AH_FAKE_OUT = vim.fs.dirname(file) .. "/sent.json"
    vim.env.AH_FAKE_AGENTS = ${JSON.stringify(agents === "fail" ? "fail" : JSON.stringify(agents))}
    require("ah").setup({ cmd = vim.json.decode(${JSON.stringify(JSON.stringify(FAKE_AH))}) })

    function float()
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_get_config(win).relative ~= "" then return win end
      end
    end
    local function text_of_chunks(chunks)
      if type(chunks) == "string" then return chunks end
      local s = ""
      for _, chunk in ipairs(chunks or {}) do s = s .. chunk[1] end
      return s
    end
    function title()
      local win = float()
      return win and vim.trim(text_of_chunks(vim.api.nvim_win_get_config(win).title)) or vim.NIL
    end
    function footer()
      local win = float()
      return win and vim.trim(text_of_chunks(vim.api.nvim_win_get_config(win).footer)) or vim.NIL
    end
    function comment(open, answer)
      keys(open)
      -- Insert mode starts when the main loop next runs, after the float opens
      local ready = function() return float() and vim.api.nvim_get_mode().mode == "i" end
      if not wait_for(ready, 1500) then return false end
      if answer then keys(answer .. "<CR>") end
      return true
    end
    function sent(ms)
      wait_for(function() return read(vim.env.AH_FAKE_OUT) end, ms or 1500)
      local out = read(vim.env.AH_FAKE_OUT)
      return out and vim.json.decode(out) or vim.NIL
    end
  `
}

const agentA: Agent = {
  id: "block:a",
  harness: "claude",
  label: "~/code/a",
  summary: "fixing login",
  busy: false,
  target: false,
}
const agentB: Agent = {
  id: "block:b",
  harness: "codex",
  label: "~/code/b",
  summary: "tests",
  busy: true,
  target: true,
}
const agentC: Agent = {
  id: "block:c",
  harness: "opencode",
  label: "~/code/c",
  summary: null,
  busy: false,
  target: false,
}

/** Lua returning what was sent, the file's path and the notices */
const SENT = `
  local got = sent()
  wait_for(function() return #notices > 0 end, 500)
  return { sent = got, file = vim.api.nvim_buf_get_name(0), notices = notices }
`

interface Sent {
  sent: { args: string[]; stdin: string; disk: string }
  file: string
  notices: { msg: string; level: number }[]
}

describe.skipIf(!hasNvim).concurrent("commenting to the agent", () => {
  test("on the cursor's line", async () => {
    const result = await inNvim<Sent>({
      file: "one\ntwo\nthree\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment("j ac", "fix this")
        ${SENT}
      `,
    })
    expect(result.sent).toMatchObject({
      args: ["message", "send", "--file", result.file, "--lines=2"],
      stdin: "fix this",
    })
    expect(result.notices).toEqual([{ msg: "ah: sent to agent" }])
  })

  test("on selected lines, with the selected text", async () => {
    const result = await inNvim<Sent>({
      file: "one\ntwo\nthree\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment("Vj ac", "fix these")
        ${SENT}
      `,
    })
    expect(result.sent).toMatchObject({
      args: [
        "message",
        "send",
        "--file",
        result.file,
        "--lines=1-2",
        "--selection=one\ntwo",
      ],
      stdin: "fix these",
    })
  })

  test("on the whole file", async () => {
    const result = await inNvim<Sent>({
      file: "one\ntwo\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" aC", "fix the file")
        ${SENT}
      `,
    })
    expect(result.sent).toMatchObject({
      args: ["message", "send", "--file", result.file],
      stdin: "fix the file",
    })
  })

  test("a blank comment closes the float and isn't sent", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        local opened = comment(" ac", "   ")
        return { opened = opened, open = float() ~= nil, sent = sent(500) }
      `,
    })
    expect(result).toEqual({ opened: true, open: false, sent: null })
  })

  test("a buffer with no file says so and sends nothing", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        local opened = comment(" ac")
        return { opened = opened, notices = notices }
      `,
    })
    expect(result).toEqual({
      opened: false,
      notices: [{ msg: "ah: this buffer isn't a file", level: 4 }],
    })
  })

  test("saves first, so the agent reads the lines the comment is on", async () => {
    const result = await inNvim<Sent>({
      file: "one\ntwo\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment("Onew<Esc>j ac", "fix this")
        ${SENT}
      `,
    })
    expect(result.sent).toEqual({
      args: ["message", "send", "--file", result.file, "--lines=2"],
      stdin: "fix this",
      disk: "new\none\ntwo\n",
    })
  })

  test("the save before a comment is the base for merging the agent's next edit", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment("AX<Esc> ac", "fix this")
        sent()
        keys("AY<Esc>")
        write("oneX\\ntwo\\n")
        wait_for(function() return text():find("two") end, 2000)
        local conflicts = vim.tbl_filter(function(n) return n.msg:find("conflict") end, notices)
        return { text = text(), conflicts = #conflicts }
      `,
    })
    expect(result).toEqual({ text: "oneXY\ntwo\n", conflicts: 0 })
  })

  test("after a failed merge, refuses to comment until a merge succeeds", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.env.AH_FAKE_MERGE_FAILS = "1"
        vim.cmd.edit(file)
        keys("AX<Esc>")
        write("one\\ntwo\\n")
        wait_for(function() return #notices > 0 end, 2000)
        local refused = { opened = comment(" ac"), sent = sent(300), notices = notices }
        notices = {}
        vim.env.AH_FAKE_MERGE_FAILS = nil
        write("one\\ntwo\\nthree\\n")
        wait_for(function() return text():find("three") end, 2000)
        comment(" ac", "fix this")
        return { refused = refused, sent = sent(), file = vim.api.nvim_buf_get_name(0) }
      `,
    })
    expect(result.refused).toEqual({
      opened: false,
      sent: null,
      notices: [
        { msg: expect.stringContaining("couldn't merge"), level: 4 },
        { msg: expect.stringContaining("not sending"), level: 4 },
      ],
    })
    expect(result.sent).toEqual({
      args: ["message", "send", "--file", result.file, "--lines=1"],
      stdin: "fix this",
      disk: "oneX\ntwo\nthree\n",
    })
  })
})

describe.skipIf(!hasNvim).concurrent("where answers go", () => {
  const REX = { REX_BLOCK: "block:t1" }

  test("in a Rex pane, a comment on lines says the editor takes answers in quickfix", async () => {
    const result = await inNvim({
      file: "one\ntwo\n",
      env: REX,
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment("j ac", "why?")
        return { args = sent().args, file = vim.api.nvim_buf_get_name(0) }
      `,
    })
    expect(result.args).toEqual([
      "message",
      "send",
      "--file",
      result.file,
      "--lines=2",
      "--quickfix-answers",
    ])
  })

  test("a comment on the whole file doesn't, nor one outside Rex", async () => {
    const result = await inNvim({
      file: "one\n",
      env: REX,
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" aC", "why?")
        return { args = sent().args }
      `,
    })
    expect(result.args).not.toContain("--quickfix-answers")
    const outside = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" ac", "why?")
        return { args = sent().args }
      `,
    })
    expect(outside.args).not.toContain("--quickfix-answers")
  })
})

describe.skipIf(!hasNvim).concurrent("the comment float", () => {
  const LINES = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"

  test("opens under the commented lines, in insert mode", async () => {
    const result = await inNvim({
      file: LINES,
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        local main = vim.api.nvim_get_current_win()
        comment("2jVj ac")
        local line = vim.fn.screenpos(main, 4, 1).row
        return { float_row = vim.api.nvim_win_get_position(float())[1], line_row = line, mode = vim.api.nvim_get_mode().mode }
      `,
    })
    // screenpos counts rows from 1, window positions from 0: the float starts
    // on a row past the last commented line's
    expect(result.float_row).toBeGreaterThanOrEqual(result.line_row as number)
    expect(result.mode).toEqual("i")
  })

  test("opens above the commented lines when there's no room under them", async () => {
    const result = await inNvim({
      file: LINES,
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        local main = vim.api.nvim_get_current_win()
        comment("L ac")
        local line = vim.fn.screenpos(main, vim.fn.line("w$", main), 1).row
        return { float_row = vim.api.nvim_win_get_position(float())[1], line_row = line }
      `,
    })
    expect(result.float_row).toBeLessThan((result.line_row as number) - 1)
  })

  test("grows with the text, up to 8 lines, and is at most 72 columns wide", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" ac")
        local win = float()
        local heights = { vim.api.nvim_win_get_height(win) }
        keys("a<C-j>b<C-j>c")
        table.insert(heights, vim.api.nvim_win_get_height(win))
        keys(string.rep("<C-j>x", 10))
        table.insert(heights, vim.api.nvim_win_get_height(win))
        return { heights = heights, width = vim.api.nvim_win_get_width(win) }
      `,
    })
    expect(result.heights).toEqual([1, 3, 8])
    expect(result.width).toBeLessThanOrEqual(72)
  })

  test("Ctrl-J, Shift-Enter and Alt-Enter add lines", async () => {
    const result = await inNvim<Sent>({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" ac", "a<C-j>b<S-CR>c<M-CR>d")
        ${SENT}
      `,
    })
    expect(result.sent.stdin).toEqual("a\nb\nc\nd")
  })

  test("Esc goes to normal mode and keeps the text; Esc again cancels", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" ac")
        keys("fix<Esc>")
        local after_one = { open = float() ~= nil, mode = vim.api.nvim_get_mode().mode }
        keys("<Esc>")
        return { after_one = after_one, open = float() ~= nil, sent = sent(500) }
      `,
    })
    expect(result).toEqual({
      after_one: { open: true, mode: "n" },
      open: false,
      sent: null,
    })
  })

  test("Enter in normal mode sends", async () => {
    const result = await inNvim<Sent>({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" ac")
        keys("fix this<Esc><CR>")
        ${SENT}
      `,
    })
    expect(result.sent.stdin).toEqual("fix this")
  })

  // Not Ctrl-C: typed, it interrupts before any mapping of it runs, in insert
  // or normal mode, so it only leaves insert mode, as Esc does
  test("q in normal mode cancels", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        local opened = comment(" ac")
        keys("fix<Esc>q")
        return { opened = opened, open = float() ~= nil, sent = sent(500) }
      `,
    })
    expect(result).toEqual({ opened: true, open: false, sent: null })
  })

  test("leaving it closes it without sending", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        local main = vim.api.nvim_get_current_win()
        local opened = comment(" ac")
        keys("fix")
        vim.api.nvim_set_current_win(main)
        sleep(50)
        return { opened = opened, open = float() ~= nil, sent = sent(500) }
      `,
    })
    expect(result).toEqual({ opened: true, open: false, sent: null })
  })

  test("is titled with the file and lines, and its footer shows the keys", async () => {
    const result = await inNvim({
      file: "one\ntwo\nthree\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment("Vj ac")
        local on_lines = { title = title(), footer = footer() }
        keys("<Esc><Esc>")
        comment(" aC")
        return { on_lines = on_lines, on_file = title() }
      `,
    })
    expect(result).toEqual({
      on_lines: { title: "notes.md:1-2", footer: "⏎ send · ⌃J newline · esc cancel" },
      on_file: "notes.md",
    })
  })
})

describe.skipIf(!hasNvim).concurrent("picking the agent", () => {
  test("with none listed, as outside Rex, sends without --agent", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup()}
        vim.cmd.edit(file)
        comment(" ac")
        local shown = title()
        keys("fix this<CR>")
        return { title = shown, args = sent().args, file = vim.api.nvim_buf_get_name(0) }
      `,
    })
    expect(result).toEqual({
      title: "notes.md:1",
      args: ["message", "send", "--file", result.file, "--lines=1"],
      file: result.file,
    })
  })

  test("with one, names it in the title and sends without --agent", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup([agentA])}
        vim.cmd.edit(file)
        comment(" ac")
        local shown = { title = title(), footer = footer() }
        keys("fix this<CR>")
        return { shown = shown, args = sent().args, file = vim.api.nvim_buf_get_name(0) }
      `,
    })
    expect(result).toEqual({
      shown: {
        title: "notes.md:1 → ~/code/a | fixing login (claude)",
        footer: "⏎ send · ⌃J newline · esc cancel",
      },
      args: ["message", "send", "--file", result.file, "--lines=1"],
      file: result.file,
    })
  })

  test("with several, starts on the pane's pick and sends to it with --agent", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup([agentA, agentB, agentC])}
        vim.cmd.edit(file)
        comment(" ac")
        local shown = { title = title(), footer = footer() }
        keys("fix this<CR>")
        return { shown = shown, args = sent().args, file = vim.api.nvim_buf_get_name(0) }
      `,
    })
    expect(result).toEqual({
      shown: {
        title: "notes.md:1 → ~/code/b | tests (codex, working)",
        footer: "⏎ send · ⌃J newline · ⇥ agent · esc cancel",
      },
      args: ["message", "send", "--file", result.file, "--lines=1", "--agent", "block:b"],
      file: result.file,
    })
  })

  test("Tab and Shift-Tab cycle the agents, in either mode, and send to the one shown", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup([agentA, agentB, agentC])}
        vim.cmd.edit(file)
        comment(" ac")
        local titles = {}
        keys("<Tab>")
        table.insert(titles, title())
        keys("<S-Tab><S-Tab>")
        table.insert(titles, title())
        keys("<Esc><Tab>")
        table.insert(titles, title())
        keys("<S-Tab>ifix this<CR>")
        return { titles = titles, args = sent().args, file = vim.api.nvim_buf_get_name(0) }
      `,
    })
    expect(result).toEqual({
      titles: [
        "notes.md:1 → ~/code/a | fixing login (claude)",
        "notes.md:1 → ~/code/c (opencode)",
        "notes.md:1 → ~/code/b | tests (codex, working)",
      ],
      args: ["message", "send", "--file", result.file, "--lines=1", "--agent", "block:c"],
      file: result.file,
    })
  })

  test("when listing them fails, sends without --agent", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup("fail")}
        vim.cmd.edit(file)
        comment(" ac")
        local shown = title()
        keys("fix this<CR>")
        return { title = shown, args = sent().args, file = vim.api.nvim_buf_get_name(0) }
      `,
    })
    expect(result).toEqual({
      title: "notes.md:1",
      args: ["message", "send", "--file", result.file, "--lines=1"],
      file: result.file,
    })
  })
})

describe.skipIf(!hasNvim).concurrent("the selection a comment sends", () => {
  /** Lua that comments on line 1, selected whole, and returns the
   * --selection ah got */
  const SELECTION = `
    vim.cmd.edit(file)
    comment("V ac", "fix this")
    local got = sent()
    for _, arg in ipairs(got ~= vim.NIL and got.args or {}) do
      if vim.startswith(arg, "--selection=") then return { selection = arg:sub(#"--selection=" + 1) } end
    end
    return { selection = vim.NIL }
  `

  test("is cut to 4000 characters, to stay under the argument size limit", async () => {
    const result = await inNvim({
      file: `${"a".repeat(5000)}\n`,
      lua: `${setup()} ${SELECTION}`,
    })
    expect(result).toEqual({ selection: "a".repeat(4000) })
  })

  test("is cut between characters, not inside one", async () => {
    const result = await inNvim({
      file: `${"é".repeat(5000)}\n`,
      lua: `${setup()} ${SELECTION}`,
    })
    expect(result).toEqual({ selection: "é".repeat(4000) })
  })

  test("under 4000 characters, goes whole", async () => {
    const result = await inNvim({
      file: `${"a".repeat(4000)}\n`,
      lua: `${setup()} ${SELECTION}`,
    })
    expect(result).toEqual({ selection: "a".repeat(4000) })
  })
})
