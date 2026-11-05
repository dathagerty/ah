/// <reference lib="dom" />

// The dashboard's Tests tab, page side: a workspace's tests as a tree
// (tests/tree.ts) from the server's TestsWatcher (tests/watcher.ts), with a
// Run button. A node with a failure under it starts open; one the user
// opened or closed stays that way across updates. A failure links to where
// it happened, and a test the runner located links to where it's defined;
// both open as the log's file links do, with ⌥ for a Rex float.

import type { RunnerTests } from "./tests/model.ts"
import { buildTree, type Counts, type TreeNode, totals } from "./tests/tree.ts"
import type { TestsState } from "./tests/watcher.ts"

const ICON: Record<TreeNode["status"], string> = {
  passed: "✓",
  failed: "✗",
  skipped: "○",
  "not run": "·",
}

function el(tag: string, className: string, ...children: (Node | string)[]) {
  const e = document.createElement(tag)
  if (className) e.className = className
  e.append(...children)
  return e
}

/** "3 passed · 1 failed", leaving out what's zero */
export function countsText(c: Counts): string {
  const parts = [
    c.passed && `${c.passed} passed`,
    c.failed && `${c.failed} failed`,
    c.skipped && `${c.skipped} skipped`,
    c.notRun && `${c.notRun} not run`,
  ].filter(Boolean)
  return parts.join(" · ")
}

/** What the Tests tab's label says: running, or the failures, or passes */
export function testsBadge(s: TestsState | undefined): string {
  if (!s) return ""
  if (s.listing || s.running) return "…"
  const c = totals(s.runners)
  if (c.failed) return `✗ ${c.failed}`
  if (c.passed) return `✓ ${c.passed}`
  return ""
}

/** Opens a workspace file (relative to its root) at a 1-based line */
export type OpenAt = (file: string, line: number, float: boolean) => void

export class TestsView {
  readonly #host: HTMLElement
  readonly #onRun: () => void
  readonly #onOpen: OpenAt
  /** The shown workspace's root, which links are relative to */
  #root = ""
  /** Node key -> whether it's open, for the nodes the user toggled */
  #open = new Map<string, boolean>()

  constructor(host: HTMLElement, onRun: () => void, onOpen: OpenAt) {
    this.#host = host
    this.#onRun = onRun
    this.#onOpen = onOpen
  }

  /** A link to a line of a file in the workspace, or null for one outside it */
  #link(file: string, line: number, text: string, title: string): HTMLElement | null {
    if (!file.startsWith(`${this.#root}/`)) return null
    const rel = file.slice(this.#root.length + 1)
    const a = el("a", "tests-link", text)
    a.title = title
    a.addEventListener("click", (e) => {
      // In a <summary>, a click would also fold the node
      e.preventDefault()
      e.stopPropagation()
      this.#onOpen(rel, line, e.altKey)
    })
    return a
  }

  render(s: TestsState | undefined) {
    this.#root = s?.root ?? ""
    const scroll = this.#host.scrollTop
    const run = el("button", "tests-run", "Run")
    run.addEventListener("click", () => this.#onRun())
    ;(run as HTMLButtonElement).disabled = !s || s.listing
    const status = el("span", "tests-status", this.#statusText(s))
    const body = s ? s.runners.map((r) => this.#runner(r, s.root)) : []
    this.#host.replaceChildren(el("div", "tests-bar", run, status), ...body)
    this.#host.scrollTop = scroll
  }

  #statusText(s: TestsState | undefined): string {
    if (!s || s.listing) return "Finding tests…"
    if (!s.runners.length) return "No test runners in this workspace."
    const counts = countsText(totals(s.runners))
    return s.running ? `Running… ${counts}` : counts
  }

  #runner(r: RunnerTests, root: string): HTMLElement {
    const where = r.dir === root ? "" : r.dir.slice(root.length + 1)
    const nodes = buildTree(r)
    const all = nodes.reduce(
      (c, n) => ({
        passed: c.passed + n.counts.passed,
        failed: c.failed + n.counts.failed,
        skipped: c.skipped + n.counts.skipped,
        notRun: c.notRun + n.counts.notRun,
      }),
      { passed: 0, failed: 0, skipped: 0, notRun: 0 },
    )
    const key = `${r.kind}:${r.dir}`
    const summary = el(
      "summary",
      "",
      el("span", "tests-runner", `${r.kind}${where ? ` ${where}` : ""}`),
      el("span", "tests-counts", countsText(all)),
    )
    const section = this.#details(key, true, summary)
    section.classList.add("tests-section")
    if (r.error) section.append(el("pre", "tests-error", r.error))
    section.append(...nodes.map((n) => this.#node(n, key)))
    return section
  }

  /** A <details> that remembers being toggled */
  #details(key: string, byDefault: boolean, summary: HTMLElement): HTMLDetailsElement {
    const d = el("details", "", summary) as HTMLDetailsElement
    d.open = this.#open.get(key) ?? byDefault
    d.addEventListener("toggle", () => this.#open.set(key, d.open))
    return d
  }

  #label(n: TreeNode): HTMLElement[] {
    const label = [
      el("span", `tests-icon ${n.status.replace(" ", "-")}`, ICON[n.status]),
      el("span", "tests-name", n.name),
    ]
    const { file, line } = n.test ?? {}
    const def = file && line ? this.#link(file, line, "↗", "Open where it's defined") : null
    if (def) label.push(def)
    return label
  }

  /** "failed at src/lib.rs:13", linked */
  #failure(n: TreeNode): HTMLElement | null {
    const at = n.result?.failure
    if (!at) return null
    const rel = at.file.startsWith(`${this.#root}/`)
      ? at.file.slice(this.#root.length + 1)
      : at.file
    const link = this.#link(at.file, at.line, `${rel}:${at.line}`, "Open where it failed")
    return link && el("div", "tests-failure", "failed at ", link)
  }

  #node(n: TreeNode, parent: string): HTMLElement {
    const key = `${parent}|${n.key}`
    const output = n.result?.output
    if (!n.children.length && !output) return el("div", "tests-leaf", ...this.#label(n))
    const summary = el("summary", "", ...this.#label(n))
    if (n.children.length && (n.counts.failed || n.counts.passed))
      summary.append(el("span", "tests-counts", countsText(n.counts)))
    const d = this.#details(key, n.counts.failed > 0, summary)
    const failure = this.#failure(n)
    if (failure) d.append(failure)
    if (output) d.append(el("pre", "tests-output", output))
    d.append(...n.children.map((c) => this.#node(c, key)))
    return d
  }
}
