// The dashboard's routes, under /view/dashboard/: the page, and the SSE stream
// it follows. The server follows Rex (platform/rex.ts) and hands each new RexState
// to onRex; the dashboard keeps a live jj log for
// every open workspace (jj.ts), and pushes both to the page (page.html, with
// its script in client.ts), along with each tab's file, its workspace's
// current tracker (core/trackers.ts), which the page shows with markdown's <ah-markdown>
// element, or in a frame for an html file. The focused workspace gets
// snapshotted once edits settle, so @ stays current between jj commands.

import { type ChildProcess, spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { assetPath } from "../../platform/assets.ts"
import { ClientBundles } from "../../platform/bundle.ts"
import type { HtmlBackend } from "../html/routes.ts"
import type { MarkdownBackend } from "../markdown/routes.ts"
import type { Core } from "../../core/core.ts"
import {
  fileKind,
  type RexState,
  type TrackerEntry,
  type WorkspaceTrackers,
} from "../../core/model.ts"
import { Presence } from "../../platform/presence.ts"
import { openFloat, selectTab } from "../../platform/rex.ts"
import { closeWindows } from "../../platform/window.ts"
import { LogWatcher, SnapshotWatcher } from "./jj.ts"
import { readDescription, resolveOp, runOp } from "./ops.ts"
import { detectRunners } from "./tests/detect.ts"
import { listTests, runTests } from "./tests/run.ts"
import { TestsWatcher } from "./tests/watcher.ts"
import { githubRepos } from "./prs/github.ts"
import { PR_FIELDS, PrsWatcher } from "./prs/watcher.ts"
import {
  parseThreads,
  replyArgs,
  resolveArgs,
  THREADS_QUERY,
  threadMessage,
} from "./prs/threads.ts"
import {
  CONVERSATION_QUERY,
  conversationMessage,
  parseConversation,
} from "./prs/conversation.ts"
import { adfToHtml, adfToText, issueGoal, parseTransitions } from "./jira/jira.ts"
import { JiraWatcher } from "./jira/watcher.ts"
import { ownPrDiff, planReview, reviewMessage } from "./prs/review.ts"
import {
  type InboxComment,
  parseSkepsisComment,
  type ReviewEvent,
  reviewRequest,
} from "./prs/inbox.ts"
import type { Pr } from "./prs/github.ts"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { bringIn, cleanUp, reviewWorkspaces } from "./prs/review_run.ts"
import { ahStateDir } from "../../platform/paths.ts"
import { mkdir } from "node:fs/promises"
import { resolveLink } from "./links.ts"
import { forwardGoal } from "./new_tracker.ts"
import {
  docLaunch,
  emacsCommands,
  type Launch,
  nvimFloat,
  type Pane,
  paneIn,
  skepsisDiffLaunch,
  skepsisLaunch,
} from "./openers.ts"
import { run } from "../../platform/proc.ts"
import { rootFinder } from "../../core/workspace.ts"
import { type DashTab, focusedRoot, resolve, type State } from "./workspace.ts"

/** How to run ah itself, as the server was run */
const AH = [process.execPath, ...process.execArgv, process.argv[1]]

/** Where the skepsis skill runs it from (skills/skepsis/SKILL.md) */
const SKEPSIS = join(homedir(), "code/utilities/skepsis/cli.ts")

// HACK: the Jira project is hard-coded to David's team until ah has
// settings: a JSON config with a settings pane, its own tracker. Extract it
// then, as a workspace-to-project mapping.
const JIRA_PROJECT = "EDGE"

/** How long skepsis gets to start listening before a click gives up */
const SKEPSIS_START_MS = 15_000

// Changes on every server start. The page reloads when it reconnects to a
// different server, so restarting the server is enough to pick up page edits.
const SERVER_VERSION = String(Date.now())

const encoder = new TextEncoder()

type Client = ReadableStreamDefaultController<Uint8Array>

const send = (c: Client, event: string, data: string) =>
  c.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))

const logEvent = (root: string, html: string) => JSON.stringify({ root, html })

/** A workspace's trackers as the page's switcher shows them */
const trackersEvent = (root: string, t: WorkspaceTrackers) =>
  JSON.stringify({
    root,
    current: t.current && "path" in t.current ? t.current.path : null,
    active: paths(t.active),
    parked: paths(t.parked),
  })

const paths = (entries: TrackerEntry[]) =>
  entries.flatMap((a) => ("path" in a.subject ? [a.subject.path] : []))

/** A tab's file as the page shows it: `frame` for an html page, in an
 * <iframe> of `url`, otherwise in <ah-markdown> */
interface ShownDoc {
  path: string
  url: string
  frame: boolean
}

const docEvent = (tab: string, doc: ShownDoc | null) =>
  JSON.stringify({
    tab,
    path: doc?.path ?? null,
    url: doc?.url ?? null,
    frame: doc?.frame ?? false,
  })

export interface DashboardOptions {
  /** The page shows each file with <ah-markdown> or in a frame of an html
   * page, so the backend has to hold the file open before the page hears about it */
  markdown: MarkdownBackend
  html: HtmlBackend
  /** The agents, whose files the tabs show */
  core: Core
  /** The server's, for the commands that open links from the log */
  port: number
}

/** How often the stream says the server is still there; the page goes grey
 * after a few missed (client.ts) */
const PING_MS = 15_000

export class Dashboard {
  #page = readFile(assetPath("views/dashboard/page.html"), "utf8")
  #bundles = new ClientBundles("dashboard")
  #state: State = { focused: null, tabs: [] }
  #stateJson = JSON.stringify(this.#state)
  #logs = new Map<string, LogWatcher>()
  #snapshotter: SnapshotWatcher | null = null
  /** root -> its tests, from the first time the page opens its Tests tab */
  #tests = new Map<string, TestsWatcher>()
  /** root -> its PRs, from the first time the page opens its PRs tab */
  #prs = new Map<string, PrsWatcher>()
  /** "owner/name#n" -> comments from skepsis on that PR, waiting to be sent
   * to GitHub or the agent (prs/inbox.ts) */
  #inbox = new Map<string, InboxComment[]>()
  #inboxIds = 0
  /** The Jira project's sprint, from the first time the page opens the
   * Issues tab */
  #jira: JiraWatcher | null = null
  /** The Jira host acli is signed in to, asked once */
  #jiraSite: Promise<string> | null = null
  /** Whether cargo-nextest is installed, asked once */
  #nextest: Promise<boolean> | null = null
  #clients = new Set<Client>()
  /** Whether a dashboard window is open, for telling agents when none is
   * (core/notices.ts) */
  readonly presence = new Presence()
  #rex: RexState | null = null
  /** tab -> its file */
  #files = new Map<string, string>()
  /** workspace root -> its trackers, as last sent */
  #trackers = new Map<string, string>()
  /** tab -> what the page was last told to show */
  #shown = new Map<string, ShownDoc>()
  #docQueue: Promise<void> = Promise.resolve()
  /** What's wrong with the server's view of Rex, as last sent */
  #healthJson = JSON.stringify({ rex: null })
  /** tab -> the skepsis a click on a change ID started there, and its page's
   * URL once it's listening */
  #skepsis = new Map<string, { child: ChildProcess; url: string | null }>()

  readonly options: DashboardOptions

  constructor(options: DashboardOptions) {
    this.options = options
    options.core.subscribe(() => this.#syncFiles())
    // So the page can tell a hung server from a quiet one, which an open
    // stream alone doesn't
    setInterval(() => this.#broadcast("ping", "{}"), PING_MS).unref()
  }

  /** Why the server can't follow Rex, or null when it can */
  setRexTrouble(rex: string | null) {
    const json = JSON.stringify({ rex })
    if (json === this.#healthJson) return
    this.#healthJson = json
    this.#broadcast("health", json)
  }

  /** Each tab's file, its workspace's current tracker, and each
   * workspace's trackers; tells the page about the ones that changed */
  #syncFiles() {
    if (!this.#rex) return
    const trackers = new Map<string, WorkspaceTrackers>()
    for (const root of new Set(this.#state.tabs.map((t) => t.root)))
      trackers.set(root, this.options.core.trackers.get(root))
    for (const [root, t] of trackers) {
      const json = trackersEvent(root, t)
      if (this.#trackers.get(root) === json) continue
      this.#trackers.set(root, json)
      this.#broadcast("trackers", json)
    }
    for (const root of this.#trackers.keys())
      if (!trackers.has(root)) this.#trackers.delete(root)
    const next = new Map<string, string>()
    for (const tab of this.#state.tabs) {
      const current = trackers.get(tab.root)?.current
      if (current && "path" in current) next.set(tab.id, current.path)
    }
    for (const tab of new Set([...this.#files.keys(), ...next.keys()])) {
      const path = next.get(tab) ?? null
      if ((this.#files.get(tab) ?? null) === path) continue
      // One at a time, since show takes a moment: two quick changes for a
      // tab would otherwise broadcast whichever finished last
      this.#docQueue = this.#docQueue.then(async () => {
        // Also reopens it if someone closed it
        const shown = path && (await this.#show(path))
        if (shown) this.#shown.set(tab, shown)
        else this.#shown.delete(tab)
        this.#broadcast("doc", docEvent(tab, shown || null))
      })
    }
    this.#files = next
  }

  /** Open the file in the backend that shows it. An html page is
   * see-through, to sit on the dashboard's background. */
  async #show(path: string): Promise<ShownDoc | null> {
    if (fileKind(path) === "html") {
      const info = await this.options.html.show(path)
      return info && { path, url: `${info.url}?in=dashboard`, frame: true }
    }
    const info = await this.options.markdown.show(path)
    return info && { path, url: info.url, frame: false }
  }

  onRex(rex: RexState) {
    // A fresh finder each time: a cached root can be removed (`jjw rm` with
    // a tab still in it), and a cached miss can become a workspace
    this.#rex = rex
    this.#setState(resolve(rex, rootFinder(), this.#state.focused))
    // Tabs open and close
    this.#syncFiles()
  }

  #setState(next: State) {
    const nextJson = JSON.stringify(next)
    if (nextJson === this.#stateJson) return
    this.#state = next
    this.#stateJson = nextJson
    this.#syncWatchers()
    this.#broadcast("state", this.#stateJson)
  }

  /** How many pages are following the stream */
  get pages(): number {
    return this.#clients.size
  }

  #broadcast(event: string, data: string) {
    for (const c of this.#clients) {
      try {
        send(c, event, data)
      } catch {
        this.#clients.delete(c)
        this.presence.update(this.#clients.size)
      }
    }
  }

  // A log watcher for every open workspace, not only the focused one, so a
  // tab switch shows an up-to-date log straight from the page's cache.
  #syncWatchers() {
    const open = new Set(this.#state.tabs.map((t) => t.root))
    for (const [root, watcher] of this.#logs) {
      if (open.has(root)) continue
      watcher.close()
      this.#logs.delete(root)
    }
    for (const [root, tests] of this.#tests) {
      if (open.has(root)) continue
      tests.close()
      this.#tests.delete(root)
    }
    for (const [root, prs] of this.#prs) {
      if (open.has(root)) continue
      prs.close()
      this.#prs.delete(root)
    }
    for (const root of open) {
      if (this.#logs.has(root)) continue
      this.#logs.set(
        root,
        new LogWatcher(root, (html) => {
          this.#broadcast("jj", logEvent(root, html))
          void this.#operationLanded(root)
        }),
      )
    }
    // Only the focused workspace gets snapshotted: it's the one on screen, and
    // watching every file in every open workspace would be wasteful
    const focused = focusedRoot(this.#state)
    if (this.#snapshotter?.root !== focused) {
      this.#snapshotter?.close()
      // Its changes run the tests they touch, once the Tests tab is open there
      this.#snapshotter = focused
        ? new SnapshotWatcher(focused, (changed) => this.#tests.get(focused)?.run(changed))
        : null
    }
  }

  /** `rest` is the path after /view/dashboard/ */
  async handle(req: Request, rest: string): Promise<Response> {
    if (rest === "") {
      this.#bundles.prebuild("client.js")
      return new Response(await this.#page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    if (this.#bundles.has(rest)) return await this.#bundles.response(rest)
    if (rest === "events") return this.#events()
    if (rest === "focus" && req.method === "POST") return await this.#focus(req)
    if (rest === "tracker" && req.method === "POST") return await this.#pickTracker(req)
    if (rest === "open" && req.method === "POST") return await this.#openLink(req)
    if (rest === "jj-op" && req.method === "POST") return await this.#jjOp(req)
    if (rest === "jj-description" && req.method === "POST")
      return await this.#jjDescription(req)
    if (rest === "tests" && req.method === "POST") return await this.#testsRequest(req)
    if (rest === "new-tracker" && req.method === "POST") return await this.#newTracker(req)
    if (rest === "prs" && req.method === "POST") return await this.#prsRequest(req)
    if (rest === "pr-threads" && req.method === "POST") return await this.#prThreads(req)
    if (rest === "pr-thread-send" && req.method === "POST")
      return await this.#sendThread(req)
    if (rest === "pr-review" && req.method === "POST") return await this.#reviewPr(req)
    if (rest === "pr-skepsis" && req.method === "POST") return await this.#ownPrSkepsis(req)
    if (rest === "review-comment" && req.method === "POST")
      return await this.#takeComment(req)
    if (rest === "pr-thread-reply" && req.method === "POST")
      return await this.#threadWrite(req, "reply")
    if (rest === "pr-thread-resolve" && req.method === "POST")
      return await this.#threadWrite(req, "resolve")
    if (rest === "review-inbox" && req.method === "POST")
      return await this.#inboxAction(req)
    if (rest === "review-submit" && req.method === "POST")
      return await this.#submitReview(req)
    if (rest === "pr-conversation" && req.method === "POST")
      return await this.#prConversation(req)
    if (rest === "pr-conversation-send" && req.method === "POST")
      return await this.#sendConversationItem(req)
    if (rest === "pr-review-agent" && req.method === "POST")
      return await this.#askReview(req)
    if (rest === "pr-review-done" && req.method === "POST")
      return await this.#doneReviewing(req)
    if (rest === "jira" && req.method === "POST") return await this.#jiraRequest(req)
    if (rest === "jira-issue" && req.method === "POST") return await this.#jiraIssue(req)
    if (rest === "jira-transition" && req.method === "POST")
      return await this.#jiraTransition(req)
    if (rest === "jira-tracker" && req.method === "POST")
      return await this.#jiraTracker(req)
    return new Response("not found", { status: 404 })
  }

  /** The page opened a tab's PRs tab, which starts fetching its
   * workspace's PRs, or clicked Refresh */
  async #prsRequest(req: Request): Promise<Response> {
    const { tab: id, refresh }: { tab?: unknown; refresh?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const known = this.#prs.has(tab.root)
    const prs = this.#prsFor(tab.root)
    if (!known || refresh === true) void prs.refresh()
    return new Response(null, { status: 204 })
  }

  #prsFor(root: string): PrsWatcher {
    let prs = this.#prs.get(root)
    if (prs) return prs
    const jj = (args: string[]) =>
      run("jj", ["--ignore-working-copy", ...args], { cwd: root })
    prs = new PrsWatcher(root, {
      repos: async () => githubRepos((await jj(["git", "remote", "list"])).stdout),
      // Bookmarks on commits not yet in an immutable one: the work a PR
      // could be open for
      branches: async () =>
        (
          await jj([
            "bookmark",
            "list",
            "-r",
            "mutable()",
            "-T",
            'if(!remote, name ++ "\n")',
          ])
        ).stdout
          .split("\n")
          .filter(Boolean),
      list: async (repo) => {
        const o = await run(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            repo,
            "--state",
            "all",
            "--limit",
            "50",
            "--json",
            PR_FIELDS,
          ],
          { cwd: root },
        )
        if (!o.success) throw new Error(o.stderr.trim() || `gh exited with ${o.code}`)
        return o.stdout
      },
      onChange: (state) => this.#broadcast("prs", JSON.stringify(state)),
    })
    this.#prs.set(root, prs)
    // Ones left from before, to clean up
    void reviewWorkspaces(root).then((names) => prs.setReviews(names))
    return prs
  }

  /** A PR the tab's PRs tab lists, for the requests about one; the page
   * can't name another repo's */
  async #listedPr(req: Request) {
    const body: { tab?: unknown; repo?: unknown; number?: unknown; thread?: unknown } =
      await req.json()
    const tab = this.#state.tabs.find((t) => t.id === body.tab)
    const listed = tab ? this.#prs.get(tab.root)?.state : undefined
    const pr = [...(listed?.prs ?? []), ...(listed?.others ?? [])].find(
      (p) => p.repo === body.repo && p.number === body.number,
    )
    return { tab, pr, thread: body.thread }
  }

  /** A GraphQL query about one PR, through gh */
  async #prQuery(root: string, query: string, repo: string, number: number) {
    const [owner, name] = repo.split("/")
    const o = await run(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${number}`,
      ],
      { cwd: root },
    )
    if (!o.success) throw new Error(o.stderr.trim() || `gh exited with ${o.code}`)
    return o.stdout
  }

  async #threadsOf(root: string, repo: string, number: number) {
    return parseThreads(await this.#prQuery(root, THREADS_QUERY, repo, number))
  }

  /** A PR's description, comments and reviews (conversation.ts), when the
   * page opens them */
  async #prConversation(req: Request): Promise<Response> {
    const { tab, pr } = await this.#listedPr(req)
    if (!tab || !pr) return new Response("not a PR in the tab's list", { status: 404 })
    try {
      const json = await this.#prQuery(tab.root, CONVERSATION_QUERY, pr.repo, pr.number)
      return Response.json(parseConversation(json))
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
    }
  }

  /** A comment or review the user sent to the tab's agent, by its URL,
   * fetched again so the agent gets it as it is now */
  async #sendConversationItem(req: Request): Promise<Response> {
    const { tab, pr, thread: url } = await this.#listedPr(req)
    if (!tab || !pr) return new Response("not a PR in the tab's list", { status: 404 })
    const pane = this.#paneOf(tab)
    if (!pane) return new Response("no pane in the tab", { status: 404 })
    let item
    try {
      const json = await this.#prQuery(tab.root, CONVERSATION_QUERY, pr.repo, pr.number)
      item = parseConversation(json).items.find((i) => i.url === url)
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
    }
    if (!item) return new Response("no such comment on the PR", { status: 404 })
    const status = await this.options.core.send(pane.block, conversationMessage(pr, item))
    return Response.json({ status })
  }

  /** A PR's review threads, when the page opens them */
  async #prThreads(req: Request): Promise<Response> {
    const { tab, pr } = await this.#listedPr(req)
    if (!tab || !pr) return new Response("not a PR in the tab's list", { status: 404 })
    try {
      return Response.json({ threads: await this.#threadsOf(tab.root, pr.repo, pr.number) })
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
    }
  }

  /** A thread the user sent to the tab's agent (threads.ts), fetched again
   * so the agent gets it as it is now */
  async #sendThread(req: Request): Promise<Response> {
    const { tab, pr, thread: id } = await this.#listedPr(req)
    if (!tab || !pr) return new Response("not a PR in the tab's list", { status: 404 })
    const pane = this.#paneOf(tab)
    if (!pane) return new Response("no pane in the tab", { status: 404 })
    let thread
    try {
      thread = (await this.#threadsOf(tab.root, pr.repo, pr.number)).find(
        (t) => t.id === id,
      )
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
    }
    if (!thread) return new Response("no such thread on the PR", { status: 404 })
    const status = await this.options.core.send(pane.block, threadMessage(pr, thread))
    return Response.json({ status })
  }

  /** The page opened the Issues tab, which starts fetching the sprint, or
   * clicked Refresh */
  async #jiraRequest(req: Request): Promise<Response> {
    const { refresh }: { refresh?: unknown } = await req.json()
    const known = this.#jira !== null
    const jira = this.#jiraWatcher()
    if (!known || refresh === true) void jira.refresh()
    return new Response(null, { status: 204 })
  }

  #jiraWatcher(): JiraWatcher {
    if (this.#jira) return this.#jira
    this.#jiraSite ??= run("acli", ["jira", "auth", "status"]).then(
      (o) => /Site:\s*(\S+)/.exec(o.stdout)?.[1] ?? "atlassian.net",
      () => "atlassian.net",
    )
    const site = this.#jiraSite
    this.#jira = new JiraWatcher(JIRA_PROJECT, {
      search: async () => {
        const jql = `project = ${JIRA_PROJECT} AND sprint in openSprints() ORDER BY status, updated DESC`
        const o = await run("acli", [
          "jira",
          "workitem",
          "search",
          "--jql",
          jql,
          "--fields",
          "key,summary,status,assignee,issuetype,priority",
          "--paginate",
          "--json",
        ])
        if (!o.success) throw new Error(o.stderr.trim() || `acli exited with ${o.code}`)
        return o.stdout
      },
      site: () => site,
      onChange: (state) => this.#broadcast("jira", JSON.stringify(state)),
    })
    return this.#jira
  }

  /** A ticket in the sprint the Issues tab lists; the page can't name another */
  async #listedIssue(req: Request) {
    const body: { tab?: unknown; key?: unknown; transition?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === body.tab)
    const issue = this.#jira?.state.issues.find((i) => i.key === body.key)
    return { tab, issue, transition: body.transition }
  }

  async #issueDescription(key: string): Promise<unknown> {
    const o = await run("acli", [
      "jira",
      "workitem",
      "view",
      key,
      "--fields",
      "description",
      "--json",
    ])
    if (!o.success) throw new Error(o.stderr.trim() || `acli exited with ${o.code}`)
    return (JSON.parse(o.stdout) as { fields?: { description?: unknown } }).fields
      ?.description
  }

  async #issueTransitions(key: string) {
    const o = await run("twg", [
      "jira",
      "workitem",
      "transitions",
      "query",
      "--id",
      key,
      "-o",
      "json",
      "--output-summary",
      "none",
    ])
    if (!o.success) throw new Error(o.stderr.trim() || `twg exited with ${o.code}`)
    return parseTransitions(o.stdout)
  }

  /** A ticket's description (as safe HTML, jira.ts) and the statuses it can
   * move to, when the page opens it */
  async #jiraIssue(req: Request): Promise<Response> {
    const { issue } = await this.#listedIssue(req)
    if (!issue) return new Response("not a ticket in the sprint", { status: 404 })
    try {
      const [description, transitions] = await Promise.all([
        this.#issueDescription(issue.key),
        this.#issueTransitions(issue.key),
      ])
      return Response.json({ html: adfToHtml(description), transitions })
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
    }
  }

  /** Move a ticket along one of the transitions Jira offers it now */
  async #jiraTransition(req: Request): Promise<Response> {
    const { issue, transition } = await this.#listedIssue(req)
    if (!issue) return new Response("not a ticket in the sprint", { status: 404 })
    try {
      const offered = await this.#issueTransitions(issue.key)
      if (!offered.some((t) => t.id === transition))
        return new Response("not a transition Jira offers this ticket", { status: 400 })
      const o = await run("twg", [
        "jira",
        "workitem",
        "transition",
        "--id",
        issue.key,
        "--transition-id",
        String(transition),
        "-o",
        "json",
        "--output-summary",
        "none",
      ])
      if (!o.success) throw new Error(o.stderr.trim() || `twg exited with ${o.code}`)
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
    }
    void this.#jira?.refresh()
    return new Response(null, { status: 204 })
  }

  /** Start a tracker on a ticket: its key, summary, link and description go
   * to the tab's agent, as the Add tracker button's goal does (new_tracker.ts) */
  async #jiraTracker(req: Request): Promise<Response> {
    const { tab, issue } = await this.#listedIssue(req)
    if (!tab) return new Response("no such tab", { status: 404 })
    if (!issue) return new Response("not a ticket in the sprint", { status: 404 })
    let description = ""
    try {
      description = adfToText(await this.#issueDescription(issue.key))
    } catch {
      /* the key, summary and link are enough to start on */
    }
    const result = await forwardGoal(
      (block, text) => this.options.core.send(block, text),
      this.#paneOf(tab),
      issueGoal(issue, description),
    )
    if (!result.ok) return new Response(result.error, { status: result.status })
    return Response.json({ status: result.status })
  }

  /** One of the workspace's own PRs in skepsis, on its diff from its base
   * (ownPrDiff), which is fetched first so the diff is against where it is
   * now */
  async #ownPrSkepsis(req: Request): Promise<Response> {
    const { tab, pr } = await this.#listedPr(req)
    if (!tab || !pr || !this.#prs.get(tab.root)?.state.prs.includes(pr))
      return new Response("not one of the tab's own PRs", { status: 404 })
    const pane = this.#paneOf(tab)
    if (!pane) return new Response("no pane in the tab", { status: 404 })
    const remotes = await run("jj", ["git", "remote", "list"], { cwd: tab.root })
    const diff = ownPrDiff(pr, remotes.stdout)
    if (!diff) return new Response(`no remote for ${pr.repo}`, { status: 404 })
    const fetched = await run(
      "jj",
      ["git", "fetch", "--remote", diff.remote, "--branch", `exact:${diff.base}`],
      { cwd: tab.root },
    )
    if (!fetched.success)
      return new Response(fetched.stderr.trim() || "couldn't fetch the base", {
        status: 502,
      })
    const launch = skepsisDiffLaunch(
      diff.from,
      diff.to,
      tab.root,
      pane,
      this.options.port,
      AH,
      SKEPSIS,
      { repo: pr.repo, number: pr.number },
    )
    return await this.#runSkepsis(`pr:${pr.repo}#${pr.number}`, launch)
  }

  /** Reply to a review thread, or resolve or unresolve it, on GitHub: the
   * user's click, on a thread the PR has */
  async #threadWrite(req: Request, kind: "reply" | "resolve"): Promise<Response> {
    const body: {
      tab?: unknown
      repo?: unknown
      number?: unknown
      thread?: unknown
      text?: unknown
      resolved?: unknown
    } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === body.tab)
    const pr = this.#anyListedPr(body.repo, body.number)
    if (!tab || !pr) return new Response("not a PR the dashboard lists", { status: 404 })
    if (kind === "reply" && (typeof body.text !== "string" || !body.text.trim()))
      return new Response("a reply needs text", { status: 400 })
    if (kind === "resolve" && typeof body.resolved !== "boolean")
      return new Response("resolved is true or false", { status: 400 })
    try {
      const threads = await this.#threadsOf(tab.root, pr.repo, pr.number)
      const thread = threads.find((t) => t.id === body.thread)
      if (!thread) return new Response("no such thread on the PR", { status: 404 })
      const args =
        kind === "reply"
          ? replyArgs(thread.id, String(body.text))
          : resolveArgs(thread.id, body.resolved === true)
      const o = await run("gh", args, { cwd: tab.root })
      if (!o.success)
        return new Response(o.stderr.trim() || "GitHub refused it", { status: 502 })
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 502 })
    }
    return new Response(null, { status: 204 })
  }

  /** A PR some workspace's PRs tab lists, its own or one for review */
  #anyListedPr(repo: unknown, number: unknown): Pr | undefined {
    for (const w of this.#prs.values())
      for (const p of [...w.state.prs, ...w.state.others])
        if (p.repo === repo && p.number === number) return p
    return undefined
  }

  #broadcastInbox(key: string) {
    this.#broadcast("inbox", JSON.stringify({ key, comments: this.#inbox.get(key) ?? [] }))
  }

  /** A comment from skepsis's Send on a PR (`ah dashboard review-comment`),
   * into the PR's inbox */
  async #takeComment(req: Request): Promise<Response> {
    const {
      repo,
      number,
      payload,
    }: { repo?: unknown; number?: unknown; payload?: unknown } = await req.json()
    const pr = this.#anyListedPr(repo, number)
    if (!pr) return new Response("not a PR the dashboard lists", { status: 404 })
    const comment = typeof payload === "string" ? parseSkepsisComment(payload) : null
    if (!comment) return new Response("not a skepsis comment", { status: 400 })
    const key = `${pr.repo}#${pr.number}`
    const comments = this.#inbox.get(key) ?? []
    comments.push({ ...comment, id: String(++this.#inboxIds), to: null })
    this.#inbox.set(key, comments)
    this.#broadcastInbox(key)
    return Response.json({ status: "in the PR's review inbox" })
  }

  /** Mark an inbox comment for GitHub (or not), send it to the tab's agent,
   * or discard it */
  async #inboxAction(req: Request): Promise<Response> {
    const body: {
      tab?: unknown
      repo?: unknown
      number?: unknown
      id?: unknown
      action?: unknown
    } = await req.json()
    const pr = this.#anyListedPr(body.repo, body.number)
    const key = pr ? `${pr.repo}#${pr.number}` : ""
    const comments = this.#inbox.get(key) ?? []
    const comment = comments.find((c) => c.id === body.id)
    if (!pr || !comment) return new Response("no such comment", { status: 404 })
    let status: string | null = null
    if (body.action === "github") comment.to = "github"
    else if (body.action === "unmark") comment.to = null
    else if (body.action === "discard")
      this.#inbox.set(
        key,
        comments.filter((c) => c !== comment),
      )
    else if (body.action === "agent") {
      const tab = this.#state.tabs.find((t) => t.id === body.tab)
      const pane = tab && this.#paneOf(tab)
      if (!pane) return new Response("no pane in the tab", { status: 404 })
      status = await this.options.core.send(
        pane.block,
        `On ${pr.repo}#${pr.number} (${pr.title}), from my review in skepsis:\n\n${comment.prompt}`,
      )
      comment.to = "agent"
    } else return new Response("not an inbox action", { status: 400 })
    this.#broadcastInbox(key)
    return Response.json({ status })
  }

  /** Post the comments marked for GitHub as one review on the PR, with its
   * verdict and summary. The only thing that writes to GitHub, on the
   * user's click. */
  async #submitReview(req: Request): Promise<Response> {
    const body: {
      tab?: unknown
      repo?: unknown
      number?: unknown
      event?: unknown
      text?: unknown
    } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === body.tab)
    const pr = this.#anyListedPr(body.repo, body.number)
    if (!tab || !pr) return new Response("not a PR the dashboard lists", { status: 404 })
    const events: ReviewEvent[] = ["COMMENT", "APPROVE", "REQUEST_CHANGES"]
    const event = events.find((e) => e === body.event)
    if (!event) return new Response("not a review verdict", { status: 400 })
    const key = `${pr.repo}#${pr.number}`
    const comments = this.#inbox.get(key) ?? []
    const request = reviewRequest(
      comments,
      event,
      typeof body.text === "string" ? body.text : "",
    )
    if (event !== "APPROVE" && !request.body && !request.comments.length)
      return new Response("nothing to post: no comments for GitHub and no summary", {
        status: 400,
      })
    const dir = await mkdtemp(join(tmpdir(), "ah-review-"))
    try {
      const file = join(dir, "review.json")
      await writeFile(file, JSON.stringify(request))
      const o = await run(
        "gh",
        [
          "api",
          "-X",
          "POST",
          `repos/${pr.repo}/pulls/${pr.number}/reviews`,
          "--input",
          file,
        ],
        { cwd: tab.root },
      )
      if (!o.success)
        return new Response(o.stderr.trim() || "GitHub refused the review", { status: 502 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    this.#inbox.set(
      key,
      comments.filter((c) => c.to !== "github"),
    )
    this.#broadcastInbox(key)
    void this.#prs.get(tab.root)?.refresh()
    return new Response(null, { status: 204 })
  }

  /** Someone else's PR the tab lists, and its review plan (review.ts) */
  async #reviewable(req: Request) {
    const body: { tab?: unknown; repo?: unknown; number?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === body.tab)
    const watcher = tab && this.#prs.get(tab.root)
    const pr = watcher?.state.others.find(
      (p) => p.repo === body.repo && p.number === body.number,
    )
    if (!tab || !watcher || !pr) return null
    const remotes = await run("jj", ["git", "remote", "list"], { cwd: tab.root })
    const plan = planReview(pr, remotes.stdout, ahStateDir("reviews"))
    return plan && { tab, watcher, pr, plan }
  }

  /** Bring the PR into a workspace of its own and open it in skepsis */
  async #reviewPr(req: Request): Promise<Response> {
    const r = await this.#reviewable(req)
    if (!r) return new Response("not a PR to review in the tab's list", { status: 404 })
    const pane = this.#paneOf(r.tab)
    if (!pane) return new Response("no pane in the tab", { status: 404 })
    await mkdir(ahStateDir("reviews"), { recursive: true })
    const error = await bringIn(r.plan, r.tab.root)
    r.watcher.setReviews(await reviewWorkspaces(r.tab.root))
    if (error) return new Response(error, { status: 502 })
    const launch = skepsisDiffLaunch(
      r.plan.from,
      r.plan.to,
      r.plan.dir,
      pane,
      this.options.port,
      AH,
      SKEPSIS,
      { repo: r.pr.repo, number: r.pr.number },
    )
    return await this.#runSkepsis(r.plan.name, launch)
  }

  /** Ask the tab's agent to review the PR, in its workspace */
  async #askReview(req: Request): Promise<Response> {
    const r = await this.#reviewable(req)
    if (!r) return new Response("not a PR to review in the tab's list", { status: 404 })
    const pane = this.#paneOf(r.tab)
    if (!pane) return new Response("no pane in the tab", { status: 404 })
    await mkdir(ahStateDir("reviews"), { recursive: true })
    const error = await bringIn(r.plan, r.tab.root)
    r.watcher.setReviews(await reviewWorkspaces(r.tab.root))
    if (error) return new Response(error, { status: 502 })
    const status = await this.options.core.send(pane.block, reviewMessage(r.pr, r.plan))
    return Response.json({ status })
  }

  /** Take a review away: its skepsis, workspace, commits, bookmark and
   * directory (review_run.ts cleanUp). By the workspace's name, so one whose
   * PR has closed can go too. */
  async #doneReviewing(req: Request): Promise<Response> {
    const { tab: id, name }: { tab?: unknown; name?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const names = await reviewWorkspaces(tab.root)
    if (typeof name !== "string" || !names.includes(name))
      return new Response("not a review workspace here", { status: 404 })
    const reviewId = name.slice("review-".length)
    this.#stopSkepsis(name)
    const error = await cleanUp(
      name,
      `ah-review/${reviewId}`,
      `${ahStateDir("reviews")}/${reviewId}`,
      tab.root,
      ahStateDir("reviews"),
    )
    this.#prs.get(tab.root)?.setReviews(await reviewWorkspaces(tab.root))
    if (error) return new Response(error, { status: 502 })
    return new Response(null, { status: 204 })
  }

  /** A jj operation changed the workspace's log; a push refreshes its PRs */
  async #operationLanded(root: string) {
    const prs = this.#prs.get(root)
    if (!prs) return
    const { stdout } = await run(
      "jj",
      ["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "description"],
      { cwd: root },
    ).catch(() => ({ stdout: "" }))
    await prs.onOperation(stdout)
  }

  /** A pane in the tab to act as, for what the server does on its behalf */
  #paneOf(tab: DashTab): Pane | null {
    const rexTab = this.#rexTab(tab)
    return (rexTab && paneIn(tab.session, rexTab)) ?? null
  }

  /** The tab as Rex last told of it, with its panes */
  #rexTab(tab: DashTab) {
    return this.#rex?.sessions
      .find((s) => s.id === tab.session)
      ?.tabs.find((t) => t.id === tab.id)
  }

  /** The new-tracker button: the goal goes to the tab's agent (new_tracker.ts) */
  async #newTracker(req: Request): Promise<Response> {
    const { tab: id, goal }: { tab?: unknown; goal?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const result = await forwardGoal(
      (block, text) => this.options.core.send(block, text),
      this.#paneOf(tab),
      goal,
    )
    if (!result.ok) return new Response(result.error, { status: result.status })
    return Response.json({ status: result.status })
  }

  /** The page opened a tab's Tests tab, which starts listing its
   * workspace's tests, or clicked Run */
  async #testsRequest(req: Request): Promise<Response> {
    const { tab: id, run }: { tab?: unknown; run?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const tests = this.#testsFor(tab.root)
    if (run === true) tests.run(null)
    return new Response(null, { status: 204 })
  }

  #testsFor(root: string): TestsWatcher {
    let tests = this.#tests.get(root)
    if (tests) return tests
    this.#nextest ??= run("cargo", ["nextest", "--version"]).then(
      (o) => o.success,
      () => false,
    )
    const nextest = this.#nextest
    // By its real path, as the snapshot watcher reports changes
    let real = root
    try {
      real = realpathSync(root)
    } catch {
      /* gone; detection finds nothing */
    }
    tests = new TestsWatcher(root, {
      detect: async () => detectRunners(real, { nextest: await nextest }),
      list: listTests,
      run: runTests,
      onChange: (state) => this.#broadcast("tests", JSON.stringify(state)),
    })
    this.#tests.set(root, tests)
    return tests
  }

  /** A jj operation the page asked for, in the tab's workspace (ops.ts).
   * The log watcher sees it land and refreshes the log. The page gets the
   * operation's ID for Undo, or jj's message for the toast. */
  async #jjOp(req: Request): Promise<Response> {
    const { tab: id, ...body }: { tab?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const op = resolveOp(body)
    if (!op.ok) return new Response(op.error, { status: op.status })
    const result = await runOp(tab.root, op.args)
    if (!result.ok) return new Response(result.error, { status: 502 })
    // `remote`: it reached the remote, which Undo can't take back.
    // `message`: why nothing changed, when nothing did.
    return Response.json({
      operation: result.operation,
      remote: op.remote ?? false,
      message: result.operation === null ? result.message : null,
    })
  }

  /** A change's description, to fill the describe dialog with (ops.ts) */
  async #jjDescription(req: Request): Promise<Response> {
    const { tab: id, rev }: { tab?: unknown; rev?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    if (typeof rev !== "string") return new Response("not a change ID", { status: 400 })
    const result = await readDescription(tab.root, rev)
    if (!result.ok) return new Response(result.error, { status: result.status })
    return Response.json({ description: result.description })
  }

  /** Open a file or change from a link in a tab's jj log, for a click on it */
  async #openLink(req: Request): Promise<Response> {
    const { tab: id, ...link }: { tab?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const result = await resolveLink(tab.root, link)
    if (!result.ok) return new Response(result.error, { status: result.status })
    const pane = this.#paneOf(tab)
    if (!pane) return new Response("no pane in the tab", { status: 404 })
    const { target } = result
    if (target.open === "doc")
      return await this.#launch(
        docLaunch(target.path, tab.root, pane, this.options.port, AH),
      )
    if (target.open === "nvim" && target.in === "tab")
      return await this.#openInTab(target.path, tab, pane, target.line)
    if (target.open === "nvim" && target.in === "float")
      return await this.#openNvim(target.path, tab, pane, target.line)
    if (target.open === "nvim") return await this.#nvimSplit(target.path)
    if (target.open === "emacs") return await this.#openEmacs(target.path, target.line)
    return await this.#openSkepsis(target.rev, tab, pane)
  }

  /** skepsis on the change, replacing the tab's last one and its window. It
   * prints one line once it's listening, by when it has opened its page. */
  async #openSkepsis(rev: string, tab: DashTab, pane: Pane): Promise<Response> {
    const launch = skepsisLaunch(rev, tab.root, pane, this.options.port, AH, SKEPSIS)
    return await this.#runSkepsis(tab.id, launch)
  }

  /** Start skepsis for `key` (a tab, or a review), replacing that key's last
   * one and its window. It prints one line once it's listening, by when it
   * has opened its page. */
  async #runSkepsis(key: string, { cmd, args, cwd, env }: Launch): Promise<Response> {
    this.#stopSkepsis(key)
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const entry: { child: ChildProcess; url: string | null } = { child, url: null }
    this.#skepsis.set(key, entry)
    child.on("exit", () => {
      if (this.#skepsis.get(key) === entry) this.#skepsis.delete(key)
    })
    child.stderr.on("data", (d) => process.stderr.write(`skepsis: ${d}`))
    const started = await new Promise<string | null>((resolve) => {
      let out = ""
      child.stdout.on("data", (d) => {
        out += d
        const line = /^skepsis on (\S+).*$/m.exec(out)
        if (!line) return
        entry.url = line[1]
        resolve(line[0])
      })
      child.on("exit", () => resolve(null))
      child.on("error", () => resolve(null))
      setTimeout(() => resolve(null), SKEPSIS_START_MS).unref()
    })
    if (!started) {
      child.kill()
      return new Response("skepsis didn't start", { status: 502 })
    }
    console.error(`ah: ${started}`)
    return new Response(null, { status: 204 })
  }

  #stopSkepsis(key: string) {
    const last = this.#skepsis.get(key)
    last?.child.kill()
    if (last?.url) closeWindows(last.url)
    this.#skepsis.delete(key)
  }

  /** Where the page's split under the log connects for nvim on the file:
   * the doc editor's pane socket, which runs it with ah's setup (saving soon
   * after typing stops, merging the agent's edits; neovim_command.ts) */
  async #nvimSplit(path: string): Promise<Response> {
    const info = await this.options.markdown.show(path)
    if (!info) return new Response("no such file", { status: 404 })
    // The editor socket alone doesn't hold the file open; a page's doc
    // socket does, so the split opens one too
    return Response.json({
      editor: `${info.url}editor`,
      doc: `${info.url}doc?in=dashboard`,
    })
  }

  /** The file in the running Emacs, brought forward (emacsCommands) */
  async #openEmacs(path: string, line?: number): Promise<Response> {
    const [open, focus] = emacsCommands(path, line)
    const o = await run("emacsclient", open).catch((e: Error) => ({
      success: false,
      stderr: e.message,
      code: null,
    }))
    if (!o.success)
      return new Response(o.stderr.trim() || "couldn't reach Emacs", { status: 502 })
    // It's open either way; this only brings it to the front
    await run("emacsclient", focus).catch(() => {})
    return new Response(null, { status: 204 })
  }

  /** The file in the tab's nvim (Core.edit, as `ah edit` does), with that
   * tab brought forward and that pane focused. A float when the tab has
   * none, or it can't be reached, which ah then forgets. */
  async #openInTab(
    path: string,
    tab: DashTab,
    pane: Pane,
    line?: number,
  ): Promise<Response> {
    if (await this.options.core.edit(pane.block, [path], line ?? null, true))
      return new Response(null, { status: 204 })
    return await this.#openNvim(path, tab, pane, line)
  }

  /** nvim in a float over the tab, which Rex then shows: the click was to
   * edit the file */
  async #openNvim(
    path: string,
    tab: DashTab,
    pane: Pane,
    line?: number,
  ): Promise<Response> {
    try {
      await openFloat(pane.session, pane.block, {
        ...nvimFloat(path, tab.root, line),
        focus: true,
      })
    } catch (e) {
      console.error("ah:", e)
      return new Response("couldn't open nvim in the tab", { status: 502 })
    }
    // The float is open either way; this only brings its tab to the front
    await selectTab(tab.session, tab.id).catch((e) => console.error("ah:", e))
    return new Response(null, { status: 204 })
  }

  /** Run an opener to completion; its error goes to the page and the log */
  async #launch({ cmd, args, cwd, env }: Launch): Promise<Response> {
    const { success, stderr } = await run(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
    })
    if (success) return new Response(null, { status: 204 })
    console.error(`ah: ${args.join(" ")} failed:`, stderr)
    return new Response(stderr.trim() || "couldn't open it", { status: 502 })
  }

  /** Show a tab in Rex, for a click on its chip, leaving focus on the dashboard */
  async #focus(req: Request): Promise<Response> {
    const { tab: id }: { tab?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    try {
      await selectTab(tab.session, tab.id)
    } catch (e) {
      console.error("ah:", e)
      return new Response("couldn't focus the tab", { status: 502 })
    }
    // Rex in the background may not report the switch until it's in front,
    // so the dashboard follows the click itself
    this.#setState({ ...this.#state, focused: tab.id })
    return new Response(null, { status: 204 })
  }

  /** Switch a tab's workspace to another of its trackers, active or parked */
  async #pickTracker(req: Request): Promise<Response> {
    const { tab: id, path }: { tab?: unknown; path?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const trackers = this.options.core.trackers
    const { active, parked } = trackers.get(tab.root)
    if (!paths([...active, ...parked]).includes(path as string))
      return new Response("not a tracker there", { status: 400 })
    trackers.add(tab.root, path as string)
    return new Response(null, { status: 204 })
  }

  #events(): Response {
    let controller: Client
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
        this.#clients.add(c)
        this.presence.update(this.#clients.size)
        // Reconnect soon after a restart, so the page is back before a command
        // looks for one to show something in (EventSource waits seconds by
        // default)
        c.enqueue(encoder.encode("retry: 500\n\n"))
        send(c, "hello", JSON.stringify({ version: SERVER_VERSION }))
        send(c, "state", this.#stateJson)
        send(c, "health", this.#healthJson)
        for (const [root, watcher] of this.#logs) {
          if (watcher.html !== null) send(c, "jj", logEvent(root, watcher.html))
        }
        for (const json of this.#trackers.values()) send(c, "trackers", json)
        for (const tests of this.#tests.values())
          send(c, "tests", JSON.stringify(tests.state))
        for (const prs of this.#prs.values()) send(c, "prs", JSON.stringify(prs.state))
        if (this.#jira) send(c, "jira", JSON.stringify(this.#jira.state))
        for (const [key, comments] of this.#inbox)
          send(c, "inbox", JSON.stringify({ key, comments }))
        for (const [tab, doc] of this.#shown) send(c, "doc", docEvent(tab, doc))
      },
      cancel: () => {
        this.#clients.delete(controller)
        this.presence.update(this.#clients.size)
      },
    })
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }
}
