// The preview block a source line is in, for the preview following the
// editor pane's cursor (client.ts). Blocks give their lines as data-line,
// [start, end). Imports nothing, for tests.

// TODO(david): document blockForLine(ranges, line): the index of the block,
// or null without blocks
export function blockForLine(ranges: [number, number][], line: number): number | null {
  let inner: number | null = null
  for (const [i, [start, end]] of ranges.entries()) {
    if (start <= line && line < end) {
      // Innermost: the narrowest of those holding it
      if (inner === null || end - start < ranges[inner][1] - ranges[inner][0]) inner = i
    }
  }
  if (inner !== null) return inner
  if (!ranges.length) return null
  // Between blocks, or past the last: the last one that starts before it;
  // before the first, the first
  let before: number | null = null
  for (const [i, [start]] of ranges.entries())
    if (start <= line && (before === null || start >= ranges[before][0])) before = i
  return before ?? 0
}
