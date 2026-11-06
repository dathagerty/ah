import { expect, test } from "vitest"
import { type PrsDeps, PrsWatcher } from "./watcher.ts"

const listed = (
  number: number,
  branch: string,
  owner = "dathagerty",
  checks: unknown[] = [],
) => ({
  number,
  title: `PR ${number}`,
  state: "OPEN",
  isDraft: false,
  reviewDecision: "",
  headRefName: branch,
  headRepositoryOwner: { login: owner },
  url: `https://github.com/x/pull/${number}`,
  updatedAt: "",
  statusCheckRollup: checks,
})

function setup(over: Partial<PrsDeps> = {}) {
  const timers: { ms: number; cancelled: boolean; run: () => void }[] = []
  const calls: string[] = []
  const watcher = new PrsWatcher("/ws", {
    repos: async () => ["dathagerty/ah", "david-crespo/ah"],
    branches: async () => ["feature", "main"],
    list: async (repo) => {
      calls.push(repo)
      return JSON.stringify(
        repo === "david-crespo/ah"
          ? [listed(1, "feature"), listed(2, "main", "stranger")]
          : [listed(3, "main")],
      )
    },
    onChange: () => {},
    schedule: (run, ms) => {
      const t = { ms, cancelled: false, run }
      timers.push(t)
      return () => (t.cancelled = true)
    },
    ...over,
  })
  return { watcher, timers, calls }
}

test("it gathers the stack's PRs from every GitHub remote", async () => {
  const { watcher } = setup()
  await watcher.refresh()
  expect(watcher.state.prs.map((p) => [p.repo, p.number])).toEqual([
    ["dathagerty/ah", 3],
    ["david-crespo/ah", 1],
  ])
  expect(watcher.state.error).toBeNull()
  expect(watcher.state.loading).toBe(false)
})

test("when gh fails, the last PRs stay and the error says why", async () => {
  let fail = false
  const { watcher } = setup({
    list: async () => {
      if (fail) throw new Error("gh: authentication required")
      return JSON.stringify([listed(1, "feature")])
    },
  })
  await watcher.refresh()
  fail = true
  await watcher.refresh()
  expect(watcher.state.prs.map((p) => p.number)).toEqual([1, 1])
  expect(watcher.state.error).toBe("gh: authentication required")
})

test("the next refresh is scheduled by how settled the checks are", async () => {
  const running = [
    { __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: null },
  ]
  const { watcher, timers } = setup({
    list: async () => JSON.stringify([listed(1, "feature", "dathagerty", running)]),
  })
  await watcher.refresh()
  expect(timers.at(-1)?.ms).toBe(45_000)
  // A new refresh replaces the scheduled one
  await watcher.refresh()
  expect(timers.filter((t) => !t.cancelled)).toHaveLength(1)
})

test("a push refreshes; other operations don't", async () => {
  const { watcher, calls } = setup()
  await watcher.refresh()
  calls.length = 0
  await watcher.onOperation("snapshot working copy")
  expect(calls).toEqual([])
  await watcher.onOperation("push bookmark main to git remote origin")
  expect(calls).toEqual(["dathagerty/ah", "david-crespo/ah"])
})

test("others' open PRs come along, for review", async () => {
  const { watcher } = setup()
  await watcher.refresh()
  // #2 is someone else's fork's main: not ours, so it's one to review
  expect(watcher.state.others.map((p) => [p.repo, p.number])).toEqual([
    ["david-crespo/ah", 2],
  ])
})

test("closing it stops the polling", async () => {
  const { watcher, timers } = setup()
  await watcher.refresh()
  watcher.close()
  expect(timers.every((t) => t.cancelled)).toBe(true)
})
