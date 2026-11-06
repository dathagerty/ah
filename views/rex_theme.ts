// The look of the user's terminal, read from the Rex app's settings, so ah
// matches it without settings of its own: Rex's light and dark themes, which
// the OS appearance picks between, and its terminal font. Rex keeps them in
// its macOS defaults (com.superlogical.rex), undocumented: a custom theme's
// palette is JSON in Workspace.customThemes, and a built-in theme's isn't
// there at all. Anything missing is null, for views/theme.ts's built-in look
// to fill in.

import { run } from "../platform/proc.ts"

export interface Palette {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  selectionForeground: string
  /** ANSI colors 0–15 */
  ansi: string[]
}

export interface RexFont {
  family: string
  /** In points */
  size: number
  weight: number
  /** Added to the font's line height, as Rex's cell height setting */
  cellHeightPercent: number
}

export interface RexLook {
  light: Palette | null
  dark: Palette | null
  font: RexFont | null
}

const DOMAIN = "com.superlogical.rex"

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")

/** A top-level key's value in an XML plist: its element and text. Rex's keys
 * are distinct enough to find by name. */
function plistValue(xml: string, key: string): { type: string; text: string } | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`<key>${escaped}</key>\\s*<(\\w+)>([\\s\\S]*?)</\\1>`).exec(xml)
  return m ? { type: m[1], text: unescape(m[2]) } : null
}

const plistString = (xml: string, key: string) => {
  const v = plistValue(xml, key)
  return v?.type === "string" ? v.text : null
}

const plistNumber = (xml: string, key: string) => {
  const v = plistValue(xml, key)
  return v && (v.type === "real" || v.type === "integer") ? Number(v.text) : null
}

interface RexColor {
  red: number
  green: number
  blue: number
}

const isColor = (v: unknown): v is RexColor =>
  typeof v === "object" &&
  v !== null &&
  ["red", "green", "blue"].every(
    (k) => typeof (v as Record<string, unknown>)[k] === "number",
  )

/** sRGB components from 0 to 1, as #rrggbb */
const hex = ({ red, green, blue }: RexColor) =>
  `#${[red, green, blue]
    .map((x) =>
      Math.round(Math.min(1, Math.max(0, x)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`

const COLORS = [
  "background",
  "foreground",
  "cursor",
  "selectionBackground",
  "selectionForeground",
] as const

/** A theme's palette, or null if any color is missing */
function paletteOf(theme: unknown): Palette | null {
  const p = (theme as { palette?: Record<string, unknown> } | null)?.palette
  if (!p || !Array.isArray(p.ansi) || p.ansi.length < 16 || !p.ansi.every(isColor))
    return null
  if (!COLORS.every((k) => isColor(p[k]))) return null
  return {
    ...(Object.fromEntries(COLORS.map((k) => [k, hex(p[k] as RexColor)])) as Omit<
      Palette,
      "ansi"
    >),
    ansi: p.ansi.slice(0, 16).map(hex),
  }
}

/** Rex's look from its preferences, as `defaults export` writes them */
export function parseRexPrefs(xml: string): RexLook {
  let themes: unknown[] = []
  const data = plistValue(xml, "Workspace.customThemes")
  if (data?.type === "data") {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(data.text.replace(/\s/g, ""), "base64").toString("utf8"),
      )
      if (Array.isArray(parsed)) themes = parsed
    } catch {
      /* unreadable: no themes */
    }
  }
  const byId = (key: string) => {
    const id = plistString(xml, key)
    return paletteOf(themes.find((t) => (t as { id?: unknown })?.id === id) ?? null)
  }
  const family = plistString(xml, "Workspace.terminalFontName")
  const size = plistNumber(xml, "Workspace.terminalFontPointSize")
  return {
    light: byId("Workspace.lightThemeID"),
    dark: byId("Workspace.darkThemeID"),
    font:
      family && size
        ? {
            family,
            size,
            weight: plistNumber(xml, "Workspace.terminalFontWeight") ?? 400,
            cellHeightPercent: plistNumber(xml, "Workspace.terminalCellHeightPercent") ?? 0,
          }
        : null,
  }
}

/** Rex's look now; all null where Rex isn't installed or can't be read */
export async function readRexLook(): Promise<RexLook> {
  const { success, stdout } = await run("defaults", ["export", DOMAIN, "-"]).catch(() => ({
    success: false,
    stdout: "",
  }))
  return parseRexPrefs(success ? stdout : "")
}
