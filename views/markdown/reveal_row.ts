// The terminal row a revealed line goes on (terminal_pane.ts): level with
// where the preview was clicked, but a fifth of the text rows from either
// edge, and at least the editor's scrolloff. A pure function, so it's
// tested without a page.

export interface RevealGeometry {
  /** The click, in client coordinates */
  y: number
  /** The terminal's screen: its top in client coordinates, and a row's height */
  screenTop: number
  cellHeight: number
  /** The terminal's rows, and the editor's rows below the text */
  rows: number
  statusRows: number
  /** The fewest rows the editor keeps between the cursor and the edges */
  scrolloff: number
}

/** The 0-based row among the text rows */
export function revealRow(g: RevealGeometry): number {
  const textRows = g.rows - g.statusRows
  const margin = Math.max(Math.round(textRows / 5), g.scrolloff)
  const level = Math.floor((g.y - g.screenTop) / g.cellHeight)
  return Math.max(margin, Math.min(level, textRows - 1 - margin))
}
