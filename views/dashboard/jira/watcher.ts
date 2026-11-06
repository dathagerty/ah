// A Jira project's current sprint for the dashboard's Issues tab (jira.ts),
// fetched through acli every five minutes and when asked. A failed fetch
// keeps the last tickets and says why, in acli's words: an auth failure is
// shown, not worked around.

import { type Issue, parseIssues } from "./jira.ts"

export interface JiraState {
  project: string
  loading: boolean
  issues: Issue[]
  error: string | null
  checkedAt: number | null
}

export interface JiraDeps {
  /** The sprint's tickets, as `acli jira workitem search --json`; throws with acli's message */
  search: () => Promise<string>
  /** The Jira host, for links to tickets */
  site: () => Promise<string>
  onChange: (state: JiraState) => void
  /** Run `f` in `ms`; returns a cancel */
  schedule?: (f: () => void, ms: number) => () => void
}

const POLL_MS = 300_000

const timeout = (f: () => void, ms: number) => {
  const t = setTimeout(f, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

export class JiraWatcher {
  readonly #deps: JiraDeps
  readonly #state: JiraState
  #cancel: (() => void) | null = null
  #refreshing: Promise<void> | null = null
  #closed = false

  constructor(project: string, deps: JiraDeps) {
    this.#deps = deps
    this.#state = { project, loading: true, issues: [], error: null, checkedAt: null }
  }

  get state(): JiraState {
    return this.#state
  }

  /** Fetch now, and schedule the next poll; one asked for while another
   * runs shares it */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#fetch().finally(() => (this.#refreshing = null))
    return this.#refreshing
  }

  async #fetch() {
    this.#cancel?.()
    try {
      const [json, site] = await Promise.all([this.#deps.search(), this.#deps.site()])
      this.#state.issues = parseIssues(json, site)
      this.#state.error = null
    } catch (e) {
      this.#state.error = e instanceof Error ? e.message : String(e)
    }
    this.#state.loading = false
    this.#state.checkedAt = Date.now()
    if (this.#closed) return
    this.#deps.onChange(this.#state)
    this.#cancel = (this.#deps.schedule ?? timeout)(() => void this.refresh(), POLL_MS)
  }

  close() {
    this.#closed = true
    this.#cancel?.()
  }
}
