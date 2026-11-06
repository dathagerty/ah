// Where a click on a link in the dashboard's jj log opens. jj.ts writes the
// links, ansi.ts turns them into anchors, and client.ts posts a click here
// through routes.ts.

import { realpath } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

export type LinkTarget =
  /** `line`, from the Tests tab's failures and definitions, where it goes */
  | { open: "doc"; path: string; line?: number }
  /** In the dashboard's split under the log, or a Rex float for an ⌥-click */
  | { open: "nvim"; path: string; float: boolean; line?: number }
  /** In the running Emacs, from the open-with menu */
  | { open: "emacs"; path: string; line?: number }
  | { open: "skepsis"; rev: string }

export type LinkResult =
  | { ok: true; target: LinkTarget }
  | { ok: false; status: 400 | 404; error: string }

/** What the doc editor shows */
const DOC = /\.(md|markdown|html?)$/i

/** jj's change IDs are k–z only. A rev goes to jj, so nothing else does:
 * no revsets, no commit IDs. */
const CHANGE_ID = /^[k-z]+$/

const refuse = (status: 400 | 404, error: string): LinkResult => ({
  ok: false,
  status,
  error,
})

const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT"

/** Where the open-with menu can send a file; `doc` only for docs */
const WITH = new Set(["doc", "nvim", "float", "emacs"])

/** `body` as the page posts it: `{ file }`, relative to the workspace root,
 * with `float` for an ⌥-click or `with` for the open-with menu's pick, and a
 * 1-based `line` to open at; or `{ rev }`. A file must be in the workspace
 * once symlinks are followed. */
export async function resolveLink(root: string, body: unknown): Promise<LinkResult> {
  if (typeof body !== "object" || body === null) return refuse(400, "not a link")
  const {
    file,
    rev,
    float = false,
    line,
    with: pick,
  } = body as {
    file?: unknown
    rev?: unknown
    float?: unknown
    line?: unknown
    with?: unknown
  }
  if (pick !== undefined && !(typeof pick === "string" && WITH.has(pick)))
    return refuse(400, "not a way to open a file")
  if (typeof float !== "boolean") return refuse(400, "float is true or false")
  if (line !== undefined && !(Number.isInteger(line) && (line as number) >= 1))
    return refuse(400, "line is a whole number from 1")
  const at = line === undefined ? {} : { line: line as number }
  if ((file === undefined) === (rev === undefined))
    return refuse(400, "a link has a file or a rev")
  if (rev !== undefined) {
    if (typeof rev !== "string" || !CHANGE_ID.test(rev))
      return refuse(400, "not a change ID")
    return { ok: true, target: { open: "skepsis", rev } }
  }
  if (typeof file !== "string" || file === "" || isAbsolute(file))
    return refuse(400, "not a path in the workspace")
  const realRoot = await realpath(root)
  const inside = (p: string) => {
    const rel = relative(realRoot, p)
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`)
  }
  // By the path's text first, so a refused path doesn't say whether it exists
  if (!inside(join(realRoot, file))) return refuse(400, "not a path in the workspace")
  let path: string
  try {
    path = await realpath(join(realRoot, file))
  } catch (e) {
    if (isNotFound(e)) return refuse(404, "no such file")
    throw e
  }
  if (!path.startsWith(realRoot + sep)) return refuse(400, "not a path in the workspace")
  const isDoc = DOC.test(path)
  if (pick === "doc" && !isDoc)
    return refuse(400, "the doc editor is for markdown and html")
  if (pick === "emacs") return { ok: true, target: { open: "emacs", path, ...at } }
  if (pick === "nvim" || pick === "float")
    return { ok: true, target: { open: "nvim", path, float: pick === "float", ...at } }
  return {
    ok: true,
    target: isDoc ? { open: "doc", path, ...at } : { open: "nvim", path, float, ...at },
  }
}
