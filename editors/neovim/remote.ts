// ah's side of calling into a running nvim over its RPC socket, with the
// neovim node client. Every call runs a function of ah's plugin
// (editors/neovim/lua/ah/remote.lua) with nvim_exec_lua.
//
// Two things about the client to keep clear of:
//
// - Its own logger replaces the global console with winston's, for plugin
//   hosts that talk over stdio. So it gets ours. But it builds buffer,
//   window and tab handles in replies without that logger, falling back to
//   its own, so nothing here may return one: the Lua returns plain values.
// - attach({ socket }) opens the socket without an error handler, so a
//   reset would throw in the server. So the socket is ours too, handed over
//   as the reader and writer.

import { access } from "node:fs/promises"
import { createConnection, type Socket } from "node:net"
import { attach, type NeovimClient } from "neovim"

type Logger = NonNullable<NonNullable<Parameters<typeof attach>[0]["options"]>["logger"]>

/** Errors to ours; the client's info and debug lines are per message */
const logger = {
  level: "error",
  info: () => logger,
  debug: () => logger,
  warn: (...args: unknown[]) => (console.error("ah: nvim client:", ...args), logger),
  error: (...args: unknown[]) => (console.error("ah: nvim client:", ...args), logger),
} as unknown as Logger

/** How long nvim has to start listening after it's spawned, by default */
const LISTEN_WAIT_MS = 5000
/** How long a call has before it's given up on */
const CALL_TIMEOUT_MS = 2000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** The open connection to `path`, or null if it couldn't connect */
function connect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once("connect", () => resolve(socket))
    socket.on("error", (e) => {
      console.error(`ah: nvim socket ${path}:`, e.message)
      resolve(null)
    })
  })
}

// TODO(david): document NvimRemote, its constructor (the socket nvim listens
// on, which may not be there yet, and waitMs: how long to wait for it, 0 for
// an nvim that should be listening already), reveal, open and close
export class NvimRemote {
  readonly #client: Promise<NeovimClient | null>
  #closed = false

  constructor(socket: string, { waitMs = LISTEN_WAIT_MS }: { waitMs?: number } = {}) {
    this.#client = this.#attach(socket, waitMs)
  }

  /** The client, once nvim has started up. It listens before that: before
   * --cmd has put the plugin on the runtimepath, and before the file loads,
   * so calls wait for v:vim_did_enter. */
  async #attach(path: string, waitMs: number): Promise<NeovimClient | null> {
    const until = Date.now() + waitMs
    while (!(await exists(path))) {
      if (this.#closed || Date.now() > until) return null
      await sleep(50)
    }
    const socket = this.#closed ? null : await connect(path)
    if (!socket) return null
    if (this.#closed) {
      socket.destroy()
      return null
    }
    const client = attach({ reader: socket, writer: socket, options: { logger } })
    while ((await client.request("nvim_get_vvar", ["vim_did_enter"])) !== 1) {
      if (this.#closed || Date.now() > until) {
        void client.close().catch(() => {})
        return null
      }
      await sleep(50)
    }
    return client
  }

  /** `require("ah.remote")[fn](...args)` in nvim, with what it returns */
  async #call(fn: string, args: unknown[]): Promise<unknown> {
    const client = await this.#client
    if (!client) throw new Error("nvim isn't listening")
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`nvim didn't answer ${fn}`)),
        CALL_TIMEOUT_MS,
      )
    })
    try {
      return await Promise.race([
        client.request("nvim_exec_lua", [`return require("ah.remote").${fn}(...)`, args]),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async reveal(line: number, column: number, row: number): Promise<void> {
    await this.#call("reveal", [line, column, row])
  }

  async open(path: string, line: number): Promise<void> {
    await this.#call("open", [path, line])
  }

  close() {
    this.#closed = true
    void this.#client.then((client) => client?.close()).catch(() => {})
  }
}
