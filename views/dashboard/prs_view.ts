/// <reference lib="dom" />

// The dashboard's PRs tab, page side: the workspace's PRs (prs/github.ts)
// from the server's PrsWatcher (prs/watcher.ts), each with its state, review
// and checks, and a Refresh button. Links open in the default browser (the
// window app sends a new window's URL there). A PR's review threads load
// when opened, each with a button that sends it to the tab's agent.

import type { CheckState, Pr } from "./prs/github.ts"
import { commentDoc, type CommentLook } from "./prs/comment_doc.ts"
import type { Thread, ThreadComment } from "./prs/threads.ts"
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

const escapeText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** The dashboard's colors and font, for a comment's frame */
function commentLook(): CommentLook {
  const style = getComputedStyle(document.documentElement)
  const v = (name: string) => style.getPropertyValue(name).trim()
  return {
    background: v("--bg"),
    text: v("--text"),
    muted: v("--muted"),
    border: v("--border"),
    link: v("--accent"),
    font: v("--term-font"),
    size: getComputedStyle(document.body).fontSize,
  }
}

/** "3 min ago", for when the PRs were last fetched */
function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000)
  return min < 1 ? "just now" : `${min} min ago`
}

/** What the view asks of the server about a PR's threads */
export interface ThreadActions {
  load: (pr: Pr) => Promise<Thread[]>
  /** Returns what became of it: "sent", "held", or an error */
  send: (pr: Pr, thread: Thread) => Promise<string>
}

type Loaded = { threads: Thread[] } | { error: string } | "loading"

export class PrsView {
  readonly #host: HTMLElement
  readonly #onRefresh: () => void
  readonly #actions: ThreadActions
  /** PR url (or url + " threads") -> whether it's open, for the ones the
   * user toggled */
  #open = new Map<string, boolean>()
  /** PR url -> its threads, kept across updates */
  #threads = new Map<string, Loaded>()
  /** Thread id -> what sending it came to */
  #sent = new Map<string, string>()
  #last: PrsState | undefined

  constructor(host: HTMLElement, onRefresh: () => void, actions: ThreadActions) {
    this.#host = host
    this.#onRefresh = onRefresh
    this.#actions = actions
  }

  render(s: PrsState | undefined) {
    this.#last = s
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
    box.append(this.#threadsBox(pr))
    return box
  }

  #threadsBox(pr: Pr): HTMLElement {
    const key = `${pr.url} threads`
    const d = el(
      "details",
      "pr-checks",
      el("summary", "", "Review threads"),
    ) as HTMLDetailsElement
    d.open = this.#open.get(key) ?? false
    d.addEventListener("toggle", () => {
      this.#open.set(key, d.open)
      if (d.open && !this.#threads.has(pr.url)) void this.#load(pr)
    })
    const loaded = this.#threads.get(pr.url)
    if (loaded === "loading") d.append(el("p", "tests-status", "Loading…"))
    else if (loaded && "error" in loaded) d.append(el("pre", "tests-error", loaded.error))
    else if (loaded) {
      const open = loaded.threads.filter((t) => !t.resolved)
      const resolved = loaded.threads.length - open.length
      if (!loaded.threads.length) d.append(el("p", "tests-status", "No review threads."))
      for (const t of open) d.append(this.#thread(pr, t))
      if (resolved) {
        const r = el("details", "", el("summary", "", `${resolved} resolved`))
        for (const t of loaded.threads.filter((t) => t.resolved))
          r.append(this.#thread(pr, t))
        d.append(r)
      }
    }
    return d
  }

  async #load(pr: Pr) {
    this.#threads.set(pr.url, "loading")
    this.render(this.#last)
    try {
      this.#threads.set(pr.url, { threads: await this.#actions.load(pr) })
    } catch (e) {
      this.#threads.set(pr.url, { error: e instanceof Error ? e.message : String(e) })
    }
    this.render(this.#last)
  }

  #thread(pr: Pr, t: Thread): HTMLElement {
    const where = `${t.path}${t.line ? `:${t.line}` : ""}${t.outdated ? " (outdated)" : ""}`
    const send = el("button", "tests-run", "Send to agent") as HTMLButtonElement
    const note = el("span", "tests-status", this.#sent.get(t.id) ?? "")
    send.addEventListener("click", async () => {
      send.disabled = true
      note.textContent = "Sending…"
      const result = await this.#actions.send(pr, t)
      this.#sent.set(
        t.id,
        result === "sent"
          ? "Sent."
          : result === "held"
            ? "Waiting for an agent in the tab."
            : result,
      )
      note.textContent = this.#sent.get(t.id) ?? ""
      send.disabled = false
    })
    return el(
      "div",
      "pr-thread",
      el("div", "pr-thread-head", el("span", "pr-thread-where", where), send, note),
      ...t.comments.map((c) => this.#comment(c)),
    )
  }

  /** The comment as GitHub renders it, in a frame that runs no script
   * (comment_doc.ts): other people's HTML stays out of the dashboard */
  #comment(c: ThreadComment): HTMLElement {
    const frame = document.createElement("iframe")
    frame.className = "pr-comment-frame"
    // Same-origin only so the page can measure it; no scripts, no forms
    frame.setAttribute(
      "sandbox",
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    )
    frame.srcdoc = commentDoc(c.html || `<p>${escapeText(c.body)}</p>`, commentLook())
    const fit = () => {
      const doc = frame.contentDocument
      if (doc?.documentElement) frame.style.height = `${doc.documentElement.scrollHeight}px`
    }
    frame.addEventListener("load", fit)
    new ResizeObserver(fit).observe(frame)
    return el("div", "pr-comment", el("div", "pr-comment-author", c.author), frame)
  }
}
