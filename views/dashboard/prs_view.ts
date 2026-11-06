/// <reference lib="dom" />

// The dashboard's PRs tab, page side: the workspace's PRs (prs/github.ts)
// from the server's PrsWatcher (prs/watcher.ts), each with its state, review
// and checks, and a Refresh button. Links open in the default browser (the
// window app sends a new window's URL there). A PR's review threads load
// when opened, each with a button that sends it to the tab's agent.

import type { CheckState, Pr } from "./prs/github.ts"
import { commentDoc, type CommentLook } from "./prs/comment_doc.ts"
import { reviewId } from "./prs/review.ts"
import type { Conversation, ConversationItem } from "./prs/conversation.ts"
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

/** What the view asks of the server about a PR's threads, and about
 * reviewing someone else's */
export interface ThreadActions {
  load: (pr: Pr) => Promise<Thread[]>
  /** Returns what became of it: "sent", "held", or an error */
  send: (pr: Pr, thread: Thread) => Promise<string>
  /** Bring it into a workspace and open skepsis; null or the error */
  review: (pr: Pr) => Promise<string | null>
  /** Returns "sent", "held", or an error */
  askAgent: (pr: Pr) => Promise<string>
  /** Clean up a review workspace by name; null or the error */
  done: (name: string) => Promise<string | null>
  /** Your own PR in skepsis, from its base; null or the error */
  skepsis: (pr: Pr) => Promise<string | null>
  /** The PR's description, comments and reviews */
  conversation: (pr: Pr) => Promise<Conversation>
  /** Send a comment or review to the agent; "sent", "held", or an error */
  sendItem: (pr: Pr, item: ConversationItem) => Promise<string>
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
  /** PR url -> its conversation, kept across updates */
  #conversations = new Map<
    string,
    { conversation: Conversation } | { error: string } | "loading"
  >()
  /** Thread id -> what sending it came to */
  #sent = new Map<string, string>()
  /** Review workspace name -> what the last action on it came to */
  #reviewNotes = new Map<string, string>()
  /** Review workspaces whose Done was clicked once, waiting for the yes */
  #confirming = new Set<string>()
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
    for (const pr of s?.prs ?? []) {
      const box = this.#pr(pr)
      box.append(this.#ownActions(pr))
      body.push(box)
    }
    if (s?.others.length) {
      const others = el(
        "details",
        "tests-section",
        el("summary", "", el("span", "tests-runner", `For review (${s.others.length})`)),
      ) as HTMLDetailsElement
      others.open = this.#open.get("for review") ?? true
      others.addEventListener("toggle", () => this.#open.set("for review", others.open))
      for (const pr of s.others) {
        const box = this.#pr(pr)
        box.querySelector(".pr-meta")?.prepend(`by ${pr.author} · `)
        box.append(this.#reviewActions(pr, s))
        others.append(box)
      }
      body.push(others)
    }
    // Workspaces whose PR has closed or merged since, still on disk
    const listed = new Set(
      (s?.others ?? []).map((p) => `review-${reviewId(p.repo, p.number)}`),
    )
    const leftover = (s?.reviews ?? []).filter((n) => !listed.has(n))
    if (leftover.length) {
      const box = el(
        "div",
        "tests-section",
        el("div", "tests-runner", "Review workspaces left over"),
      )
      for (const name of leftover)
        box.append(
          el("div", "jira-actions", el("span", "", name), ...this.#doneButton(name)),
        )
      body.push(box)
    }
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
    box.append(this.#conversationBox(pr), this.#threadsBox(pr))
    return box
  }

  #ownActions(pr: Pr): HTMLElement {
    const note = el("span", "tests-status", this.#reviewNotes.get(pr.url) ?? "")
    const open = el("button", "tests-run", "Open in skepsis") as HTMLButtonElement
    open.addEventListener("click", async () => {
      open.disabled = true
      note.textContent = "Opening…"
      this.#reviewNotes.set(pr.url, (await this.#actions.skepsis(pr)) ?? "")
      this.render(this.#last)
    })
    return el("div", "jira-actions", open, note)
  }

  #reviewActions(pr: Pr, s: PrsState): HTMLElement {
    const name = `review-${reviewId(pr.repo, pr.number)}`
    const has = s.reviews.includes(name)
    const note = el("span", "tests-status", this.#reviewNotes.get(name) ?? "")
    const act = (label: string, f: () => Promise<string | null>) => {
      const b = el("button", "tests-run", label) as HTMLButtonElement
      b.addEventListener("click", async () => {
        b.disabled = true
        note.textContent = "Working…"
        const result = await f()
        this.#reviewNotes.set(name, result ?? "")
        this.render(this.#last)
      })
      return b
    }
    return el(
      "div",
      "jira-actions",
      act(has ? "Reopen in skepsis" : "Review in skepsis", () => this.#actions.review(pr)),
      act("Ask the agent", async () => {
        const r = await this.#actions.askAgent(pr)
        return r === "sent"
          ? "Sent to the tab's agent."
          : r === "held"
            ? "Waiting for an agent."
            : r
      }),
      ...(has ? this.#doneButton(name) : []),
      note,
    )
  }

  /** Done reviewing, in two steps: it deletes the workspace's directory, and
   * the window can't show a confirm dialog */
  #doneButton(name: string): HTMLElement[] {
    if (!this.#confirming.has(name)) {
      const b = el("button", "tests-run", "Done reviewing") as HTMLButtonElement
      b.addEventListener("click", () => {
        this.#confirming.add(name)
        this.render(this.#last)
      })
      return [b]
    }
    const yes = el("button", "tests-run", "Yes, delete it") as HTMLButtonElement
    yes.addEventListener("click", async () => {
      yes.disabled = true
      const error = await this.#actions.done(name)
      this.#confirming.delete(name)
      this.#reviewNotes.set(name, error ?? "")
      this.render(this.#last)
    })
    const no = el("button", "tests-run", "Cancel") as HTMLButtonElement
    no.addEventListener("click", () => {
      this.#confirming.delete(name)
      this.render(this.#last)
    })
    return [el("span", "tests-status", "Delete its workspace and directory?"), yes, no]
  }

  #conversationBox(pr: Pr): HTMLElement {
    const key = `${pr.url} conversation`
    const d = el(
      "details",
      "pr-checks",
      el("summary", "", "Conversation"),
    ) as HTMLDetailsElement
    d.open = this.#open.get(key) ?? false
    d.addEventListener("toggle", () => {
      this.#open.set(key, d.open)
      if (d.open && !this.#conversations.has(pr.url)) void this.#loadConversation(pr)
    })
    const loaded = this.#conversations.get(pr.url)
    if (loaded === "loading") d.append(el("p", "tests-status", "Loading…"))
    else if (loaded && "error" in loaded) d.append(el("pre", "tests-error", loaded.error))
    else if (loaded) {
      const { description, items } = loaded.conversation
      d.append(
        el(
          "div",
          "pr-thread",
          el(
            "div",
            "pr-thread-head",
            el("span", "pr-thread-where", `${description.author} opened it`),
          ),
          this.#frame(description.html, description.body || "No description."),
        ),
      )
      for (const item of items) d.append(this.#item(pr, item))
    }
    return d
  }

  async #loadConversation(pr: Pr) {
    this.#conversations.set(pr.url, "loading")
    this.render(this.#last)
    try {
      this.#conversations.set(pr.url, {
        conversation: await this.#actions.conversation(pr),
      })
    } catch (e) {
      this.#conversations.set(pr.url, { error: e instanceof Error ? e.message : String(e) })
    }
    this.render(this.#last)
  }

  #item(pr: Pr, item: ConversationItem): HTMLElement {
    const verdict =
      item.state === "approved"
        ? "approved"
        : item.state === "changes"
          ? "requested changes"
          : item.state
            ? "reviewed"
            : "commented"
    const send = el("button", "tests-run", "Send to agent") as HTMLButtonElement
    const note = el("span", "tests-status", this.#sent.get(item.url) ?? "")
    send.addEventListener("click", async () => {
      send.disabled = true
      note.textContent = "Sending…"
      const result = await this.#actions.sendItem(pr, item)
      this.#sent.set(
        item.url,
        result === "sent"
          ? "Sent."
          : result === "held"
            ? "Waiting for an agent in the tab."
            : result,
      )
      note.textContent = this.#sent.get(item.url) ?? ""
      send.disabled = false
    })
    return el(
      "div",
      "pr-thread",
      el(
        "div",
        "pr-thread-head",
        el(
          "span",
          `pr-thread-where pr-review ${item.state ?? ""}`,
          `${item.author} ${verdict}`,
        ),
        send,
        note,
      ),
      ...(item.body.trim() ? [this.#frame(item.html, item.body)] : []),
    )
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
    return el(
      "div",
      "pr-comment",
      el("div", "pr-comment-author", c.author),
      this.#frame(c.html, c.body),
    )
  }

  /** GitHub's HTML for something in a sandboxed frame, or its markdown as
   * plain text where there's no HTML */
  #frame(html: string, body: string): HTMLIFrameElement {
    const frame = document.createElement("iframe")
    frame.className = "pr-comment-frame"
    // Same-origin only so the page can measure it; no scripts, no forms
    frame.setAttribute(
      "sandbox",
      "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    )
    frame.srcdoc = commentDoc(html || `<p>${escapeText(body)}</p>`, commentLook())
    const fit = () => {
      const doc = frame.contentDocument
      if (doc?.documentElement) frame.style.height = `${doc.documentElement.scrollHeight}px`
    }
    frame.addEventListener("load", fit)
    new ResizeObserver(fit).observe(frame)
    return frame
  }
}
