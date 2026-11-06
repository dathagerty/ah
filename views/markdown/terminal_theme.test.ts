import { expect, test } from "vitest"
import { theme } from "../theme.ts"
import { terminalLook } from "./terminal_theme.ts"

const vars = (entries: Record<string, string>) => (name: string) => entries[name] ?? ""

const ansi = Object.fromEntries(
  Array.from({ length: 16 }, (_, i) => [
    `--ansi-${i}`,
    `#0000${i.toString(16).padStart(2, "0")}`,
  ]),
)

test("the page's theme vars become xterm's colors and font", () => {
  const look = terminalLook(
    vars({
      "--term-bg": "#fbf7f0",
      "--term-fg": "#000000",
      "--term-cursor": "#d00000",
      "--term-selection-bg": "#c2bcb5",
      "--term-selection-fg": "#000000",
      ...ansi,
      "--term-font": '"Atkinson Hyperlegible Mono", ui-monospace, monospace',
      "--term-size": "14px",
      "--term-weight": "250",
      "--term-cell-height": "0",
    }),
  )
  expect(look.theme).toMatchObject({
    background: "#fbf7f0",
    foreground: "#000000",
    cursor: "#d00000",
    cursorAccent: "#fbf7f0",
    selectionBackground: "#c2bcb5",
    selectionForeground: "#000000",
    black: "#000000",
    red: "#000001",
    white: "#000007",
    brightBlack: "#000008",
    brightWhite: "#00000f",
  })
  expect(look.fontFamily).toBe('"Atkinson Hyperlegible Mono", ui-monospace, monospace')
  expect(look.fontSize).toBe(14)
  expect(look.fontWeight).toBe(250)
  expect(look.lineHeight).toBe(1)
})

test("a cell height adds to the line height", () => {
  expect(terminalLook(vars({ "--term-cell-height": "6" })).lineHeight).toBeCloseTo(1.06)
})

test("a page without the theme vars gets the built-in look", () => {
  const look = terminalLook(vars({}))
  expect(look.theme.background).toBe(theme.background)
  expect(look.theme.foreground).toBe(theme.foreground)
  expect(look.theme.red).toBe(theme.ansi[1])
  expect(look.fontFamily).toBe(theme.fontFamily)
  expect(look.fontSize).toBe(theme.fontSize)
  expect(look.fontWeight).toBe(400)
  expect(look.lineHeight).toBeCloseTo(1.06)
})
