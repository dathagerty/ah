import { describe, expect, test } from "vitest"
import { hasNvim, inNvim } from "./testing.ts"

// An ah that appends what it was run with to $AH_FAKE_LOG, a JSON line each
const FAKE_AH = [
  process.execPath,
  "-e",
  `require("fs").appendFileSync(process.env.AH_FAKE_LOG, JSON.stringify(process.argv.slice(1)) + "\\n")`,
  "--",
]

/** Lua that sets the plugin up with the fake ah, and `ran()`: the ah
 * commands run so far, after waiting `ms` for them */
const SETUP = `
  vim.env.AH_FAKE_LOG = vim.fs.dirname(file) .. "/ran.log"
  function ran(ms)
    sleep(ms or 500)
    local log = read(vim.env.AH_FAKE_LOG) or ""
    local lines = {}
    for line in vim.gsplit(log, "\\n", { trimempty = true }) do table.insert(lines, vim.json.decode(line)) end
    return lines
  end
`
const setup = () =>
  `${SETUP} require("ah").setup({ cmd = vim.json.decode(${JSON.stringify(JSON.stringify(FAKE_AH))}) })`

const REX = { REX_BLOCK: "block:t1" }

describe.skipIf(!hasNvim).concurrent("telling ah about the nvim in a Rex pane", () => {
  test("says it started, with the socket it listens on", async () => {
    const result = await inNvim({
      file: "one\n",
      env: REX,
      lua: `${setup()} return { ran = ran(), server = vim.v.servername }`,
    })
    expect(result.server).not.toEqual("")
    expect(result.ran).toEqual([["hook", "editor", "start", "--server", result.server]])
  })

  test("says it ended when it quits", async () => {
    const result = await inNvim({
      file: "one\n",
      env: REX,
      lua: `
        ${setup()}
        ran()
        vim.api.nvim_exec_autocmds("VimLeavePre", {})
        return { ran = ran(), server = vim.v.servername }
      `,
    })
    expect(result.ran).toEqual([
      ["hook", "editor", "start", "--server", result.server],
      ["hook", "editor", "end", "--server", result.server],
    ])
  })

  test("set up after it started, says so right away", async () => {
    const result = await inNvim({
      file: "one\n",
      env: REX,
      lua: `
        ${SETUP}
        sleep(200)
        require("ah").setup({ cmd = vim.json.decode(${JSON.stringify(JSON.stringify(FAKE_AH))}) })
        return { ran = ran(), server = vim.v.servername }
      `,
    })
    expect(result.ran).toEqual([["hook", "editor", "start", "--server", result.server]])
  })

  test("says nothing in the markdown pane, which has a socket of its own", async () => {
    const result = await inNvim({
      file: "one\n",
      env: { ...REX, AH_PANE: "1" },
      lua: `${setup()} return { ran = ran() }`,
    })
    expect(result.ran).toEqual([])
  })

  test("says nothing outside Rex", async () => {
    const result = await inNvim({
      file: "one\n",
      lua: `${setup()} return { ran = ran() }`,
    })
    expect(result.ran).toEqual([])
  })
})
