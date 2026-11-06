import { expect, test } from "vitest"
import type { Palette, RexLook } from "./rex_theme.ts"
import { lookFrom, theme, themeCss } from "./theme.ts"

const palette = (bg: string): Palette => ({
  background: bg,
  foreground: "#101010",
  cursor: "#202020",
  selectionBackground: "#303030",
  selectionForeground: "#404040",
  ansi: Array.from({ length: 16 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`),
})

const none: RexLook = { light: null, dark: null, font: null }

/** The declarations in a block of the CSS, by property */
function block(css: string, selector: "root" | "light"): Record<string, string> {
  const re =
    selector === "root"
      ? /^:root \{([^}]*)\}/m
      : /@media \(prefers-color-scheme: light\) \{\s*:root \{([^}]*)\}/
  const body = re.exec(css)?.[1]
  if (body === undefined) return {}
  return Object.fromEntries(
    body
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  )
}

test("without Rex's look, it's the built-in dark theme and font, with no light one", () => {
  const css = themeCss(lookFrom(none))
  const root = block(css, "root")
  expect(root["--term-bg"]).toBe(theme.background)
  expect(root["--ansi-1"]).toBe(theme.ansi[1])
  expect(root["--term-font"]).toContain("Berkeley Mono")
  expect(root["--term-size"]).toBe(`${theme.fontSize}px`)
  // The cell height ah used to match Berkeley Mono in Rex
  expect(root["--term-cell-height"]).toBe("6")
  expect(css).not.toContain("prefers-color-scheme")
})

test("Rex's dark theme is the default and its light one is the OS's light mode", () => {
  const css = themeCss(
    lookFrom({ light: palette("#fbf7f0"), dark: palette("#0d0e1c"), font: null }),
  )
  expect(block(css, "root")).toMatchObject({
    "--term-bg": "#0d0e1c",
    "--term-fg": "#101010",
    "--term-cursor": "#202020",
    "--term-selection-bg": "#303030",
    "--term-selection-fg": "#404040",
    "--ansi-15": "#00000f",
  })
  const light = block(css, "light")
  expect(light["--term-bg"]).toBe("#fbf7f0")
  expect(light["--ansi-0"]).toBe("#000000")
  // The font isn't the palette's: it stays in the root block only
  expect(light["--term-font"]).toBeUndefined()
})

test("a light theme with no dark one keeps the built-in dark", () => {
  const css = themeCss(lookFrom({ ...none, light: palette("#ffffff") }))
  expect(block(css, "root")["--term-bg"]).toBe(theme.background)
  expect(block(css, "light")["--term-bg"]).toBe("#ffffff")
})

test("Rex's font is the terminal font, by family, size and weight", () => {
  const css = themeCss(
    lookFrom({
      ...none,
      font: {
        family: "Atkinson Hyperlegible Mono",
        size: 14,
        weight: 250,
        cellHeightPercent: 0,
      },
    }),
  )
  const root = block(css, "root")
  expect(root["--term-font"]).toMatch(/^"Atkinson Hyperlegible Mono", ui-monospace/)
  expect(root["--term-size"]).toBe("14px")
  expect(root["--term-weight"]).toBe("250")
  expect(root["--term-cell-height"]).toBe("0")
})

test("a font name can't break out of its quotes", () => {
  const css = themeCss(
    lookFrom({
      ...none,
      font: { family: 'Evil"; } body { x', size: 14, weight: 400, cellHeightPercent: 0 },
    }),
  )
  expect(block(css, "root")["--term-font"]).toMatch(/^"Evil  body  x", /)
})

test("ah's own page parts take the theme: the conversation panel, the comment popover and trackers", () => {
  const css = themeCss(lookFrom(none))
  // One more selector than chat.css's and task_list.css's, so it wins
  // wherever it loads
  expect(css).toMatch(/html #conversation \{[^}]*--chat-ink: var\(--term-fg\);/)
  expect(css).toMatch(/html #popover \{[^}]*color: var\(--term-fg\);/)
  expect(css).toMatch(/html:root \{[^}]*--t-page: var\(--term-bg\);/)
  expect(css).toMatch(/html:root \{[^}]*--t-red: var\(--ansi-1\);/)
})
