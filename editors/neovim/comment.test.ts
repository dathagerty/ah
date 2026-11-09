import { describe, expect, test } from "vitest"
import { hasNvim, inNvim, repoAh } from "./testing.ts"

// An ah that writes what it was run with to $AH_FAKE_OUT, as JSON, with the
// --file as it was on disk then (what the agent would read), and prints
// `sent` as `ah message send` does. Merges (`view merge`) go to the repo's
// ah, or fail with $AH_FAKE_MERGE_FAILS set.
const FAKE_AH = [
  process.execPath,
  "-e",
  `const fs = require("fs")
   const args = process.argv.slice(1)
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

/** Lua that sets the plugin up with the fake ah, leader as space, and the
 * comment prompt answered with `answer` */
function setup(answer: string) {
  return `
    vim.g.mapleader = " "
    vim.env.AH_FAKE_OUT = vim.fs.dirname(file) .. "/sent.json"
    require("ah").setup({ cmd = vim.json.decode(${JSON.stringify(JSON.stringify(FAKE_AH))}) })
    asked = false
    vim.ui.input = function(_, done)
      asked = true
      done(${JSON.stringify(answer)})
    end
  `
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
