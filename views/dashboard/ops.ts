// jj operations the dashboard runs for a tab: what the page may ask for
// (resolveOp), and running it in the tab's workspace (runOp).

import { run } from "../../platform/proc.ts"

// TODO(david): doc
export type OpResult =
  | { ok: true; args: string[] }
  | { ok: false; status: 400; error: string }

// TODO(david): doc
export type RunResult = { ok: true; operation: string } | { ok: false; error: string }

/** jj's operation IDs, full or short. Only these reach jj from the page, so
 * nothing else does: no op expressions (`@-`), no flags. */
const OPERATION_ID = /^[0-9a-f]+$/

const refuse = (error: string): OpResult => ({ ok: false, status: 400, error })

// TODO(david): doc
export function resolveOp(body: unknown): OpResult {
  if (typeof body !== "object" || body === null) return refuse("not an operation")
  const { op, operation } = body as { op?: unknown; operation?: unknown }
  if (op === "undo") {
    if (typeof operation !== "string" || !OPERATION_ID.test(operation))
      return refuse("not an operation ID")
    // Not `jj undo`: the snapshot watcher or an agent may have run jj since
    return { ok: true, args: ["op", "revert", operation] }
  }
  return refuse("not an operation the dashboard runs")
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

// TODO(david): doc
export async function runOp(root: string, args: string[]): Promise<RunResult> {
  try {
    const ran = await run("jj", ["--color", "never", ...args], { cwd: root })
    if (!ran.success)
      return { ok: false, error: ran.stderr.trim() || `jj exited with ${ran.code}` }
    // HACK: the latest operation, read right after. One that lands in
    // between (an agent's, a snapshot) would be taken for this one.
    const log = await run(
      "jj",
      ["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"],
      { cwd: root },
    )
    const operation = log.stdout.trim()
    if (!log.success || !operation)
      return {
        ok: false,
        error: `jj ran, but its operation can't be found to undo: ${log.stderr.trim()}`,
      }
    return { ok: true, operation }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}
