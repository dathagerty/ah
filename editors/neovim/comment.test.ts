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
   fs.writeFileSync(process.env.AH_FAKE_OUT, JSON.stringify({ args, stdin, disk }))
   console.log("sent")`,
  "--",
]

interface Agents {
  /** What `ah workspace agents` lists, or "fail" */
  agents?: Agent[] | "fail"
  /** The list item to pick (1-based) when asked which agent, or none to
   * dismiss the list */
  choose?: number
}

interface Agent {
  id: string
  harness: string
  label: string
  summary: string | null
  busy: boolean
  target: boolean
}

/** Lua that sets the plugin up with the fake ah, leader as space, and the
 * comment prompt answered with `answer`. Records whether the prompt was
 * shown (`asked`) and with what (`prompt`), and the agent list's items as
 * shown (`listed`). */
function setup(answer: string, { agents, choose }: Agents = {}) {
  return `
    vim.g.mapleader = " "
    vim.env.AH_FAKE_OUT = vim.fs.dirname(file) .. "/sent.json"
    vim.env.AH_FAKE_AGENTS = ${JSON.stringify(agents === "fail" ? "fail" : JSON.stringify(agents ?? []))}
    require("ah").setup({ cmd = vim.json.decode(${JSON.stringify(JSON.stringify(FAKE_AH))}) })
    asked, prompt, listed = false, vim.NIL, vim.NIL
    vim.ui.input = function(opts, done)
      asked, prompt = true, opts.prompt
      done(${JSON.stringify(answer)})
    end
    vim.ui.select = function(items, opts, done)
      listed = vim.tbl_map(opts.format_item or tostring, items)
      local i = ${choose ?? "nil"}
      done(i and items[i], i)
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

/** Lua that waits for the fake ah to run, then returns what it got, the
 * file's path and the notices */
const SENT = `
  local out = vim.env.AH_FAKE_OUT
  wait_for(function() return read(out) and #notices > 0 end, 2000)
  local sent = read(out)
  return {
    sent = sent and vim.json.decode(sent) or vim.NIL,
    file = vim.api.nvim_buf_get_name(0),
    notices = notices,
  }
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
        ${setup("fix this")}
        vim.cmd.edit(file)
        keys("j ac")
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
        ${setup("fix these")}
        vim.cmd.edit(file)
        keys("Vj ac")
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
        ${setup("fix the file")}
        vim.cmd.edit(file)
        keys(" aC")
        ${SENT}
      `,
    })
    expect(result.sent).toMatchObject({
      args: ["message", "send", "--file", result.file],
      stdin: "fix the file",
    })
  })

  test("a blank comment isn't sent", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup("   ")}
        vim.cmd.edit(file)
        keys(" ac")
        sleep(500)
        return { asked = asked, sent = read(vim.env.AH_FAKE_OUT) or vim.NIL }
      `,
    })
    expect(result).toEqual({ asked: true, sent: null })
  })

  test("a buffer with no file says so and sends nothing", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `
        ${setup("fix this")}
        keys(" ac")
        sleep(500)
        return { sent = read(vim.env.AH_FAKE_OUT) or vim.NIL, notices = notices }
      `,
    })
    expect(result).toEqual({
      sent: null,
      notices: [{ msg: "ah: this buffer isn't a file", level: 4 }],
    })
  })

  test("saves first, so the agent reads the lines the comment is on", async () => {
    const result = await inNvim<Sent>({
      file: "one\ntwo\n",
      lua: `
        ${setup("fix this")}
        vim.cmd.edit(file)
        keys("Onew<Esc>j ac")
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
        ${setup("fix this")}
        vim.cmd.edit(file)
        keys("AX<Esc> ac")
        wait_for(function() return read(vim.env.AH_FAKE_OUT) end, 2000)
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
        ${setup("fix this")}
        vim.env.AH_FAKE_MERGE_FAILS = "1"
        vim.cmd.edit(file)
        keys("AX<Esc>")
        write("one\\ntwo\\n")
        wait_for(function() return #notices > 0 end, 2000)
        keys(" ac")
        sleep(500)
        local refused = { asked = asked, sent = read(vim.env.AH_FAKE_OUT) or vim.NIL, notices = notices }
        notices = {}
        vim.env.AH_FAKE_MERGE_FAILS = nil
        write("one\\ntwo\\nthree\\n")
        wait_for(function() return text():find("three") end, 2000)
        keys(" ac")
        wait_for(function() return read(vim.env.AH_FAKE_OUT) end, 2000)
        local sent = read(vim.env.AH_FAKE_OUT)
        return {
          refused = refused,
          sent = sent and vim.json.decode(sent) or vim.NIL,
          file = vim.api.nvim_buf_get_name(0),
        }
      `,
    })
    expect(result.refused).toEqual({
      asked: false,
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

/** Lua that comments on line 1 and returns the prompt, the agent list as
 * shown, and the arguments ah got, if it got any */
const PICK = `
  vim.cmd.edit(file)
  keys(" ac")
  wait_for(function() return read(vim.env.AH_FAKE_OUT) end, 1500)
  local sent = read(vim.env.AH_FAKE_OUT)
  return {
    prompt = prompt,
    listed = listed,
    args = sent and vim.json.decode(sent).args or vim.NIL,
    file = vim.api.nvim_buf_get_name(0),
  }
`

interface Picked {
  prompt: string | null
  listed: string[] | null
  args: string[] | null
  file: string
}

describe.skipIf(!hasNvim).concurrent("picking the agent", () => {
  test("with none listed, as outside Rex, sends without asking which", async () => {
    const result = await inNvim<Picked>({
      file: "one\n",
      lua: `${setup("fix this")} ${PICK}`,
    })
    expect(result).toEqual({
      prompt: "Comment: ",
      listed: null,
      args: ["message", "send", "--file", result.file, "--lines=1"],
      file: result.file,
    })
  })

  test("with one, names it in the prompt and sends without asking which", async () => {
    const result = await inNvim<Picked>({
      file: "one\n",
      lua: `${setup("fix this", { agents: [agentA] })} ${PICK}`,
    })
    expect(result).toEqual({
      prompt: "Comment → ~/code/a | fixing login (claude): ",
      listed: null,
      args: ["message", "send", "--file", result.file, "--lines=1"],
      file: result.file,
    })
  })

  test("with several, asks which, the pane's pick first, and sends to it", async () => {
    const result = await inNvim<Picked>({
      file: "one\n",
      lua: `${setup("fix this", { agents: [agentA, agentB, agentC], choose: 2 })} ${PICK}`,
    })
    expect(result).toEqual({
      prompt: "Comment → ~/code/a | fixing login (claude): ",
      listed: [
        "~/code/b | tests (codex, working)",
        "~/code/a | fixing login (claude)",
        "~/code/c (opencode)",
      ],
      args: ["message", "send", "--file", result.file, "--lines=1", "--agent", "block:a"],
      file: result.file,
    })
  })

  test("dismissing the list sends nothing", async () => {
    const result = await inNvim<Picked>({
      file: "one\n",
      lua: `${setup("fix this", { agents: [agentA, agentB] })} ${PICK}`,
    })
    expect(result).toMatchObject({ prompt: null, args: null })
    expect(result.listed).toHaveLength(2)
  })

  test("when listing them fails, sends without asking which", async () => {
    const result = await inNvim<Picked>({
      file: "one\n",
      lua: `${setup("fix this", { agents: "fail" })} ${PICK}`,
    })
    expect(result).toEqual({
      prompt: "Comment: ",
      listed: null,
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
    keys("V ac")
    wait_for(function() return read(vim.env.AH_FAKE_OUT) end, 2000)
    local sent = read(vim.env.AH_FAKE_OUT)
    local args = sent and vim.json.decode(sent).args or {}
    for _, arg in ipairs(args) do
      if vim.startswith(arg, "--selection=") then return { selection = arg:sub(#"--selection=" + 1) } end
    end
    return { selection = vim.NIL }
  `

  test("is cut to 4000 characters, as Helix cuts it, to stay under the argument size limit", async () => {
    const result = await inNvim({
      file: `${"a".repeat(5000)}\n`,
      lua: `${setup("fix this")} ${SELECTION}`,
    })
    expect(result).toEqual({ selection: "a".repeat(4000) })
  })

  test("is cut between characters, not inside one", async () => {
    const result = await inNvim({
      file: `${"é".repeat(5000)}\n`,
      lua: `${setup("fix this")} ${SELECTION}`,
    })
    expect(result).toEqual({ selection: "é".repeat(4000) })
  })

  test("under 4000 characters, goes whole", async () => {
    const result = await inNvim({
      file: `${"a".repeat(4000)}\n`,
      lua: `${setup("fix this")} ${SELECTION}`,
    })
    expect(result).toEqual({ selection: "a".repeat(4000) })
  })
})
