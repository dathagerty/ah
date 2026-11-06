// One workspace's PRs for the dashboard's PRs tab (github.ts): fetched from
// each GitHub remote for the workspace's bookmarks, again on a poll that's
// quick while checks run and slow once they've settled (pollDelay), when
// asked, and after a jj push. A failed fetch keeps the last PRs and says
// why, in gh's words: an auth failure is shown, not worked around.

import { parsePrs, pollDelay, type Pr } from "./github.ts"

export interface PrsState {
  root: string
  loading: boolean
  prs: Pr[]
  error: string | null
  /** When the PRs were last fetched, in ms since the epoch */
  checkedAt: number | null
}

export interface PrsDeps {
  /** owner/name of each GitHub remote */
  repos: () => Promise<string[]>
  /** The workspace's bookmarks a PR can come from */
  branches: () => Promise<string[]>
  /** `gh pr list --json …` for the repo; throws with gh's message */
  list: (repo: string) => Promise<string>
  onChange: (state: PrsState) => void
  /** Run `f` in `ms`; returns a cancel */
  schedule?: (f: () => void, ms: number) => () => void
}

const timeout = (f: () => void, ms: number) => {
  const t = setTimeout(f, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** `gh pr list` fields the tab needs */
export const PR_FIELDS = [
  "number",
  "title",
  "state",
  "isDraft",
  "reviewDecision",
  "headRefName",
  "headRepositoryOwner",
  "url",
  "updatedAt",
  "statusCheckRollup",
].join(",")

export class PrsWatcher {
  readonly #deps: PrsDeps
  readonly #state: PrsState
  #cancel: (() => void) | null = null
  #refreshing: Promise<void> | null = null
  #closed = false

  constructor(root: string, deps: PrsDeps) {
    this.#deps = deps
    this.#state = { root, loading: true, prs: [], error: null, checkedAt: null }
  }

  get state(): PrsState {
    return this.#state
  }

  /** Fetch now, and schedule the next poll. A refresh asked for while one
   * runs shares it. */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#fetch().finally(() => (this.#refreshing = null))
    return this.#refreshing
  }

  async #fetch() {
    this.#cancel?.()
    try {
      const [repos, branches] = await Promise.all([
        this.#deps.repos(),
        this.#deps.branches(),
      ])
      const owners = new Set(repos.map((r) => r.split("/")[0]))
      const wanted = new Set(branches)
      const lists = await Promise.all(repos.map((repo) => this.#deps.list(repo)))
      this.#state.prs = lists.flatMap((json, i) => parsePrs(json, repos[i], wanted, owners))
      this.#state.error = null
    } catch (e) {
      this.#state.error = message(e)
    }
    this.#state.loading = false
    this.#state.checkedAt = Date.now()
    if (this.#closed) return
    this.#deps.onChange(this.#state)
    const schedule = this.#deps.schedule ?? timeout
    this.#cancel = schedule(() => void this.refresh(), pollDelay(this.#state.prs))
  }

  /** A jj operation landed: a push changes what the PRs show */
  async onOperation(description: string) {
    if (/\bpush\b/.test(description)) await this.refresh()
  }

  close() {
    this.#closed = true
    this.#cancel?.()
  }
}
