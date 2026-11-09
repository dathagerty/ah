// Runs ah's Neovim plugin (lua/ah/) in a headless nvim for the tests. The
// test's Lua runs in a coroutine inside nvim's main loop, so typed keys
// (`keys`) fire TextChanged and timers run, as in a real session. It returns
// a table, which comes back here as JSON.

import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN = dirname(fileURLToPath(import.meta.url))
const AH = join(PLUGIN, "../../ah.ts")

/** Whether nvim is on the PATH, to skip the tests where it isn't */
export const hasNvim = spawnSync("nvim", ["--version"]).status === 0

/** The repo's ah, for the plugin to run instead of the one on the PATH */
export const repoAh = [process.execPath, AH]

const DRIVER = `
vim.o.showmode = false
vim.opt.rtp:prepend(vim.env.AH_PLUGIN)
local dir = vim.env.AH_TEST_DIR
file = dir .. "/notes.md"
notices = {}
local notify = vim.notify
vim.notify = function(msg, level)
  table.insert(notices, { msg = msg, level = level })
end

function sleep(ms)
  local co = coroutine.running()
  vim.defer_fn(function() coroutine.resume(co) end, ms)
  coroutine.yield()
end
function wait_for(pred, ms)
  local waited = 0
  while not pred() and waited < (ms or 3000) do
    sleep(20)
    waited = waited + 20
  end
  return pred()
end
function read(path)
  local f = io.open(path or file, "rb")
  if not f then return nil end
  local text = f:read("*a")
  f:close()
  return text
end
-- Writes the file as the agent would, from outside nvim
function write(text, path)
  local f = io.open(path or file, "wb")
  f:write(text)
  f:close()
end
-- The current buffer's text as it would be saved
function text()
  local t = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n")
  if vim.bo.eol then t = t .. "\\n" end
  return t
end
-- Keys as the user types them, through the main loop
function keys(typed)
  vim.api.nvim_input(typed)
  sleep(20)
end

local out = vim.env.AH_TEST_OUT
coroutine.wrap(function()
  local ok, result = pcall(function()
    local test = assert(loadfile(dir .. "/test.lua"))
    return test()
  end)
  local f = io.open(out, "wb")
  f:write(vim.json.encode(ok and { ok = true, result = result or vim.empty_dict() } or { ok = false, error = tostring(result) }))
  f:close()
  vim.cmd("qa!")
end)()
`

export interface NvimRun {
  /** The file's text before nvim starts */
  file: string
  /** Lua run in nvim, which returns the table the test checks. `file` is the
   * file's path; see DRIVER for the helpers. */
  lua: string
  /** Set in nvim's environment, such as AH_PANE */
  env?: Record<string, string>
}

/** Run `lua` in a headless nvim with the plugin on the runtimepath, and
 * return what it returned. Throws with the Lua error if it failed. */
export async function inNvim<T = Record<string, unknown>>(run: NvimRun): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ah-nvim-test-"))
  try {
    await writeFile(join(dir, "notes.md"), run.file)
    await writeFile(join(dir, "test.lua"), run.lua)
    await writeFile(join(dir, "driver.lua"), DRIVER)
    const out = join(dir, "out.json")
    // Not in the pane unless the test says so, even when the tests run in one
    const { AH_PANE: _, ...outer } = process.env
    const env = {
      ...outer,
      ...run.env,
      AH_PLUGIN: PLUGIN,
      AH_TEST_DIR: dir,
      AH_TEST_OUT: out,
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "nvim",
        ["--headless", "--clean", "-c", `luafile ${dir}/driver.lua`],
        {
          env,
          stdio: "ignore",
        },
      )
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error("nvim didn't finish in 8s, maybe stuck at a prompt"))
      }, 8_000)
      child.on("error", reject)
      child.on("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const done = JSON.parse(await readFile(out, "utf8"))
    if (!done.ok) throw new Error(`in nvim: ${done.error}`)
    return done.result as T
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
