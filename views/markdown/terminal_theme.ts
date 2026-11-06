// The editor panes' terminal look, from the page's theme vars (/theme.css,
// from Rex's settings), so a pane draws in Rex's palette and font and
// switches with the OS. A page without the vars gets the built-in look. The
// page half of terminal_pane.ts reads them; this maps them for xterm.js.

import { theme } from "../theme.ts"

/** xterm's names for ANSI colors 0–15 */
const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

export interface TerminalLook {
  theme: Record<string, string>
  fontFamily: string
  fontSize: number
  fontWeight: number
  /** xterm's multiple of the font's height, from Rex's cell height */
  lineHeight: number
}

/** `read` gives a CSS var's value on the page, empty when it isn't set */
export function terminalLook(read: (name: string) => string): TerminalLook {
  const get = (name: string, fallback: string) => read(name).trim() || fallback
  const num = (name: string, fallback: number) => {
    const n = Number.parseFloat(read(name))
    return Number.isFinite(n) ? n : fallback
  }
  const background = get("--term-bg", theme.background)
  const foreground = get("--term-fg", theme.foreground)
  return {
    theme: {
      background,
      foreground,
      cursor: get("--term-cursor", foreground),
      cursorAccent: background,
      selectionBackground: get("--term-selection-bg", "#253340"),
      selectionForeground: get("--term-selection-fg", foreground),
      ...Object.fromEntries(
        ANSI_NAMES.map((name, i) => [name, get(`--ansi-${i}`, theme.ansi[i])]),
      ),
    },
    fontFamily: get("--term-font", theme.fontFamily),
    fontSize: num("--term-size", theme.fontSize),
    fontWeight: num("--term-weight", 400),
    lineHeight: 1 + num("--term-cell-height", 6) / 100,
  }
}
