// The terminal's look as pages get it: CSS vars from /theme.css, from Rex's
// light and dark themes and font (rex_theme.ts), with the OS appearance
// picking the palette. `theme` is the built-in look (ayu dark, Berkeley
// Mono) for whatever Rex doesn't say, and what the editor panes' terminals
// still import. Indexed colors past 15 are xterm's fixed cube and grays,
// which dashboard/ansi.ts computes.

import type { Palette, RexLook } from "./rex_theme.ts"

export const theme = {
  background: "#020202",
  foreground: "#e6e1cf",
  fontFamily: '"Berkeley Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  // ANSI colors 0–15
  ansi: [
    "#000000",
    "#ff5555",
    "#b8cc52",
    "#e7c547",
    "#36a3d9",
    "#f07178",
    "#95e6cb",
    "#ffffff",
    "#686868",
    "#ff6565",
    "#eafe84",
    "#fff779",
    "#68d5ff",
    "#ffa3aa",
    "#c7fffd",
    "#ffffff",
  ],
}

const BUILT_IN: Palette = {
  background: theme.background,
  foreground: theme.foreground,
  cursor: theme.foreground,
  // ayu's selection
  selectionBackground: "#253340",
  selectionForeground: theme.foreground,
  ansi: theme.ansi,
}

/** What follows the family in --term-font, for glyphs it lacks */
const FALLBACK_FONTS = "ui-monospace, SFMono-Regular, Menlo, monospace"

/** The look pages get: a dark palette, a light one if Rex has one, and the
 * font */
export interface Look {
  dark: Palette
  light: Palette | null
  font: { family: string; size: number; weight: number; cellHeightPercent: number }
}

/** Rex's look, with the built-in one where Rex says nothing */
export function lookFrom(rex: RexLook): Look {
  return {
    dark: rex.dark ?? BUILT_IN,
    light: rex.light,
    font: rex.font ?? {
      family: "Berkeley Mono",
      size: theme.fontSize,
      weight: 400,
      // What Berkeley Mono had in Rex
      cellHeightPercent: 6,
    },
  }
}

const paletteVars = (p: Palette) => [
  `--term-bg: ${p.background};`,
  `--term-fg: ${p.foreground};`,
  `--term-cursor: ${p.cursor};`,
  `--term-selection-bg: ${p.selectionBackground};`,
  `--term-selection-fg: ${p.selectionForeground};`,
  ...p.ansi.map((c, i) => `--ansi-${i}: ${c};`),
]

/** /theme.css: the dark palette and the font in :root, and the light
 * palette over it when the OS is in light mode */
export function themeCss(
  look: Look = lookFrom({ light: null, dark: null, font: null }),
): string {
  // A family name from Rex's settings goes in quotes; nothing in it may end them
  const family = look.font.family.replace(/["\\;{}<>]/g, "")
  const root = [
    `--term-font: "${family}", ${FALLBACK_FONTS};`,
    `--term-size: ${look.font.size}px;`,
    `--term-weight: ${look.font.weight};`,
    `--term-cell-height: ${look.font.cellHeightPercent};`,
    ...paletteVars(look.dark),
  ]
  const css = `:root {\n  ${root.join("\n  ")}\n}\n`
  if (!look.light) return css
  const light = paletteVars(look.light).join("\n    ")
  return `${css}@media (prefers-color-scheme: light) {\n  :root {\n    ${light}\n  }\n}\n`
}
