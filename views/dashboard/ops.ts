// jj operations the dashboard runs for a tab: what the page may ask for
// (resolveOp), and running it in the tab's workspace (runOp).

import { run } from "../../platform/proc.ts"
import { CHANGE_ID } from "./links.ts"

// TODO(david): doc
export type OpResult =
  | { ok: true; args: string[] }
  | { ok: false; status: 400; error: string }

// TODO(david): doc
export type DescriptionResult =
  | { ok: true; description: string }
  | { ok: false; status: 400 | 502; error: string }

// TODO(david): doc
export type RunResult = { ok: true; operation: string } | { ok: false; error: string }

/** jj's operation IDs, full or short. Only these reach jj from the page, so
 * nothing else does: no op expressions (`@-`), no flags. */
const OPERATION_ID = /^[0-9a-f]+$/

/** The one commit a change ID from the page names, as a revset: by change
 * ID, since a bare symbol would be a bookmark of that name first, and
 * exactly one, since jj takes a change that's gone as nothing to do and a
 * divergent one as several. Null for anything but a change ID. */
const target = (rev: unknown) =>
  typeof rev === "string" && CHANGE_ID.test(rev) ? `exactly(change_id(${rev}), 1)` : null

const refuse = (error: string): OpResult => ({ ok: false, status: 400, error })

// TODO(david): doc
export function resolveOp(body: unknown): OpResult {
  if (typeof body !== "object" || body === null) return refuse("not an operation")
  const { op, operation, rev, description } = body as {
    op?: unknown
    operation?: unknown
    rev?: unknown
    description?: unknown
  }
  const change = target(rev)
  if (op === "new") {
    if (rev === undefined) return { ok: true, args: ["new"] }
    return change ? { ok: true, args: ["new", change] } : refuse("not a change ID")
  }
  if (op === "edit")
    return change ? { ok: true, args: ["edit", change] } : refuse("not a change ID")
  if (op === "describe") {
    if (!change) return refuse("not a change ID")
    if (typeof description !== "string") return refuse("a description is text")
    // With `=`, a description starting with `-` isn't taken for a flag
    return { ok: true, args: ["describe", "-r", change, `--message=${description}`] }
  }
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
export async function readDescription(
  root: string,
  rev: string,
): Promise<DescriptionResult> {
  const change = target(rev)
  if (!change) return { ok: false, status: 400, error: "not a change ID" }
  try {
    const read = await run(
      "jj",
      [
        "--ignore-working-copy",
        "--color",
        "never",
        "log",
        "-r",
        change,
        "--no-graph",
        "-T",
        "description",
      ],
      { cwd: root },
    )
    if (!read.success)
      return {
        ok: false,
        status: 502,
        error: read.stderr.trim() || `jj exited with ${read.code}`,
      }
    // jj ends a description with a newline, and adds one again on describe
    return { ok: true, description: read.stdout.replace(/\n+$/, "") }
  } catch (e) {
    return { ok: false, status: 502, error: message(e) }
  }
}

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
