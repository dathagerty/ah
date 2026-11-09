// The Neovim pane end to end: real nvim in a pty (pty.ts, neovim_command.ts)
// with ah's plugin, and the page's reveal (⌘-click in the preview) done over
// nvim's RPC socket. nvim gets empty config and data directories, so the
// user's config doesn't matter. Skipped without nvim on the PATH.

import { EventEmitter } from "node:events"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attach, type NeovimClient } from "neovim"
import { afterEach, describe, expect, test } from "vitest"
import type { WebSocket } from "ws"
import { hasNvim } from "../../editors/neovim/testing.ts"
import { neovimCommand } from "./neovim_command.ts"
import { PtyBackend } from "./pty.ts"
import type { TerminalCommand } from "./terminal_editor.ts"

/** The pane's socket, as PtyBackend uses it */
class Socket extends EventEmitter {
  OPEN = 1
  readyState = 1
  send() {}
  close() {
    this.readyState = 3
    this.emit("close")
  }
  /** A message from the page */
  post(msg: object) {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A logger that says nothing, for the test's own client */
const QUIET = Object.fromEntries(
  ["info", "warn", "error", "debug"]
    .map((k) => [k, () => QUIET])
    .concat([["level", "error"]]),
) as unknown as NonNullable<NonNullable<Parameters<typeof attach>[0]["options"]>["logger"]>

/** `check` once it's true, or after a few seconds anyway */
async function eventually<T>(
  check: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  let value = await check()
  for (let i = 0; i < 50 && !done(value); i++) {
    await sleep(100)
    value = await check()
  }
  return value
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A pane on a 100-line file: the backend, its socket, and a client attached
 * to its nvim the way the backend attaches */
async function pane() {
  const dir = await mkdtemp(join(tmpdir(), "ah-nvim-pane-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "notes.md")
  await writeFile(
    file,
    Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  )
  let socket: string | undefined
  const command: TerminalCommand = async (path) => {
    const started = await neovimCommand(path)
    socket = started.socket
    return started
  }
  const empty = join(dir, "xdg")
  const backend = new PtyBackend(file, command, {
    XDG_CONFIG_HOME: empty,
    XDG_DATA_HOME: empty,
    XDG_STATE_HOME: empty,
  })
  const ws = new Socket()
  cleanups.push(() => backend.close())
  cleanups.push(() => ws.close())
  await backend.connect(ws as unknown as WebSocket, new URLSearchParams("cols=80&rows=24"))
  return {
    ws,
    /** A client of our own on the pane's nvim, once its socket is up */
    async client(): Promise<NeovimClient> {
      const path = await eventually(
        async () =>
          (socket &&
            (await access(socket).then(
              () => socket,
              () => undefined,
            ))) ||
          undefined,
        (s) => s !== undefined,
      )
      if (!path) throw new Error("the pane's nvim never listened")
      // A logger of its own, or the client takes over the console
      const nvim = attach({ socket: path, options: { logger: QUIET } })
      cleanups.push(() => nvim.close())
      return nvim
    },
  }
}

// Longer than eventually waits, so a pane that never listens fails saying so
describe.skipIf(!hasNvim)("the Neovim pane", { timeout: 15_000 }, () => {
  test("listens on a socket of its own", async () => {
    const { client } = await pane()
    const nvim = await client()
    // It listens before it has loaded the file
    const lines = await eventually(
      () => nvim.call("line", ["$"]) as Promise<number>,
      (n) => n === 100,
    )
    expect(lines).toEqual(100)
  })

  test("reveals a line over RPC, in normal mode, sent as soon as the pane opens", async () => {
    const { ws, client } = await pane()
    ws.post({ type: "reveal", line: 49, column: 3, row: 5 })
    const nvim = await client()
    const cursor = await eventually(
      () => nvim.request("nvim_win_get_cursor", [0]) as Promise<[number, number]>,
      ([line]) => line === 50,
    )
    expect(cursor).toEqual([50, 3])
    expect(await nvim.request("nvim_get_mode", [])).toMatchObject({ mode: "n" })
  })

  test("leaves the server's console alone", async () => {
    const before = { log: console.log, error: console.error, warn: console.warn }
    const { ws, client } = await pane()
    ws.post({ type: "reveal", line: 49, column: 0, row: 5 })
    const nvim = await client()
    await eventually(
      () => nvim.request("nvim_win_get_cursor", [0]) as Promise<[number, number]>,
      ([line]) => line === 50,
    )
    expect({ log: console.log, error: console.error, warn: console.warn }).toEqual(before)
  })

  test("takes later reveals too", async () => {
    const { ws, client } = await pane()
    const nvim = await client()
    ws.post({ type: "reveal", line: 49, column: 0, row: 5 })
    await eventually(
      () => nvim.request("nvim_win_get_cursor", [0]) as Promise<[number, number]>,
      ([line]) => line === 50,
    )
    ws.post({ type: "reveal", line: 9, column: 0, row: 2 })
    const cursor = await eventually(
      () => nvim.request("nvim_win_get_cursor", [0]) as Promise<[number, number]>,
      ([line]) => line === 10,
    )
    expect(cursor).toEqual([10, 0])
  })
})

test("a pane whose editor has no socket ignores a reveal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-pty-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, "notes.md")
  await writeFile(file, "one\n")
  const backend = new PtyBackend(file, async () => ({ command: "sleep", args: ["5"] }))
  const ws = new Socket()
  cleanups.push(() => backend.close())
  cleanups.push(() => ws.close())
  await backend.connect(ws as unknown as WebSocket, new URLSearchParams())
  ws.post({ type: "reveal", line: 0, column: 0, row: 0 })
  await sleep(100)
  expect(ws.readyState).toEqual(1)
})
