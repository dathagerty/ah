// NvimRemote against a real nvim listening on a socket, as a registered
// nvim in a Rex pane does (`ah hook editor`). Skipped without nvim.

import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { attach } from "neovim"
import { afterEach, describe, expect, test } from "vitest"
import { NvimRemote } from "./remote.ts"
import { hasNvim } from "./testing.ts"

const PLUGIN = dirname(fileURLToPath(import.meta.url))

/** A logger that says nothing, for the test's own client */
const QUIET = Object.fromEntries(
  ["info", "warn", "error", "debug"]
    .map((k) => [k, () => QUIET])
    .concat([["level", "error"]]),
) as unknown as NonNullable<NonNullable<Parameters<typeof attach>[0]["options"]>["logger"]>

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A directory with a 100-line file, and a headless nvim with the plugin
 * listening at `sock` in it */
async function nvim() {
  const dir = await mkdtemp(join(tmpdir(), "ah-remote-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "x.ts")
  await writeFile(
    file,
    Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  )
  const sock = join(dir, "nvim.sock")
  const child: ChildProcess = spawn(
    "nvim",
    ["--headless", "--clean", "--listen", sock, "--cmd", `set rtp^=${PLUGIN}`],
    { stdio: "ignore" },
  )
  cleanups.push(() => void child.kill())
  return { dir, file, sock }
}

describe.skipIf(!hasNvim)("NvimRemote", { timeout: 15_000 }, () => {
  test("opens a file at a line", async () => {
    const { file, sock } = await nvim()
    const remote = new NvimRemote(sock)
    cleanups.push(() => remote.close())
    await remote.open(file, 42)
    const client = attach({ socket: sock, options: { logger: QUIET } })
    cleanups.push(() => client.close())
    expect(await client.call("expand", ["%:p"])).toEqual(file)
    expect(await client.request("nvim_win_get_cursor", [0])).toEqual([42, 0])
  })

  test("fails at once for a socket that's gone, when told not to wait", async () => {
    const { dir } = await nvim()
    const remote = new NvimRemote(join(dir, "gone.sock"), { waitMs: 0 })
    cleanups.push(() => remote.close())
    const started = Date.now()
    await expect(remote.open(join(dir, "x.ts"), 1)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("fails for a file left where a socket was, with nothing listening", async () => {
    const { dir } = await nvim()
    const stale = join(dir, "stale.sock")
    await writeFile(stale, "")
    const remote = new NvimRemote(stale, { waitMs: 0 })
    cleanups.push(() => remote.close())
    await expect(remote.open(join(dir, "x.ts"), 1)).rejects.toThrow()
  })
})
