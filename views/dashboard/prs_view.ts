/// <reference lib="dom" />

// The dashboard's PRs tab, page side: the workspace's PRs (prs/github.ts)
// from the server's PrsWatcher (prs/watcher.ts), each with its state, review
// and checks, and a Refresh button. Links open in the default browser (the
// window app sends a new window's URL there).

import type { CheckState, Pr } from "./prs/github.ts"
import type { PrsState } from "./prs/watcher.ts"

const CHECK_ICON: Record<CheckState, string> = {
  passed: "✓",
  failed: "✗",
  pending: "…",
  skipped: "○",
}

const REVIEW: Record<NonNullable<Pr["review"]>, string> = {
  approved: "approved",
  changes: "changes requested",
  required: "review required",
}

function el(tag: string, className: string, ...children: (Node | string)[]) {
  const e = document.createElement(tag)
  if (className) e.className = className
  e.append(...children)
  return e
}

function link(href: string, text: string, className = ""): HTMLElement {
  const a = el("a", className, text) as HTMLAnchorElement
  a.href = href
  a.target = "_blank"
  return a
}

/** "3 min ago", for when the PRs were last fetched */
function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000)
  return min < 1 ? "just now" : `${min} min ago`
}

export class PrsView {
  readonly #host: HTMLElement
  readonly #onRefresh: () => void
  /** PR url -> whether its checks are open, for the ones the user toggled */
  #open = new Map<string, boolean>()

  constructor(host: HTMLElement, onRefresh: () => void) {
    this.#host = host
    this.#onRefresh = onRefresh
  }

  render(s: PrsState | undefined) {
    const scroll = this.#host.scrollTop
    const refresh = el("button", "tests-run", "Refresh") as HTMLButtonElement
    refresh.disabled = !s || s.loading
    refresh.addEventListener("click", () => this.#onRefresh())
    const status =
      !s || s.loading
        ? "Looking for PRs…"
        : s.checkedAt
          ? `Checked ${ago(s.checkedAt)}`
          : ""
    const body: HTMLElement[] = []
    if (s?.error) body.push(el("pre", "tests-error", s.error))
    if (s && !s.loading && !s.prs.length && !s.error)
      body.push(el("p", "empty", "No PRs for this workspace's bookmarks."))
    for (const pr of s?.prs ?? []) body.push(this.#pr(pr))
    this.#host.replaceChildren(
      el("div", "tests-bar", refresh, el("span", "tests-status", status)),
      ...body,
    )
    this.#host.scrollTop = scroll
  }

  #pr(pr: Pr): HTMLElement {
    const failing = pr.checks.filter((c) => c.state === "failed").length
    const pending = pr.checks.filter((c) => c.state === "pending").length
    const passed = pr.checks.filter((c) => c.state === "passed").length
    const summary = [
      failing && `${failing} failing`,
      pending && `${pending} running`,
      passed && `${passed} passed`,
    ]
      .filter(Boolean)
      .join(" · ")
    const head = el(
      "div",
      "pr-head",
      el("span", `pr-state ${pr.state}`, pr.state),
      link(pr.url, `#${pr.number} ${pr.title}`, "pr-title"),
    )
    const meta = el(
      "div",
      "pr-meta",
      `${pr.repo} · ${pr.branch}`,
      ...(pr.review
        ? [" · ", el("span", `pr-review ${pr.review}`, REVIEW[pr.review])]
        : []),
    )
    const box = el("div", "pr", head, meta)
    if (pr.checks.length) {
      const checks = el("details", "pr-checks", el("summary", "", summary || "checks"))
      const d = checks as HTMLDetailsElement
      d.open = this.#open.get(pr.url) ?? failing > 0
      d.addEventListener("toggle", () => this.#open.set(pr.url, d.open))
      for (const c of pr.checks)
        checks.append(
          el(
            "div",
            "tests-leaf",
            el("span", `tests-icon ${c.state}`, CHECK_ICON[c.state]),
            c.url ? link(c.url, c.name) : c.name,
          ),
        )
      box.append(checks)
    }
    return box
  }
}
