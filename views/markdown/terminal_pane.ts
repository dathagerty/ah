/// <reference lib="dom" />

// The editor pane when it's a terminal (editor.ts), page side: an xterm.js
// terminal wired to a terminal editor (terminal_editor.ts) running in a pty on
// the server (pty.ts). The editor starts with the page, at the size the hidden
// pane keeps (page.ts), so it's ready when the pane is first shown. It keeps
// running while hidden, so toggling the pane doesn't lose editor state.
// Quitting the editor hides the pane and starts a fresh one behind it.

import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import type { EditorPane } from "./editor.ts"
import type { TerminalEditor } from "./terminal_editor.ts"
import { revealRow } from "./reveal_row.ts"
import { terminalLook } from "./terminal_theme.ts"

/** The page's theme vars as xterm's options: Rex's palette for the OS's
 * light or dark, and its font (terminal_theme.ts) */
const pageLook = () => {
  const style = getComputedStyle(document.documentElement)
  return terminalLook((name) => style.getPropertyValue(name))
}

const DARK = matchMedia("(prefers-color-scheme: dark)")

export class TerminalPane implements EditorPane {
  readonly #host: HTMLElement
  readonly #socketUrl: string
  readonly #editor: TerminalEditor
  /** For a quit editor (`:q`), which the pane restarts behind it */
  readonly #onQuit: () => void
  /** The line the editor's cursor moved to, for an editor that says
   * (neovim_command.ts's socket) */
  readonly #onCursor: ((line: number) => void) | undefined
  #term: Terminal | null = null
  #ws: WebSocket | null = null
  #resizes: ResizeObserver | null = null
  /** Closed for good (close), so nothing restarts it */
  #closed = false
  /** Sends a message to the backend, set once the editor has drawn. What
   * needs it sooner waits in #waiters. */
  #send: ((msg: Record<string, unknown>) => void) | null = null
  #waiters: (() => void)[] = []
  /** Repaints in the other palette when the OS switches light and dark,
   * without restarting the editor */
  readonly #restyle = () => {
    if (this.#term) this.#term.options.theme = pageLook().theme
  }

  constructor(
    host: HTMLElement,
    socketUrl: string,
    editor: TerminalEditor,
    onQuit: () => void,
    onCursor?: (line: number) => void,
  ) {
    this.#host = host
    this.#socketUrl = socketUrl
    this.#editor = editor
    this.#onQuit = onQuit
    this.#onCursor = onCursor
    DARK.addEventListener("change", this.#restyle)
    this.#start()
  }

  show() {
    this.#term?.focus()
  }

  /** Hang up the editor and take the terminal down, for a page that removes
   * the pane rather than hiding it (the dashboard's split) */
  close() {
    this.#closed = true
    DARK.removeEventListener("change", this.#restyle)
    this.#ws?.close()
    this.#resizes?.disconnect()
    this.#term?.dispose()
    this.#term = null
  }

  /** The cursor at `line` and `column`, its line level with `y`, staying a
   * fifth of the text area from either edge, and at least the editor's
   * scrolloff (reveal_row.ts), as one message to the backend */
  async reveal(line: number, column: number, y: number) {
    const send =
      this.#send ??
      (await new Promise<(msg: Record<string, unknown>) => void>((resolve) =>
        this.#waiters.push(() => resolve(this.#send!)),
      ))
    const row = () => {
      const term = this.#term
      const screen = term?.element?.querySelector(".xterm-screen")?.getBoundingClientRect()
      if (!term || !screen?.height) return null
      return revealRow({
        y,
        screenTop: screen.top,
        cellHeight: screen.height / term.rows,
        rows: term.rows,
        statusRows: this.#editor.statusRows,
        scrolloff: this.#editor.scrolloff,
      })
    }
    // The backend does it over the editor's RPC socket (pty.ts), from any mode
    send({ type: "reveal", line, column, row: row() ?? 0 })
  }

  #start() {
    const host = this.#host
    const editor = this.#editor
    const look = pageLook()
    const term = new Terminal({
      fontSize: look.fontSize,
      fontFamily: look.fontFamily,
      fontWeight: look.fontWeight,
      lineHeight: look.lineHeight,
      theme: look.theme,
      cursorBlink: false,
      macOptionIsMeta: true,
    })
    this.#term = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    // The default DOM renderer can't keep up with a full-screen editor's
    // full-viewport redraws (holding k scrolled several times slower than in
    // a terminal).
    // WebGL renders the same output at terminal speed; if the context is lost
    // or unavailable, dispose the addon and xterm falls back to the DOM renderer.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (err) {
      console.warn("ah: WebGL renderer unavailable, using DOM renderer", err)
    }
    fitWhole(term, fit)
    // Reachable from the devtools console for debugging rendering issues
    Object.assign(globalThis, { ahTerm: term })

    const spawnSize = { cols: term.cols, rows: term.rows }
    const ws = new WebSocket(
      `${this.#socketUrl}?${new URLSearchParams({
        cols: String(spawnSize.cols),
        rows: String(spawnSize.rows),
      })}`,
    )
    ws.binaryType = "arraybuffer"
    this.#ws = ws
    const startedAt = performance.now()
    const send = (msg: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }
    const sendSize = () => send({ type: "resize", cols: term.cols, rows: term.rows })
    // xterm doesn't encode ⌘, so the ⌘-chords the editor binds go to it as
    // whatever it takes them as. preventDefault keeps the browser from acting
    // on them too (⌘S would open Save Page). Other ⌘-chords go to the page (⌘E
    // toggles this pane) instead of xterm eating them.
    term.attachCustomKeyEventHandler((e) => {
      if (!e.metaKey) return true
      const key = e.key.toLowerCase()
      const chord = Object.hasOwn(editor.chords, key) ? editor.chords[key] : undefined
      if (chord && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        if (e.type === "keydown") send({ type: "input", data: chord })
      }
      return false
    })
    ws.onopen = () => {
      // A fit that ran while the socket was still connecting had nowhere to
      // go; if the size moved on since spawn, tell the editor now.
      if (term.cols !== spawnSize.cols || term.rows !== spawnSize.rows) sendSize()
    }
    const type = (keys: string) => send({ type: "input", data: keys })
    ws.onmessage = (e) => {
      // Text frames are from the backend, not the editor's output
      if (typeof e.data === "string") {
        let msg: unknown
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        const { type, line } = (msg ?? {}) as { type?: unknown; line?: unknown }
        if (type === "cursor" && Number.isInteger(line)) this.#onCursor?.(line as number)
        return
      }
      if (!(e.data instanceof ArrayBuffer)) return
      term.write(new Uint8Array(e.data))
      if (this.#send !== send) {
        this.#send = send
        for (const wake of this.#waiters) wake()
        this.#waiters = []
      }
    }
    ws.onclose = (e) => {
      if (this.#closed) return
      if (this.#send === send) this.#send = null
      // The editor quit, rather than failing to start or losing the server or
      // the file. One that quits soon after starting may be failing, and
      // restarting it could loop.
      if (
        e.code === 1000 &&
        e.reason === "editor exited" &&
        performance.now() - startedAt > 3000
      ) {
        this.#onQuit()
        return this.#restart()
      }
      this.#term?.write(`\r\n\x1b[2m[${editor.name} exited — click here to restart]\x1b[0m`)
      host.addEventListener("click", () => this.#restart(), { once: true })
    }
    term.onData(type)
    // Spawn counts as a resize: switching to the alternate screen, which the
    // editor does at startup, also fires xterm's scroll event.
    let lastResizeAt = Date.now()
    term.onResize(() => {
      lastResizeAt = Date.now()
      sendSize()
    })
    // A full-screen editor draws the alternate screen by positioning the
    // cursor, without wrapping or line feeds, so it should never scroll. When it does,
    // the editor and xterm disagree about the size (or a glyph width) and
    // every row is off by one until the editor happens to rewrite it. Ask it
    // for a full redraw, which it does on any resize event. Around a resize
    // this is expected and self-correcting: frames drawn for the old size
    // land after xterm shrank, and the redraw for the new size repairs them. Outside
    // that window it is an anomaly, so leave a trace in the console. Capped so
    // a persistent disagreement can't turn into a redraw loop.
    const redraws: number[] = []
    let redrawTimer: ReturnType<typeof setTimeout> | undefined
    term.onScroll(() => {
      if (this.#term !== term || term.buffer.active.type !== "alternate") return
      // xterm fires this before the resize event of the same resize() call, so
      // judge a moment later.
      setTimeout(() => {
        const now = Date.now()
        if (this.#term !== term || now - lastResizeAt < 1000) return
        while (redraws.length && now - redraws[0] > 10_000) redraws.shift()
        if (redraws.length >= 3) return
        console.warn(
          `ah: editor pane scrolled unexpectedly at ${term.cols}x${term.rows}; requesting redraw`,
        )
        clearTimeout(redrawTimer)
        redrawTimer = setTimeout(() => {
          redraws.push(Date.now())
          send({ type: "redraw" })
        }, 300)
      }, 50)
    })
    this.#resizes = new ResizeObserver(() => fitWhole(term, fit))
    this.#resizes.observe(host)
    // On a restart; on the page's start, the pane is hidden until shown
    if (document.body.classList.contains("editor-shown")) term.focus()
  }

  #restart() {
    // onQuit may have closed it
    if (this.#closed) return
    this.#resizes?.disconnect()
    this.#term?.dispose()
    this.#term = null
    this.#start()
  }
}

type Size = { width: number; height: number }

/** The glyph and cell sizes xterm measured, in device pixels, from its
 * private render service */
function deviceSizes(term: Terminal) {
  type Core = {
    _renderService?: { dimensions?: { device?: { char?: Size; cell?: Size } } }
  }
  return (term as unknown as { _core?: Core })._core?._renderService?.dimensions?.device
}

/** FitAddon's fit, at a size whose canvas comes to whole CSS pixels. The
 * WebGL renderer sizes the canvas in device pixels and rounds its CSS size,
 * and WebKit has no devicePixelContentBoxSize to correct that with, so at 2x
 * an odd number of 33px rows stretches the canvas by a device pixel and one
 * pixel row of text shows doubled. At a ratio with no such size within a few
 * cells, it fits as FitAddon does. */
function fitWhole(term: Terminal, fit: FitAddon) {
  const dims = fit.proposeDimensions()
  const cell = deviceSizes(term)?.cell
  if (!dims || isNaN(dims.cols) || isNaN(dims.rows) || !cell?.width || !cell.height) {
    return fit.fit()
  }
  const dpr = window.devicePixelRatio
  const whole = (count: number, size: number) => {
    for (let n = count; n > Math.max(1, count - 4); n--) {
      const css = (n * size) / dpr
      if (Math.abs(css - Math.round(css)) < 1e-6) return n
    }
    return count
  }
  const cols = whole(dims.cols, cell.width)
  const rows = whole(dims.rows, cell.height)
  if (cols === term.cols && rows === term.rows) return
  // As FitAddon does, so the new size draws in full
  ;(
    term as unknown as { _core: { _renderService: { clear(): void } } }
  )._core._renderService.clear()
  term.resize(cols, rows)
}
