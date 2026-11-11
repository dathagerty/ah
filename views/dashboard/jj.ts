// A workspace's jj log, rerendered whenever an operation lands. New operations
// rewrite the op heads dir, the same trigger `jj watch` uses.

import { realpathSync, watch, type FSWatcher } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { run, type Output } from "../../platform/proc.ts"
import { ansiToHtml } from "./ansi.ts"

/**
 * In the default workspace `.jj/repo` is the repo dir; in a secondary
 * workspace it's a file holding the repo dir's path, relative to `.jj`.
 */
export async function opHeadsDir(root: string): Promise<string> {
  const dotJj = join(root, ".jj")
  const repo = join(dotJj, "repo")
  const st = await stat(repo)
  const repoDir = st.isFile() ? resolve(dotJj, (await readFile(repo, "utf8")).trim()) : repo
  return join(repoDir, "op_heads", "heads")
}

// The log's default revset can reach far back in a busy repo
const LOG_LIMIT = "50"

/** A repo with no local main and no remote falls back to the root commit,
 * which lists every file in it */
export const MAX_FILES = 50

// TODO(david): doc
export const MAIN = "coalesce(present(main), trunk())"

const FILES_LABEL = "Changes since main:\n"

// From the fork point, not main itself: a main that moved on along a
// sibling branch would otherwise show its own commits as reversed changes
const FILES_BASE = `fork_point(${MAIN} | @)`

// One line per file, each a link the page opens (a removed file has nothing
// to open). A rename shows both paths and links the new one.
const FILES_TEMPLATE = `label("diff " ++ status, status_char) ++ " "
  ++ if(status == "removed", display_diff_path, hyperlink("ah:file/" ++ path, display_diff_path))
  ++ "\\n"`

/**
 * The file list over the log, each from its own jj command. A failed diff
 * drops the list; a failed log shows jj's own message in its place.
 */
export function composeLog(files: Output, log: Output): string {
  const logText = log.success ? log.stdout : log.stderr
  const lines = files.success ? files.stdout.split("\n").filter(Boolean) : []
  if (lines.length === 0) return logText
  const shown = lines.slice(0, MAX_FILES).map((l) => `${l}\n`)
  const rest = lines.length - shown.length
  if (rest > 0) shown.push(`… ${rest} more files\n`)
  return `${FILES_LABEL}${shown.join("")}\n${logText}`
}

export async function logText(root: string): Promise<string> {
  const jj = (args: string[]) =>
    run("jj", ["--ignore-working-copy", "--color", "always", ...args], { cwd: root })
  const [files, log] = await Promise.all([
    jj(["diff", "--from", FILES_BASE, "--to", "@", "--template", FILES_TEMPLATE]),
    // links on change IDs come from the user's own `home` template, which
    // checks ah.links
    jj(["--config", "ah.links=true", "log", "--limit", LOG_LIMIT, "--template", "home"]),
  ])
  return composeLog(files, log)
}

async function renderLog(root: string): Promise<string> {
  return ansiToHtml(await logText(root))
}

/**
 * Calls `onChange` with the log's HTML on start and after every operation
 * that changes it. At most one render runs at a time; changes that land
 * during a render trigger one more.
 */
export class LogWatcher {
  #watcher: FSWatcher | null = null
  #running = false
  #dirty = false
  #html: string | null = null
  #closed = false

  readonly root: string
  readonly onChange: (html: string) => void

  constructor(root: string, onChange: (html: string) => void) {
    this.root = root
    this.onChange = onChange
    this.#render()
    this.#watch().catch((e) => console.error(`ah: can't watch ${root}:`, e))
  }

  get html() {
    return this.#html
  }

  async #watch() {
    const dir = await opHeadsDir(this.root)
    if (this.#closed) return
    let timer: ReturnType<typeof setTimeout> | undefined
    this.#watcher = watch(dir, () => {
      clearTimeout(timer)
      timer = setTimeout(() => this.#render(), 30)
    })
    this.#watcher.on("error", (e) => console.error(`ah: can't watch ${this.root}:`, e))
  }

  async #render() {
    if (this.#running) {
      this.#dirty = true
      return
    }
    this.#running = true
    try {
      do {
        this.#dirty = false
        const html = await renderLog(this.root).catch((e) => ansiToHtml(String(e)))
        if (!this.#closed && html !== this.#html) {
          this.#html = html
          this.onChange(html)
        }
      } while (this.#dirty && !this.#closed)
    } finally {
      this.#running = false
    }
  }

  close() {
    this.#closed = true
    this.#watcher?.close()
  }
}

// Edits under these never change what jj snapshots (jj's own state, build
// output), and a cargo or npm build would otherwise keep resetting the timer.
const IGNORED_DIRS = new Set([".jj", ".git", "target", "node_modules"])

/** `path` is relative to the watched root, as fs.watch reports it */
export function isIgnored(path: string): boolean {
  return path.split(sep).some((segment) => IGNORED_DIRS.has(segment))
}

/** @'s commit, without snapshotting; null if jj can't say */
async function headOf(root: string): Promise<string | null> {
  const { success, stdout } = await run(
    "jj",
    ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"],
    { cwd: root },
  ).catch(() => ({ success: false, stdout: "" }))
  return success ? stdout.trim() || null : null
}

/** Long enough that a pause while typing doesn't become an operation of
 * its own and clutter the op log and evolog */
const SNAPSHOT_DELAY_MS = 10_000

/**
 * Runs `jj util snapshot` once files in the workspace have been quiet for
 * SNAPSHOT_DELAY_MS, so `@` in the log reflects edits that no jj command has
 * seen yet. jj records an operation only when something changed, which then
 * fires the LogWatcher. Any jj command would take the same snapshot; this
 * only takes it sooner. Then it tells `onQuiet` which files changed since
 * the last one, by their real paths, for the Tests tab to run what they
 * touch.
 */
export class SnapshotWatcher {
  #watcher: FSWatcher | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  /** @ as of the last snapshot, to diff the next one against */
  #head: string | null = null
  readonly root: string
  readonly #onQuiet: (changed: string[]) => void

  constructor(
    root: string,
    onQuiet: (changed: string[]) => void = () => {},
    delayMs = SNAPSHOT_DELAY_MS,
  ) {
    this.root = root
    this.#onQuiet = onQuiet
    let real: string
    try {
      // Gone if the workspace was removed while a tab was still in it
      real = realpathSync(root)
    } catch (e) {
      console.error(`ah: can't watch files in ${root}:`, e)
      return
    }
    const onChange = (filename: string | null) => {
      if (filename && isIgnored(filename)) return
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => void this.#quiet(), delayMs)
    }
    try {
      this.#watcher = watch(real, { recursive: true }, (_e, f) => onChange(f))
    } catch (e) {
      console.error(`ah: can't watch files in ${root}:`, e)
      return
    }
    this.#watcher.on("error", (e) => console.error(`ah: can't watch files in ${root}:`, e))
    void headOf(root).then((head) => (this.#head ??= head))
  }

  /** The files differ between @ now and @ at the last snapshot, by jj's
   * diff: fs.watch on macOS names directories as often as files, and this
   * leaves out ignored ones. An agent's jj commands in between snapshot
   * too, and the diff still covers what they saw. */
  async #quiet() {
    await this.#snapshot()
    const head = await headOf(this.root)
    const from = this.#head
    this.#head = head ?? from
    if (!from || !head || from === head) return
    const { success, stdout } = await run(
      "jj",
      ["--ignore-working-copy", "diff", "--from", from, "--to", head, "--name-only"],
      { cwd: this.root },
    )
    if (!success) return
    const real = realpathSync(this.root)
    const changed = stdout
      .split("\n")
      .filter(Boolean)
      .map((p) => join(real, p))
    if (changed.length) this.#onQuiet(changed)
  }

  async #snapshot() {
    const { success, stderr } = await run("jj", ["util", "snapshot"], { cwd: this.root })
    if (!success) console.error(`ah: snapshot in ${this.root} failed:`, stderr)
  }

  close() {
    clearTimeout(this.#timer)
    this.#watcher?.close()
  }
}
