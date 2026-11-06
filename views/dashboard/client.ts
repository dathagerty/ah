/// <reference lib="dom" />

// Browser half of the dashboard, served as /view/dashboard/client.js to
// page.html. It follows the server's event stream (routes.ts): the Rex
// tabs in jj workspaces and which is focused, each workspace's jj log, and
// each workspace's trackers, and each tab's file (its workspace's current
// tracker), shown with <ah-markdown> from
// ../markdown/preview.js, or an html file in a frame of its page on the html
// pages port.

import type { State } from "./workspace.ts"
import { neovim } from "../markdown/neovim.ts"
import { TerminalPane } from "../markdown/terminal_pane.ts"
import type { TestsState } from "./tests/watcher.ts"
import { testsBadge, TestsView } from "./tests_view.ts"
import { prsBadge } from "./prs/github.ts"
import type { Conversation } from "./prs/conversation.ts"
import type { Thread } from "./prs/threads.ts"
import type { PrsState } from "./prs/watcher.ts"
import { PrsView } from "./prs_view.ts"
import type { Issue, Transition } from "./jira/jira.ts"
import type { JiraState } from "./jira/watcher.ts"
import { jiraBadge, JiraView } from "./jira_view.ts"

const byId = (id: string) => document.getElementById(id)!
const strip = byId("strip")
const logPane = byId("log-pane")
const docPane = byId("doc-pane")
const docName = byId("doc-name")
const trackerStrip = byId("trackers")
const parkedMenu = byId("parked")
const status = byId("status")
const nvimPane = byId("nvim-pane")
const nvimName = byId("nvim-name")
const testsPane = byId("tests-pane")
const testsBadgeEl = byId("tests-badge")
const prsPane = byId("prs-pane")
const prsBadgeEl = byId("prs-badge")
const issuesPane = byId("issues-pane")
const issuesBadgeEl = byId("issues-badge")
const newTracker = byId("new-tracker") as HTMLButtonElement
const newTrackerForm = byId("new-tracker-form")
const newTrackerFor = byId("new-tracker-for")
const goalBox = byId("new-tracker-goal") as HTMLTextAreaElement
const goalNote = byId("new-tracker-note")
const goalSend = byId("new-tracker-send") as HTMLButtonElement

let version: string | null = null
let state: State = { focused: null, tabs: [] }
// Not workspace.ts's: importing a value from there would bundle node:fs
const focusedRoot = () => state.tabs.find((t) => t.id === state.focused)?.root ?? null
const logs = new Map<string, string>() // root -> html
const scrollTops = new Map<string, number>() // root -> scroll position, kept across tab switches
let shown: { root: string | null; html: string | null } = { root: null, html: null }
// tab -> { path, view }, each view an <ah-markdown> (from
// ../markdown/preview.js) or an <iframe> that stays in the pane while its
// tab has the file, hidden unless focused, so a tab switch keeps its
// scroll and doesn't reconnect
const docs = new Map<string, { path: string; view: HTMLElement }>()
const docScrollTops = new Map<string, number>()
let shownDoc: string | null = null // tab
// root -> its current tracker, and the active and parked ones, most recent first
const trackers = new Map<
  string,
  { current: string | null; active: string[]; parked: string[] }
>()

/** A tracker's name: its directory's for an index.html, without the date
 * and the -tracker suffix */
function trackerName(path: string): string {
  const parts = path.split("/")
  const name = (parts.at(-1) === "index.html" ? parts.at(-2) : parts.at(-1)) ?? path
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-tracker$/, "")
}

function el(tag: string, attrs: Partial<HTMLElement>, ...children: (Node | string)[]) {
  const e = document.createElement(tag)
  Object.assign(e, attrs)
  e.append(...children)
  return e
}

function render() {
  const { focused, tabs } = state
  strip.replaceChildren(
    ...tabs.map((t) =>
      el(
        "span",
        {
          className: "chip" + (t.id === focused ? " focused" : ""),
          title: t.title,
          onclick: () => void focus(t.id),
        },
        t.name,
      ),
    ),
  )

  const w = tabs.find((t) => t.id === focused)
  newTracker.disabled = !w
  newTracker.title = w
    ? `Start a tracker in ${w.name}: its agent makes it`
    : "No jj workspace in the focused tab"
  renderDoc(w?.id ?? null)
  renderSplit()
  renderLogTabs()
  if (!w) {
    logPane.replaceChildren(
      el("p", { className: "empty" }, "No jj workspace in the focused tab."),
    )
    shown = { root: null, html: null }
    return
  }
  document.title = w.name

  // Only touch the DOM when the content changed, so scroll and selection survive
  const html = logs.get(w.root) ?? null
  if (shown.root === w.root && shown.html === html) return
  if (shown.root) scrollTops.set(shown.root, logPane.scrollTop)
  const pre = el("pre", { className: "log" })
  if (html === null) pre.textContent = "…"
  else pre.innerHTML = html
  logPane.replaceChildren(pre)
  if (shown.root !== w.root) logPane.scrollTop = scrollTops.get(w.root) ?? 0
  shown = { root: w.root, html }
}

/** Show the tab in Rex. Its state comes back over the event
 * stream like any other tab switch. */
async function focus(tab: string) {
  const res = await fetch("focus", { method: "POST", body: JSON.stringify({ tab }) })
  if (!res.ok) console.error("ah: focus failed:", res.status, await res.text())
}

// The new-tracker button: a goal for the focused tab's agent, which makes the
// tracker with the tracker skill (new_tracker.ts). The popover opens in the
// top layer, so it's placed by hand under the button, as #parked is.
newTrackerForm.addEventListener("beforetoggle", (e) => {
  if (e.newState !== "open") return
  const box = newTracker.getBoundingClientRect()
  newTrackerForm.style.top = `${box.bottom + 4}px`
  newTrackerForm.style.right = `${document.documentElement.clientWidth - box.right}px`
  const w = state.tabs.find((t) => t.id === state.focused)
  newTrackerFor.textContent = w ? `New tracker in ${w.name}` : ""
  goalNote.textContent = "⌘↵ sends"
})
newTrackerForm.addEventListener("toggle", () => {
  if (newTrackerForm.matches(":popover-open")) goalBox.focus()
})
goalBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    void sendGoal()
  }
})
goalSend.addEventListener("click", () => void sendGoal())

async function sendGoal() {
  const tab = state.focused
  const goal = goalBox.value
  if (!tab || !goal.trim() || goalSend.disabled) return
  goalSend.disabled = true
  try {
    const res = await fetch("new-tracker", {
      method: "POST",
      body: JSON.stringify({ tab, goal }),
    })
    if (!res.ok) {
      goalNote.textContent = await res.text()
      return
    }
    const { status }: { status: "sent" | "held" } = await res.json()
    goalBox.value = ""
    goalNote.textContent =
      status === "sent"
        ? "Sent to the tab's agent."
        : "No agent in the tab yet; the next one gets it."
    setTimeout(() => newTrackerForm.hidePopover(), 1500)
  } finally {
    goalSend.disabled = false
  }
}

// The log pane's tabs: the jj log, or the workspace's tests (tests_view.ts),
// which the server starts listing the first time the tab is shown for it
let logTab: "jj" | "tests" | "prs" | "issues" = "jj"
// The Jira project's sprint, the same for every workspace for now
let jira: JiraState | undefined
let jiraAsked = false
async function jiraPost<T>(route: string, body: object): Promise<T | string> {
  const res = await fetch(route, {
    method: "POST",
    body: JSON.stringify({ tab: state.focused, ...body }),
  })
  if (!res.ok) return await res.text()
  return res.status === 204 ? (null as T) : ((await res.json()) as T)
}
const jiraView = new JiraView(issuesPane, () => void jiraPost("jira", { refresh: true }), {
  open: async (issue: Issue) => {
    const r = await jiraPost<{ html: string; transitions: Transition[] }>("jira-issue", {
      key: issue.key,
    })
    if (typeof r === "string") throw new Error(r)
    return r
  },
  move: async (issue, transition) => {
    const r = await jiraPost<null>("jira-transition", { key: issue.key, transition })
    return typeof r === "string" ? r : null
  },
  track: async (issue) => {
    const r = await jiraPost<{ status: string }>("jira-tracker", { key: issue.key })
    return typeof r === "string" ? r : r.status
  },
})
const prs = new Map<string, PrsState>() // root -> its PRs
const prsAsked = new Set<string>() // roots the server was asked to fetch for
const prsView = new PrsView(prsPane, () => void prsRequest(true), {
  load: async (pr) => {
    const res = await fetch("pr-threads", {
      method: "POST",
      body: JSON.stringify({ tab: state.focused, repo: pr.repo, number: pr.number }),
    })
    if (!res.ok) throw new Error(await res.text())
    return ((await res.json()) as { threads: Thread[] }).threads
  },
  send: async (pr, thread) => {
    const res = await fetch("pr-thread-send", {
      method: "POST",
      body: JSON.stringify({
        tab: state.focused,
        repo: pr.repo,
        number: pr.number,
        thread: thread.id,
      }),
    })
    if (!res.ok) return await res.text()
    return ((await res.json()) as { status: string }).status
  },
  review: async (pr) => {
    const res = await fetch("pr-review", {
      method: "POST",
      body: JSON.stringify({ tab: state.focused, repo: pr.repo, number: pr.number }),
    })
    return res.ok ? null : await res.text()
  },
  askAgent: async (pr) => {
    const res = await fetch("pr-review-agent", {
      method: "POST",
      body: JSON.stringify({ tab: state.focused, repo: pr.repo, number: pr.number }),
    })
    if (!res.ok) return await res.text()
    return ((await res.json()) as { status: string }).status
  },
  conversation: async (pr) => {
    const res = await fetch("pr-conversation", {
      method: "POST",
      body: JSON.stringify({ tab: state.focused, repo: pr.repo, number: pr.number }),
    })
    if (!res.ok) throw new Error(await res.text())
    return (await res.json()) as Conversation
  },
  sendItem: async (pr, item) => {
    const res = await fetch("pr-conversation-send", {
      method: "POST",
      body: JSON.stringify({
        tab: state.focused,
        repo: pr.repo,
        number: pr.number,
        thread: item.url,
      }),
    })
    if (!res.ok) return await res.text()
    return ((await res.json()) as { status: string }).status
  },
  skepsis: async (pr) => {
    const res = await fetch("pr-skepsis", {
      method: "POST",
      body: JSON.stringify({ tab: state.focused, repo: pr.repo, number: pr.number }),
    })
    return res.ok ? null : await res.text()
  },
  done: async (name) => {
    const res = await fetch("pr-review-done", {
      method: "POST",
      body: JSON.stringify({ tab: state.focused, name }),
    })
    return res.ok ? null : await res.text()
  },
})

async function prsRequest(refresh: boolean) {
  const tab = state.focused
  if (!tab) return
  const res = await fetch("prs", { method: "POST", body: JSON.stringify({ tab, refresh }) })
  if (!res.ok) console.error("ah: PRs request failed:", res.status, await res.text())
}
const tests = new Map<string, TestsState>() // root -> its tests
const testsAsked = new Set<string>() // roots the server was asked to list
const testsView = new TestsView(
  testsPane,
  () => void testsRequest(true),
  (file, line, float) => {
    if (state.focused) void openLink({ tab: state.focused, file, line, float })
  },
  (file, line, e) => showOpenMenu(e, file, line),
)

async function testsRequest(run: boolean) {
  const tab = state.focused
  if (!tab) return
  const res = await fetch("tests", { method: "POST", body: JSON.stringify({ tab, run }) })
  if (!res.ok) console.error("ah: tests request failed:", res.status, await res.text())
}

function renderLogTabs() {
  for (const t of document.querySelectorAll<HTMLElement>(".log-tab"))
    t.classList.toggle("current", t.dataset.tab === logTab)
  logPane.hidden = logTab !== "jj"
  testsPane.hidden = logTab !== "tests"
  prsPane.hidden = logTab !== "prs"
  issuesPane.hidden = logTab !== "issues"
  issuesBadgeEl.textContent = jiraBadge(jira)
  if (logTab === "issues") {
    if (!jiraAsked) {
      jiraAsked = true
      void jiraPost("jira", {})
    }
    jiraView.render(jira)
    return
  }
  const root = focusedRoot()
  testsBadgeEl.textContent = testsBadge(root ? tests.get(root) : undefined)
  const shownPrs = root ? prs.get(root) : undefined
  prsBadgeEl.textContent = shownPrs ? prsBadge(shownPrs.prs) : ""
  if (logTab === "prs" && root) {
    if (!prsAsked.has(root)) {
      prsAsked.add(root)
      void prsRequest(false)
    }
    prsView.render(shownPrs)
    return
  }
  if (logTab !== "tests" || !root) return
  if (!testsAsked.has(root)) {
    testsAsked.add(root)
    void testsRequest(false)
  }
  testsView.render(tests.get(root))
}

for (const t of document.querySelectorAll<HTMLElement>(".log-tab"))
  t.addEventListener("click", () => {
    const name = t.dataset.tab
    logTab = name === "tests" || name === "prs" || name === "issues" ? name : "jj"
    renderLogTabs()
  })

// A file or change ID in the log (ansi.ts) opens in the doc editor, nvim,
// or skepsis; the server picks which (links.ts). nvim opens in the split
// under the log, or with ⌥ in a Rex float. Not at the end of a drag that
// selected the link's text.
// Right-click on a file: every way to open it (links.ts `with`), now that
// there are several. A plain click is still its default, ⌥ still the float.
const openMenu = byId("open-menu")
const isDoc = (file: string) => /\.(md|markdown|html?)$/i.test(file)

function showOpenMenu(e: MouseEvent, file: string, line?: number) {
  const tab = state.focused
  if (!tab) return
  const choices: [string, "doc" | "nvim" | "float" | "emacs"][] = [
    ["nvim, under the log", "nvim"],
    ["nvim, in a Rex float", "float"],
    ["Emacs", "emacs"],
  ]
  if (isDoc(file)) choices.unshift(["Doc editor", "doc"])
  openMenu.replaceChildren(
    el("div", { className: "open-menu-file", title: file }, file.split("/").at(-1) ?? file),
    ...choices.map(([label, pick]) =>
      el(
        "button",
        {
          onclick: () => {
            openMenu.hidePopover()
            void openLink({ tab, file, line, with: pick })
          },
        },
        label,
      ),
    ),
  )
  openMenu.style.left = `${Math.min(e.clientX, document.documentElement.clientWidth - 220)}px`
  openMenu.style.top = `${e.clientY}px`
  openMenu.showPopover()
}

// A manual popover, dismissed here: the browser's light dismiss would close
// it on the release of the right-click that opened it, since macOS fires
// contextmenu on the press. A press outside it, Escape, a scroll, or the
// window losing focus close it.
const closeOpenMenu = () => {
  if (openMenu.matches(":popover-open")) openMenu.hidePopover()
}
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!openMenu.contains(e.target as Node)) closeOpenMenu()
  },
  true,
)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOpenMenu()
})
document.addEventListener("scroll", closeOpenMenu, true)
window.addEventListener("blur", closeOpenMenu)

logPane.addEventListener("contextmenu", (e) => {
  const a = (e.target as Element).closest<HTMLElement>("a[data-file]")
  if (!a?.dataset.file) return
  e.preventDefault()
  showOpenMenu(e, a.dataset.file)
})

logPane.addEventListener("click", (e) => {
  const a = (e.target as Element).closest<HTMLElement>("a[data-file], a[data-rev]")
  if (!a || !state.focused || getSelection()?.toString()) return
  const { file, rev } = a.dataset
  const tab = state.focused
  void openLink({ tab, ...(file ? { file, float: e.altKey } : { rev }) })
})

async function openLink(body: {
  tab: string
  file?: string
  rev?: string
  float?: boolean
  line?: number
  with?: "doc" | "nvim" | "float" | "emacs"
}) {
  const res = await fetch("open", { method: "POST", body: JSON.stringify(body) })
  if (!res.ok)
    return console.error("ah: couldn't open the link:", res.status, await res.text())
  // The split's socket; every other opener answers with no content
  if (res.status !== 200 || !body.file) return
  const { editor, doc }: { editor: string; doc: string } = await res.json()
  openSplit(body.tab, body.file, editor, doc, body.line)
}

// tab -> nvim on a file in the split under the log, on the doc editor's pane
// socket (routes.ts), hidden unless its tab is focused. The file's doc socket
// is open alongside only so the server keeps the file, and nvim with it. A
// new file replaces the tab's; :q or ✕ closes it.
// pane is null only while it's being made
const splits = new Map<
  string,
  { path: string; host: HTMLElement; doc: WebSocket; pane: TerminalPane | null }
>()

function openSplit(
  tab: string,
  path: string,
  editor: string,
  docUrl: string,
  line?: number,
) {
  const open = splits.get(tab)
  if (open?.path === path && open.pane)
    return void (line && revealLine(open.pane, open.host, line))
  closeSplit(tab)
  const host = el("div", { className: "nvim-host" })
  nvimPane.append(host)
  const doc = new WebSocket(wsUrl(docUrl))
  const split = { path, host, doc, pane: null as TerminalPane | null }
  // Shown first, so the terminal fits the pane it opens in
  splits.set(tab, split)
  renderSplit()
  split.pane = new TerminalPane(host, wsUrl(editor), neovim, () => {
    if (splits.get(tab) === split) closeSplit(tab)
  })
  split.pane.show()
  if (line) void revealLine(split.pane, host, line)
}

/** Put nvim's cursor on the 1-based line, a third of the way down the pane */
async function revealLine(pane: TerminalPane, host: HTMLElement, line: number) {
  const box = host.getBoundingClientRect()
  pane.show()
  await pane.reveal(line - 1, 0, box.top + box.height / 3)
}

function closeSplit(tab: string) {
  const split = splits.get(tab)
  if (!split) return
  splits.delete(tab)
  split.pane?.close()
  split.doc.close()
  split.host.remove()
  renderSplit()
}

function renderSplit() {
  const split = state.focused ? splits.get(state.focused) : undefined
  document.body.classList.toggle("has-nvim", !!split)
  for (const s of splits.values()) s.host.hidden = s !== split
  nvimName.textContent = split?.path ?? ""
}

byId("nvim-close").addEventListener("click", () => {
  if (state.focused) closeSplit(state.focused)
})

/** A WebSocket URL for one of the server's paths */
function wsUrl(path: string): string {
  const url = new URL(path, location.href)
  url.protocol = "ws:"
  return url.href
}

// Cmd+1–8 for the nth tab and Cmd+9 for the last, as in a browser, and
// Cmd+Opt+Left/Right for the previous and next, wrapping. Keys pressed in a
// frame go to the frame's page, not here.
document.addEventListener("keydown", (e) => {
  if (!e.metaKey || e.ctrlKey || e.shiftKey) return
  const { tabs } = state
  if (tabs.length === 0) return
  let i: number | null = null
  if (!e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const n = Number(e.code.at(-1))
    i = n === 9 ? tabs.length - 1 : n - 1
    if (i >= tabs.length) return
  } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const cur = tabs.findIndex((t) => t.id === state.focused)
    const step = e.key === "ArrowRight" ? 1 : -1
    i = cur === -1 ? 0 : (cur + step + tabs.length) % tabs.length
  } else return
  e.preventDefault()
  if (tabs[i].id !== state.focused) void focus(tabs[i].id)
})

// ⌘I (Ctrl+I in terminal-browser panes) toggles the conversation of the
// tracker in view, as in its own page; the frame only gets the keys itself
// once it has been clicked
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "i" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey)
    return
  const view = state.focused ? docs.get(state.focused)?.view : null
  if (!(view instanceof HTMLIFrameElement) || !view.contentWindow) return
  e.preventDefault()
  // So the compose box it opens takes the keys
  view.focus()
  view.contentWindow.postMessage("ah-toggle-conversation", new URL(view.src).origin)
})

/** The focused workspace's trackers to switch between, and a menu of the
 * parked ones; picking a parked one resumes it */
function renderTrackers(tab: string | null) {
  const root = state.tabs.find((t) => t.id === tab)?.root
  const t = root ? trackers.get(root) : undefined
  if (!tab || !t || (!t.current && !t.active.length && !t.parked.length)) {
    trackerStrip.replaceChildren()
    parkedMenu.hidePopover()
    parkedMenu.replaceChildren()
    return
  }
  const trackerTab = (path: string, className: string) =>
    el(
      "span",
      { className, title: path, onclick: () => void pickTracker(tab, path) },
      trackerName(path),
    )
  // A button for popovertarget, which opens and closes the menu, and leaves
  // closing it on Escape or a click outside to the browser
  const toggle = t.parked.length
    ? [
        Object.assign(
          el(
            "button",
            { className: "tracker-tab parked-toggle", title: "The parked trackers" },
            `${t.parked.length} parked`,
          ),
          { popoverTargetElement: parkedMenu },
        ),
      ]
    : []
  trackerStrip.replaceChildren(
    // By path, which for dated notes directories is oldest first, so
    // switching doesn't reorder them
    ...t.active
      .toSorted()
      .map((path) =>
        trackerTab(path, "tracker-tab" + (path === t.current ? " current" : "")),
      ),
    ...toggle,
  )
  if (!t.parked.length) parkedMenu.hidePopover()
  parkedMenu.replaceChildren(
    ...t.parked.map((path) =>
      el(
        "button",
        {
          title: path,
          onclick: () => {
            parkedMenu.hidePopover()
            void pickTracker(tab, path)
          },
        },
        trackerName(path),
      ),
    ),
  )
}

// The menu opens in the top layer, above a frame, so it's placed by hand:
// under the tracker strip, lined up with the toggle at its right end
parkedMenu.addEventListener("beforetoggle", (e) => {
  const toggle = trackerStrip.querySelector(".parked-toggle")
  if (e.newState !== "open" || !toggle) return
  parkedMenu.style.top = trackerStrip.getBoundingClientRect().bottom + "px"
  parkedMenu.style.right =
    document.documentElement.clientWidth - toggle.getBoundingClientRect().right + "px"
})
// So it closes when the toggle moves out from under it, and on a click in a
// frame, which the browser's light dismiss doesn't see but takes the focus
// from this window
const closeParked = () => parkedMenu.hidePopover()
docPane.addEventListener("scroll", closeParked)
window.addEventListener("resize", closeParked)
window.addEventListener("blur", closeParked)
// Up and down through the parked trackers, as in a menu
parkedMenu.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
  e.preventDefault()
  const items = [...parkedMenu.children] as HTMLElement[]
  const i = items.indexOf(document.activeElement as HTMLElement)
  const step = e.key === "ArrowDown" ? 1 : -1
  const next = i === -1 ? (step === 1 ? 0 : -1) : (i + step) % items.length
  items.at(next)?.focus()
})

async function pickTracker(tab: string, path: string) {
  const res = await fetch("tracker", {
    method: "POST",
    body: JSON.stringify({ tab, path }),
  })
  if (!res.ok) console.error("ah: couldn't switch trackers:", await res.text())
}

function renderDoc(tab: string | null) {
  const doc = tab ? docs.get(tab) : null
  renderTrackers(tab)
  document.body.classList.toggle("has-doc", !!doc || trackerStrip.childElementCount > 0)
  // A frame scrolls itself, so the pane doesn't
  document.body.classList.toggle("doc-frame", doc?.view.tagName === "IFRAME")
  for (const t of docs.values()) t.view.hidden = t !== doc
  docName.textContent = doc ? (doc.path.split("/").at(-1) ?? "") : ""
  docName.title = doc?.path ?? ""
  if (shownDoc === tab) return
  if (shownDoc) docScrollTops.set(shownDoc, docPane.scrollTop)
  docPane.scrollTop = tab ? (docScrollTops.get(tab) ?? 0) : 0
  shownDoc = tab
}

const events = new EventSource("events")
events.addEventListener("hello", (e) => {
  const v: string = JSON.parse(e.data).version
  if (version && v !== version) location.reload()
  version = v
})
events.addEventListener("state", (e) => {
  state = JSON.parse(e.data)
  render()
})
events.addEventListener("jj", (e) => {
  const { root, html }: { root: string; html: string } = JSON.parse(e.data)
  logs.set(root, html)
  if (root === focusedRoot()) render()
})
events.addEventListener("jira", (e) => {
  jira = JSON.parse(e.data)
  jiraAsked = true
  renderLogTabs()
})
events.addEventListener("prs", (e) => {
  const s: PrsState = JSON.parse(e.data)
  prs.set(s.root, s)
  prsAsked.add(s.root)
  if (s.root === focusedRoot()) renderLogTabs()
})
events.addEventListener("tests", (e) => {
  const s: TestsState = JSON.parse(e.data)
  tests.set(s.root, s)
  // Listed already, for this page or another
  testsAsked.add(s.root)
  if (s.root === focusedRoot()) renderLogTabs()
})
events.addEventListener("trackers", (e) => {
  const {
    root,
    ...t
  }: { root: string; current: string | null; active: string[]; parked: string[] } =
    JSON.parse(e.data)
  trackers.set(root, t)
  if (root === focusedRoot()) renderDoc(state.focused)
})
events.addEventListener("doc", (e) => {
  const {
    tab,
    path,
    url,
    frame,
  }: { tab: string; path: string | null; url: string | null; frame: boolean } = JSON.parse(
    e.data,
  )
  const tag = frame ? "IFRAME" : "AH-MARKDOWN"
  let t = docs.get(tab)
  // Gone, or a switch between markdown and html, which needs the other
  // kind of view
  if (t && (!url || t.view.tagName !== tag)) {
    t.view.remove()
    docs.delete(tab)
    t = undefined
  }
  if (url && path && t) {
    t.path = path
    // A frame would reload on any set; ah-markdown ignores the same file
    if (t.view.getAttribute("src") !== url) t.view.setAttribute("src", url)
  } else if (url && path) {
    const view = el(tag.toLowerCase(), { hidden: tab !== state.focused })
    view.setAttribute("src", url)
    // A frame's URL says so already
    if (!frame) view.setAttribute("in", "dashboard")
    docPane.append(view)
    docs.set(tab, { path, view })
  }
  if (tab === state.focused) renderDoc(tab)
})
// The dot: grey when the stream is down or the server stopped pinging it
// (every 15s, routes.ts), amber when the server can't follow Rex
let connected = false
let lastPing = 0
let rexTrouble: string | null = null
function renderStatus() {
  const silent = Date.now() - lastPing > 40_000
  status.className = !connected || silent ? "" : rexTrouble ? "trouble" : "live"
  status.title = !connected
    ? "disconnected"
    : silent
      ? "the server stopped answering"
      : (rexTrouble ?? "connected")
}
setInterval(renderStatus, 5000)
events.addEventListener("ping", () => {
  lastPing = Date.now()
  renderStatus()
})
events.addEventListener("health", (e) => {
  rexTrouble = JSON.parse(e.data).rex
  renderStatus()
})
events.onopen = () => {
  connected = true
  lastPing = Date.now()
  renderStatus()
}
events.onerror = () => {
  connected = false
  renderStatus()
}
