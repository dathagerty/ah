// jj operations the dashboard runs for a tab: what the page may ask for
// (resolveOp), and running it in the tab's workspace (runOp).

import { run } from "../../platform/proc.ts"
import { MAIN } from "./jj.ts"
import { CHANGE_ID } from "./links.ts"

// TODO(david): doc
// TODO(david): doc `remote`
export type OpResult =
  | { ok: true; args: string[]; remote?: true }
  | { ok: false; status: 400; error: string }

// TODO(david): doc
export type DescriptionResult =
  | { ok: true; description: string }
  | { ok: false; status: 400 | 502; error: string }

// TODO(david): doc
export type RunResult =
  | { ok: true; operation: string }
  | { ok: true; operation: null; message: string }
  | { ok: false; error: string }

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
  // Under a transient bookmark named for the change, made on the first push
  // and moved by later ones. Undo would only rewind jj's view of the
  // remote, not the remote.
  if (op === "push")
    return change
      ? { ok: true, args: ["git", "push", "-c", change], remote: true }
      : refuse("not a change ID")
  if (op === "fetch") return { ok: true, args: ["git", "fetch"] }
  if (op === "rebase")
    return { ok: true, args: ["rebase", "-s", `roots(${MAIN}..@)`, "-d", MAIN] }
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
    // Snapshotting here, so the operation's own snapshot of edits since
    // isn't taken for it when it changes nothing else
    const before = await opHead(root, { snapshot: true })
    if (!before.ok) return before
    const ran = await run("jj", ["--color", "never", ...args], { cwd: root })
    if (!ran.success)
      return { ok: false, error: ran.stderr.trim() || `jj exited with ${ran.code}` }
    // HACK: the latest operation, read right after. One that lands in
    // between (an agent's, a snapshot) would be taken for this one.
    const after = await opHead(root, { snapshot: false })
    if (!after.ok)
      return {
        ok: false,
        error: `jj ran, but its operation can't be found to undo: ${after.error}`,
      }
    // jj records no operation when nothing changed, and says why on stderr
    if (after.id === before.id)
      return { ok: true, operation: null, message: ran.stderr.trim() || "Nothing changed." }
    return { ok: true, operation: after.id }
  } catch (e) {
    return { ok: false, error: message(e) }
  }
}

async function opHead(
  root: string,
  { snapshot }: { snapshot: boolean },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const args = ["op", "log", "-n", "1", "--no-graph", "-T", "id"]
  const log = await run("jj", snapshot ? args : ["--ignore-working-copy", ...args], {
    cwd: root,
  })
  const id = log.stdout.trim()
  if (!log.success || !id)
    return { ok: false, error: log.stderr.trim() || `jj exited with ${log.code}` }
  return { ok: true, id }
}
