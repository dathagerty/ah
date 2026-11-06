/// <reference lib="dom" />

// The dashboard's Issues tab, page side: the Jira project's current sprint
// (jira/jira.ts) from the server's JiraWatcher, grouped by status category,
// each ticket opening to its description, a status control offering the
// transitions Jira allows, and a button that starts a tracker on it. The
// description HTML is built on the server with everything escaped
// (adfToHtml), so it goes in as is.

import type { Issue, Transition } from "./jira/jira.ts"
import type { JiraState } from "./jira/watcher.ts"

export interface IssueActions {
  /** The ticket's description as HTML, and its transitions */
  open: (issue: Issue) => Promise<{ html: string; transitions: Transition[] }>
  /** Returns null when it moved, or the error */
  move: (issue: Issue, transition: string) => Promise<string | null>
  /** Returns what became of it: "sent", "held", or an error */
  track: (issue: Issue) => Promise<string>
}

type Loaded = { html: string; transitions: Transition[] } | { error: string } | "loading"

const GROUPS: [Issue["category"], string][] = [
  ["progress", "In progress"],
  ["todo", "To do"],
  ["done", "Done"],
]

function el(tag: string, className: string, ...children: (Node | string)[]) {
  const e = document.createElement(tag)
  if (className) e.className = className
  e.append(...children)
  return e
}

/** What the Issues tab's label says: the tickets not done yet */
export function jiraBadge(s: JiraState | undefined): string {
  if (!s || s.loading) return ""
  const open = s.issues.filter((i) => i.category !== "done").length
  return open ? String(open) : ""
}

export class JiraView {
  readonly #host: HTMLElement
  readonly #onRefresh: () => void
  readonly #actions: IssueActions
  /** Ticket key (or a group's name) -> whether it's open, as toggled */
  #open = new Map<string, boolean>()
  #loaded = new Map<string, Loaded>()
  /** Ticket key -> what the last move or tracker came to */
  #notes = new Map<string, string>()
  #last: JiraState | undefined

  constructor(host: HTMLElement, onRefresh: () => void, actions: IssueActions) {
    this.#host = host
    this.#onRefresh = onRefresh
    this.#actions = actions
  }

  render(s: JiraState | undefined) {
    this.#last = s
    const scroll = this.#host.scrollTop
    const refresh = el("button", "tests-run", "Refresh") as HTMLButtonElement
    refresh.disabled = !s || s.loading
    refresh.addEventListener("click", () => this.#onRefresh())
    const status =
      !s || s.loading
        ? "Loading the sprint…"
        : `${s.project} sprint${s.checkedAt ? ` · checked ${ago(s.checkedAt)}` : ""}`
    const body: HTMLElement[] = []
    if (s?.error) body.push(el("pre", "tests-error", s.error))
    if (s && !s.loading && !s.issues.length && !s.error)
      body.push(el("p", "empty", `No tickets in ${s.project}'s open sprint.`))
    for (const [category, title] of GROUPS) {
      const issues = (s?.issues ?? []).filter((i) => i.category === category)
      if (!issues.length) continue
      const group = el(
        "details",
        "tests-section",
        el("summary", "", el("span", "tests-runner", `${title} (${issues.length})`)),
      ) as HTMLDetailsElement
      group.open = this.#open.get(title) ?? category !== "done"
      group.addEventListener("toggle", () => this.#open.set(title, group.open))
      for (const issue of issues) group.append(this.#issue(issue))
      body.push(group)
    }
    this.#host.replaceChildren(
      el("div", "tests-bar", refresh, el("span", "tests-status", status)),
      ...body,
    )
    this.#host.scrollTop = scroll
  }

  #issue(issue: Issue): HTMLElement {
    const key = el("a", "pr-title", issue.key) as HTMLAnchorElement
    key.href = issue.url
    key.target = "_blank"
    const head = el(
      "summary",
      "pr-head",
      el("span", `pr-state jira-${issue.category}`, issue.status),
      key,
      el("span", "", issue.summary),
    )
    const meta = el(
      "div",
      "pr-meta",
      [issue.assignee ?? "Unassigned", issue.type, issue.priority]
        .filter(Boolean)
        .join(" · "),
    )
    const d = el("details", "pr jira-issue", head, meta) as HTMLDetailsElement
    d.open = this.#open.get(issue.key) ?? false
    d.addEventListener("toggle", () => {
      this.#open.set(issue.key, d.open)
      if (d.open && !this.#loaded.has(issue.key)) void this.#load(issue)
    })
    const loaded = this.#loaded.get(issue.key)
    if (loaded === "loading") d.append(el("p", "tests-status", "Loading…"))
    else if (loaded && "error" in loaded) d.append(el("pre", "tests-error", loaded.error))
    else if (loaded) d.append(...this.#details(issue, loaded))
    return d
  }

  #details(
    issue: Issue,
    loaded: { html: string; transitions: Transition[] },
  ): HTMLElement[] {
    const description = el("div", "jira-description")
    // Built on the server with every bit of text escaped (jira.ts adfToHtml)
    description.innerHTML = loaded.html || "<p>No description.</p>"
    const note = el("span", "tests-status", this.#notes.get(issue.key) ?? "")
    const select = el("select", "jira-status") as HTMLSelectElement
    select.append(el("option", "", `Move from ${issue.status} to…`))
    for (const t of loaded.transitions) {
      const option = el("option", "", t.name === t.to ? t.to : `${t.name} (${t.to})`)
      ;(option as HTMLOptionElement).value = t.id
      select.append(option)
    }
    const move = el("button", "tests-run", "Move") as HTMLButtonElement
    move.addEventListener("click", async () => {
      if (!select.value || select.selectedIndex === 0) return
      move.disabled = true
      note.textContent = "Moving…"
      const error = await this.#actions.move(issue, select.value)
      this.#notes.set(issue.key, error ?? "Moved.")
      // Its status and transitions change; load them again when reopened
      if (!error) this.#loaded.delete(issue.key)
      this.render(this.#last)
    })
    const track = el("button", "tests-run", "Start a tracker") as HTMLButtonElement
    track.addEventListener("click", async () => {
      track.disabled = true
      note.textContent = "Sending…"
      const result = await this.#actions.track(issue)
      this.#notes.set(
        issue.key,
        result === "sent"
          ? "Sent to the tab's agent."
          : result === "held"
            ? "No agent in the tab yet; the next one gets it."
            : result,
      )
      this.render(this.#last)
    })
    return [description, el("div", "jira-actions", select, move, track, note)]
  }

  async #load(issue: Issue) {
    this.#loaded.set(issue.key, "loading")
    this.render(this.#last)
    try {
      this.#loaded.set(issue.key, await this.#actions.open(issue))
    } catch (e) {
      this.#loaded.set(issue.key, { error: e instanceof Error ? e.message : String(e) })
    }
    this.render(this.#last)
  }
}

/** "3 min ago" */
function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000)
  return min < 1 ? "just now" : `${min} min ago`
}
