// One workspace's tests for the dashboard's Tests tab: its runners
// (detect.ts), their tests listed (run.ts), and the latest results. Run
// runs everything; a change (from the snapshot watcher, jj.ts) relists and
// runs only the runners whose files it touched, and only what the change
// touches in them. One run at a time: a new one cancels the one in flight,
// whose results are dropped.

import { sep } from "node:path"
import type { Runner } from "./detect.ts"
import type { RunnerTests } from "./model.ts"
import type { Cwds, Listing, RunOutcome } from "./run.ts"

export interface TestsState {
  root: string
  /** Finding and listing the runners, at the start */
  listing: boolean
  running: boolean
  runners: RunnerTests[]
}

export interface TestsDeps {
  detect: () => Promise<Runner[]>
  list: (runner: Runner, signal?: AbortSignal) => Promise<Listing>
  run: (
    runner: Runner,
    changed: string[] | null,
    cwds: Cwds,
    signal?: AbortSignal,
  ) => Promise<RunOutcome | null>
  onChange: (state: TestsState) => void
}

const inside = (file: string, dir: string) => file.startsWith(dir + sep)

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class TestsWatcher {
  readonly #deps: TestsDeps
  readonly #state: TestsState
  readonly #started: Promise<void>
  /** Each runner's binary directories, from its latest listing */
  #cwds = new Map<RunnerTests, Cwds>()
  #current: AbortController | null = null
  #work: Promise<void>

  constructor(root: string, deps: TestsDeps) {
    this.#deps = deps
    this.#state = { root, listing: true, running: false, runners: [] }
    this.#started = this.#start()
    this.#work = this.#started
  }

  get state(): TestsState {
    return this.#state
  }

  /** Settles once nothing is listing or running */
  async idle() {
    let work
    do {
      work = this.#work
      await work.catch(() => {})
    } while (work !== this.#work)
  }

  #emit() {
    this.#deps.onChange(this.#state)
  }

  async #start() {
    let runners: Runner[]
    try {
      runners = await this.#deps.detect()
    } catch (e) {
      console.error("ah: couldn't find test runners:", e)
      runners = []
    }
    this.#state.runners = runners.map((r) => ({
      ...r,
      tests: [],
      results: {},
      error: null,
    }))
    await Promise.all(this.#state.runners.map((r) => this.#list(r)))
    this.#state.listing = false
    this.#emit()
  }

  async #list(r: RunnerTests, signal?: AbortSignal) {
    try {
      const { tests, error, cwds } = await this.#deps.list(r, signal)
      if (signal?.aborted) return
      r.tests = tests
      r.error = error
      this.#cwds.set(r, cwds)
    } catch (e) {
      if (!signal?.aborted) r.error = message(e)
    }
  }

  /** Run everything for `changed` null, or what the changed files touch */
  run(changed: string[] | null) {
    this.#current?.abort()
    const ctl = new AbortController()
    this.#current = ctl
    this.#state.running = true
    this.#emit()
    this.#work = this.#run(changed, ctl)
  }

  async #run(changed: string[] | null, ctl: AbortController) {
    await this.#started
    const { signal } = ctl
    const touched = (r: RunnerTests) => changed?.filter((f) => inside(f, r.dir)) ?? null
    const targets = this.#state.runners.filter((r) => !changed || touched(r)?.length)
    // A change may have added or removed tests
    if (changed) await Promise.all(targets.map((r) => this.#list(r, signal)))
    const outcomes = await Promise.all(
      targets.map((r) =>
        this.#deps
          .run(r, touched(r), this.#cwds.get(r) ?? {}, signal)
          .catch((e): RunOutcome => ({ results: [], error: message(e) })),
      ),
    )
    if (signal.aborted) return
    targets.forEach((r, i) => {
      const outcome = outcomes[i]
      if (!outcome) return
      const got = Object.fromEntries(outcome.results.map((res) => [res.id, res]))
      r.results = changed ? { ...r.results, ...got } : got
      r.error = outcome.error
    })
    this.#state.running = false
    this.#current = null
    this.#emit()
  }

  /** Stop what's running, for a workspace that closed */
  close() {
    this.#current?.abort()
  }
}
