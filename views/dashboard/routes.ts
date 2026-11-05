// The dashboard's routes, under /view/dashboard/: the page, and the SSE stream
// it follows. The server follows Rex (platform/rex.ts) and hands each new RexState
// to onRex; the dashboard keeps a live jj log for
// every open workspace (jj.ts), and pushes both to the page (page.html, with
// its script in client.ts), along with each tab's file, its workspace's
// current tracker (core/trackers.ts), which the page shows with markdown's <ah-markdown>
// element, or in a frame for an html file. The focused workspace gets
// snapshotted once edits settle, so @ stays current between jj commands.

import { type ChildProcess, spawn } from "node:child_process"
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
import { resolveLink } from "./links.ts"
import {
  docLaunch,
  type Launch,
  nvimFloat,
  type Pane,
  paneIn,
  skepsisLaunch,
} from "./openers.ts"
import { run } from "../../platform/proc.ts"
import { rootFinder } from "../../core/workspace.ts"
import { type DashTab, focusedRoot, resolve, type State } from "./workspace.ts"

/** How to run ah itself, as the server was run */
const AH = [process.execPath, ...process.execArgv, process.argv[1]]

/** Where the skepsis skill runs it from (skills/skepsis/SKILL.md) */
const SKEPSIS = join(homedir(), "code/utilities/skepsis/cli.ts")

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

  /** Open the file in the backend that shows it. An html page is dark and
   * see-through, to match the dashboard. */
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
    for (const root of open) {
      if (this.#logs.has(root)) continue
      this.#logs.set(
        root,
        new LogWatcher(root, (html) => this.#broadcast("jj", logEvent(root, html))),
      )
    }
    // Only the focused workspace gets snapshotted: it's the one on screen, and
    // watching every file in every open workspace would be wasteful
    const focused = focusedRoot(this.#state)
    if (this.#snapshotter?.root !== focused) {
      this.#snapshotter?.close()
      this.#snapshotter = focused ? new SnapshotWatcher(focused) : null
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
    return new Response("not found", { status: 404 })
  }

  /** Open a file or change from a link in a tab's jj log, for a click on it */
  async #openLink(req: Request): Promise<Response> {
    const { tab: id, ...link }: { tab?: unknown } = await req.json()
    const tab = this.#state.tabs.find((t) => t.id === id)
    if (!tab) return new Response("no such tab", { status: 404 })
    const result = await resolveLink(tab.root, link)
    if (!result.ok) return new Response(result.error, { status: result.status })
    const rexTab = this.#rex?.sessions
      .find((s) => s.id === tab.session)
      ?.tabs.find((t) => t.id === tab.id)
    const pane = rexTab && paneIn(tab.session, rexTab)
    if (!pane) return new Response("no pane in the tab", { status: 404 })
    const { target } = result
    if (target.open === "doc")
      return await this.#launch(
        docLaunch(target.path, tab.root, pane, this.options.port, AH),
      )
    if (target.open === "nvim" && target.float)
      return await this.#openNvim(target.path, tab, pane)
    if (target.open === "nvim") return await this.#nvimSplit(target.path)
    return await this.#openSkepsis(target.rev, tab, pane)
  }

  /** skepsis on the change, replacing the tab's last one and its window. It
   * prints one line once it's listening, by when it has opened its page. */
  async #openSkepsis(rev: string, tab: DashTab, pane: Pane): Promise<Response> {
    const last = this.#skepsis.get(tab.id)
    last?.child.kill()
    if (last?.url) closeWindows(last.url)
    const { cmd, args, cwd, env } = skepsisLaunch(
      rev,
      tab.root,
      pane,
      this.options.port,
      AH,
      SKEPSIS,
    )
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const entry: { child: ChildProcess; url: string | null } = { child, url: null }
    this.#skepsis.set(tab.id, entry)
    child.on("exit", () => {
      if (this.#skepsis.get(tab.id) === entry) this.#skepsis.delete(tab.id)
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

  /** nvim in a float over the tab, which Rex then shows: the click was to
   * edit the file */
  async #openNvim(path: string, tab: DashTab, pane: Pane): Promise<Response> {
    try {
      await openFloat(pane.session, pane.block, {
        ...nvimFloat(path, tab.root),
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
