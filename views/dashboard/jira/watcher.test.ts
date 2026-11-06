import { expect, test } from "vitest"
import { JiraWatcher } from "./watcher.ts"

const listed = (key: string) => ({
  key,
  fields: { summary: key, status: { name: "ToDo", statusCategory: { key: "new" } } },
})

function setup(search: () => Promise<string>) {
  const timers: { ms: number; cancelled: boolean }[] = []
  const watcher = new JiraWatcher("EDGE", {
    search,
    site: async () => "cfacorp.atlassian.net",
    onChange: () => {},
    schedule: (_run, ms) => {
      const t = { ms, cancelled: false }
      timers.push(t)
      return () => (t.cancelled = true)
    },
  })
  return { watcher, timers }
}

test("it fetches the sprint's tickets, and polls every five minutes", async () => {
  const { watcher, timers } = setup(async () =>
    JSON.stringify([listed("EDGE-1"), listed("EDGE-2")]),
  )
  await watcher.refresh()
  expect(watcher.state.issues.map((i) => i.key)).toEqual(["EDGE-1", "EDGE-2"])
  expect(watcher.state.issues[0].url).toBe("https://cfacorp.atlassian.net/browse/EDGE-1")
  expect([watcher.state.loading, watcher.state.error, watcher.state.project]).toEqual([
    false,
    null,
    "EDGE",
  ])
  expect(timers.at(-1)?.ms).toBe(300_000)
})

test("a failed fetch keeps the last tickets and says why", async () => {
  let fail = false
  const { watcher } = setup(async () => {
    if (fail) throw new Error("acli: not authenticated")
    return JSON.stringify([listed("EDGE-1")])
  })
  await watcher.refresh()
  fail = true
  await watcher.refresh()
  expect(watcher.state.issues.map((i) => i.key)).toEqual(["EDGE-1"])
  expect(watcher.state.error).toBe("acli: not authenticated")
})

test("closing it stops the polling", async () => {
  const { watcher, timers } = setup(async () => "[]")
  await watcher.refresh()
  watcher.close()
  expect(timers.every((t) => t.cancelled)).toBe(true)
})
