// The entries of a quickfix list as `ah edit --quickfix` reads them on
// stdin: JSON lines ({"file","line","col"?,"text"}), or file:line[:col]: text
// as compilers and `rg --vimgrep` print them, mixed as they come.

import { resolve } from "node:path"

export interface QuickfixItem {
  /** Absolute */
  file: string
  /** 1-based, as quickfix lists count */
  line: number
  col: number
  text: string
}

/** file:line:col: text or file:line: text; the space after is optional */
const LOCATION = /^(.+?):(\d+):(?:(\d+):)?\s?(.*)$/

const isLine = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1

// TODO(david): document parseQuickfix(text, cwd)
export function parseQuickfix(
  text: string,
  cwd: string,
): { ok: true; items: QuickfixItem[] } | { ok: false; error: string } {
  const items: QuickfixItem[] = []
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim()
    if (!line) continue
    const item = line.startsWith("{") ? fromJson(line, cwd) : fromLocation(line, cwd)
    if (!item) return { ok: false, error: `can't read line ${i + 1}: ${line}` }
    items.push(item)
  }
  return { ok: true, items }
}

function fromJson(line: string, cwd: string): QuickfixItem | null {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof o !== "object" || o === null) return null
  const { file, line: n, col = 1, text } = o as Record<string, unknown>
  if (typeof file !== "string" || !file || typeof text !== "string") return null
  if (!isLine(n) || !isLine(col)) return null
  return { file: resolve(cwd, file), line: n, col, text }
}

function fromLocation(line: string, cwd: string): QuickfixItem | null {
  const m = LOCATION.exec(line)
  if (!m) return null
  const [, file, n, col, text] = m
  return { file: resolve(cwd, file), line: Number(n), col: col ? Number(col) : 1, text }
}
