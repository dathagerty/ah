// The editor pane's backend when the pane is a terminal (editor.ts): a
// terminal editor (terminal_editor.ts) in a pty, one per socket, spawned when
// the page loads and hung up when the socket closes (page reload or close) or
// the file does. Output goes to the page as binary frames; input and resizes
// come back as JSON text frames.

import { dirname } from "node:path"
import { type IPty, spawn } from "@lydell/node-pty"
import type { WebSocket } from "ws"
import { NvimRemote } from "../../editors/neovim/remote.ts"
import type { EditorBackend } from "./editor.ts"
import type { TerminalCommand } from "./terminal_editor.ts"

type PtyMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "redraw" }
  /** ⌘-click in the preview, for an editor with a socket (terminal_editor.ts):
   * the 0-based line and column, on the 0-based text row */
  | { type: "reveal"; line: number; column: number; row: number }

/** A text frame from the page, or null if it isn't one we know: pty.write
 * and pty.resize throw on anything else, inside an event handler */
export function parsePtyMessage(text: string): PtyMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return null
  if (msg.type === "input") {
    return "data" in msg && typeof msg.data === "string"
      ? { type: "input", data: msg.data }
      : null
  }
  if (msg.type === "resize") {
    const size = (n: unknown) => (Number.isInteger(n) ? Number(n) : null)
    const cols = "cols" in msg ? size(msg.cols) : null
    const rows = "rows" in msg ? size(msg.rows) : null
    return cols !== null && rows !== null ? { type: "resize", cols, rows } : null
  }
  if (msg.type === "redraw") return { type: "redraw" }
  if (msg.type === "reveal") {
    const index = (n: unknown) => (Number.isInteger(n) && Number(n) >= 0 ? Number(n) : null)
    const line = "line" in msg ? index(msg.line) : null
    const column = "column" in msg ? index(msg.column) : null
    const row = "row" in msg ? index(msg.row) : null
    return line !== null && column !== null && row !== null
      ? { type: "reveal", line, column, row }
      : null
  }
  return null
}

/** Every terminal editor open on one file */
export class PtyBackend implements EditorBackend {
  readonly file: string
  readonly #command: TerminalCommand
  readonly #env: Record<string, string>
  #ptys = new Set<IPty>()
  #closed = false

  /** `env` is added to the editor's environment */
  constructor(file: string, command: TerminalCommand, env: Record<string, string> = {}) {
    this.file = file
    this.#command = command
    this.#env = env
  }

  /** A pty socket: the editor at the page's terminal size, given in the query */
  async connect(ws: WebSocket, query: URLSearchParams) {
    let cols = Math.max(20, Number(query.get("cols")) || 80)
    let rows = Math.max(5, Number(query.get("rows")) || 24)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.#env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      // Marks the pane for the user's editor config, to turn off what makes
      // no sense there, like splitting the Rex pane
      AH_PANE: "1",
    }
    let command: string
    let args: string[]
    let socket: string | undefined
    try {
      ;({ command, args, socket } = await this.#command(this.file))
    } catch (e) {
      console.error("ah: couldn't set up the editor:", e)
      return ws.close(1011, "couldn't start the editor")
    }
    // The page or the file may have gone while the command was set up, and
    // nothing would hang up an editor started now
    if (ws.readyState !== ws.OPEN || this.#closed) return ws.close()
    let pty: IPty
    try {
      pty = spawn(command, args, {
        cols,
        rows,
        cwd: dirname(this.file),
        env,
        encoding: null, // raw bytes, so a split UTF-8 sequence survives
      })
    } catch (e) {
      console.error(`ah: couldn't start ${command}:`, e)
      return ws.close(1011, "couldn't start the editor")
    }
    this.#ptys.add(pty)
    // Calls into the editor over its socket, once it's listening; reveals
    // sent before then wait for it
    const remote = socket ? new NvimRemote(socket) : null
    // The cursor's line, for the preview to follow (terminal_pane.ts), as a
    // text frame beside the output's binary ones
    remote
      ?.follow((line) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "cursor", line }))
      })
      .catch((e: Error) =>
        console.error("ah: the preview can't follow the cursor:", e.message),
      )
    console.error(
      `ah: ${command} started for ${this.file} (pid ${pty.pid}, ${cols}x${rows})`,
    )

    pty.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data)
    })
    pty.onExit(({ exitCode }) => {
      this.#ptys.delete(pty)
      remote?.close()
      console.error(`ah: ${command} exited (${exitCode})`)
      // The page restarts an editor that quit, not one hung up with the file
      const reason = this.#closed ? "file closed" : "editor exited"
      if (ws.readyState === ws.OPEN) ws.close(1000, reason)
    })
    ws.on("message", (data, isBinary) => {
      if (isBinary) return
      const msg = parsePtyMessage(String(data))
      if (msg?.type === "input") pty.write(msg.data)
      else if (msg?.type === "resize") {
        ;({ cols, rows } = msg)
        pty.resize(Math.max(20, cols), Math.max(5, rows))
      } else if (msg?.type === "redraw") {
        // A same-size resize raises no SIGWINCH, so send one: the editor
        // clears and repaints everything on any resize event
        console.error(`ah: redraw requested by the page (${cols}x${rows})`)
        pty.kill("SIGWINCH")
      } else if (msg?.type === "reveal" && remote) {
        remote
          .reveal(msg.line, msg.column, msg.row)
          .catch((e: Error) => console.error("ah: couldn't reveal the line:", e.message))
      }
    })
    const hangup = () => {
      if (this.#ptys.has(pty)) pty.kill("SIGHUP")
    }
    ws.on("close", hangup)
    ws.on("error", hangup)
  }

  /** Hang up every pane, for closing the file */
  close() {
    this.#closed = true
    for (const pty of this.#ptys) pty.kill("SIGHUP")
  }
}
