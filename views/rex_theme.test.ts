import { expect, test } from "vitest"
import { parseRexPrefs } from "./rex_theme.ts"

/** A color as Rex stores it */
const c = (red: number, green: number, blue: number) => ({
  red,
  green,
  blue,
  alpha: 1,
  colorSpace: "srgb",
})

const theme = (id: string, appearance: string, base: number) => ({
  id,
  name: `theme ${id}`,
  appearance,
  createdAt: 0,
  source: { ghosttyFile: { fileName: id } },
  palette: {
    background: c(base, base, base),
    foreground: c(1 - base, 1 - base, 1 - base),
    cursor: c(1, 0, 0),
    cursorText: c(0, 0, 0),
    selectionBackground: c(0, 0, 1),
    selectionForeground: c(1, 1, 1),
    ansi: Array.from({ length: 16 }, (_, i) => c(i / 15, 0, 0)),
    paletteBase: null,
    paletteGenerate: false,
    paletteHarmonious: false,
    paletteOverrides: [],
  },
})

/** Rex's preferences as `defaults export` writes them, with base64 data
 * wrapped as it is there */
function prefs(entries: Record<string, string | number | object>): string {
  const value = (v: string | number | object) => {
    if (typeof v === "string") return `<string>${v}</string>`
    if (typeof v === "number") return `<real>${v}</real>`
    const b64 = Buffer.from(JSON.stringify(v)).toString("base64")
    return `<data>\n\t${b64.match(/.{1,68}/g)!.join("\n\t")}\n\t</data>`
  }
  const body = Object.entries(entries)
    .map(([k, v]) => `\t<key>${k}</key>\n\t${value(v)}`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
}

const themes = [theme("custom-L", "light", 1), theme("custom-D", "dark", 0.0509)]

test("the light and dark themes are picked by id, as hex", () => {
  const look = parseRexPrefs(
    prefs({
      "Workspace.customThemes": themes,
      "Workspace.darkThemeID": "custom-D",
      "Workspace.lightThemeID": "custom-L",
    }),
  )
  expect(look.light).toMatchObject({
    background: "#ffffff",
    foreground: "#000000",
    cursor: "#ff0000",
    selectionBackground: "#0000ff",
    selectionForeground: "#ffffff",
  })
  expect(look.dark?.background).toBe("#0d0d0d")
  expect(look.dark?.ansi).toHaveLength(16)
  expect(look.dark?.ansi[0]).toBe("#000000")
  expect(look.dark?.ansi[15]).toBe("#ff0000")
})

test("a theme that isn't a custom one has no palette here", () => {
  const look = parseRexPrefs(
    prefs({
      "Workspace.customThemes": themes,
      "Workspace.darkThemeID": "builtin-ayu",
      "Workspace.lightThemeID": "custom-L",
    }),
  )
  expect(look.dark).toBeNull()
  expect(look.light?.background).toBe("#ffffff")
})

test("the font comes along, by name, size, weight and cell height", () => {
  const look = parseRexPrefs(
    prefs({
      "Workspace.terminalCellHeightPercent": 6,
      "Workspace.terminalFontName": "Atkinson Hyperlegible Mono",
      "Workspace.terminalFontPointSize": 14,
      "Workspace.terminalFontWeight": 250,
    }),
  )
  expect(look.font).toEqual({
    family: "Atkinson Hyperlegible Mono",
    size: 14,
    weight: 250,
    cellHeightPercent: 6,
  })
})

test("themes that aren't readable, or no settings at all, leave everything to the fallback", () => {
  const garbled = prefs({ "Workspace.lightThemeID": "custom-L" }).replace(
    "</dict>",
    "\t<key>Workspace.customThemes</key>\n\t<data>bm90IGpzb24=</data>\n</dict>",
  )
  expect(parseRexPrefs(garbled)).toEqual({ light: null, dark: null, font: null })
  expect(parseRexPrefs("")).toEqual({ light: null, dark: null, font: null })
})

test("a theme missing colors is passed over", () => {
  const broken = { ...themes[0], palette: { background: c(1, 1, 1) } }
  const look = parseRexPrefs(
    prefs({ "Workspace.customThemes": [broken], "Workspace.lightThemeID": "custom-L" }),
  )
  expect(look.light).toBeNull()
})
