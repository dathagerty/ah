import { expect, test } from "vitest"
import type { Runner } from "./detect.ts"
import type { TestResult } from "./model.ts"
import type { Listing, RunOutcome } from "./run.ts"
import { type TestsState, TestsWatcher } from "./watcher.ts"

const GO: Runner = { kind: "go", dir: "/ws/go" }
const WEB: Runner = { kind: "vitest", dir: "/ws/web" }

const result = (id: string, status: TestResult["status"] = "passed"): TestResult => ({
  id,
  path: [id],
  status,
  output: "",
})

/** A watcher whose runners answer from `runs`, recording what ran, with each
 * run held until `release` is called for it */
function setup(runners: Runner[]) {
  const states: TestsState[] = []
  const calls: { runner: string; changed: string[] | null; signal?: AbortSignal }[] = []
  const pending: (() => void)[] = []
  const outcomes = new Map<string, TestResult[]>()
  const watcher = new TestsWatcher("/ws", {
    detect: async () => runners,
    list: async (r): Promise<Listing> => ({
      tests: [{ id: `${r.kind}-listed`, path: ["listed"] }],
      error: null,
      cwds: {},
    }),
    run: (r, changed, _cwds, signal): Promise<RunOutcome | null> => {
      calls.push({ runner: r.kind, changed, signal })
      return new Promise((resolve) =>
        pending.push(() => resolve({ results: outcomes.get(r.kind) ?? [], error: null })),
      )
    },
    onChange: (s) => states.push(structuredClone(s)),
  })
  // The runs start a few ticks after run(), so let them queue first
  const releaseAll = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      while (pending.length) pending.shift()!()
    }
    await watcher.idle()
  }
  return { watcher, states, calls, outcomes, releaseAll }
}

test("it starts by listing each runner's tests", async () => {
  const { watcher } = setup([GO, WEB])
  await watcher.idle()
  expect(watcher.state.running).toBe(false)
  expect(watcher.state.runners.map((r) => [r.kind, r.tests.map((t) => t.id)])).toEqual([
    ["go", ["go-listed"]],
    ["vitest", ["vitest-listed"]],
  ])
})

test("Run runs every runner and keeps each one's results", async () => {
  const { watcher, states, calls, outcomes, releaseAll } = setup([GO, WEB])
  await watcher.idle()
  outcomes.set("go", [result("a"), result("b", "failed")])
  outcomes.set("vitest", [result("c")])
  watcher.run(null)
  await Promise.resolve()
  expect(watcher.state.running).toBe(true)
  await releaseAll()
  expect(calls.map((c) => [c.runner, c.changed])).toEqual([
    ["go", null],
    ["vitest", null],
  ])
  expect(watcher.state.running).toBe(false)
  expect(Object.keys(watcher.state.runners[0].results)).toEqual(["a", "b"])
  expect(states.at(-1)?.runners[1].results.c.status).toBe("passed")
})

test("a change runs only the runners it touched, and replaces only the results it got", async () => {
  const { watcher, calls, outcomes, releaseAll } = setup([GO, WEB])
  await watcher.idle()
  outcomes.set("go", [result("a"), result("b")])
  watcher.run(null)
  await releaseAll()
  calls.length = 0
  outcomes.set("go", [result("b", "failed")])
  watcher.run(["/ws/go/b_test.go", "/ws/README.md"])
  await releaseAll()
  expect(calls.map((c) => [c.runner, c.changed])).toEqual([["go", ["/ws/go/b_test.go"]]])
  const go = watcher.state.runners[0].results
  expect([go.a.status, go.b.status]).toEqual(["passed", "failed"])
})

test("a change that touches no runner runs nothing", async () => {
  const { watcher, calls } = setup([GO, WEB])
  await watcher.idle()
  watcher.run(["/ws/README.md"])
  await watcher.idle()
  expect(calls).toEqual([])
  expect(watcher.state.running).toBe(false)
})

test("a full run drops results its runner no longer reports", async () => {
  const { watcher, outcomes, releaseAll } = setup([GO])
  await watcher.idle()
  outcomes.set("go", [result("a"), result("gone")])
  watcher.run(null)
  await releaseAll()
  outcomes.set("go", [result("a")])
  watcher.run(null)
  await releaseAll()
  expect(Object.keys(watcher.state.runners[0].results)).toEqual(["a"])
})

test("a new run cancels the one in flight, whose results are dropped", async () => {
  const { watcher, calls, outcomes, releaseAll } = setup([GO])
  await watcher.idle()
  outcomes.set("go", [result("old")])
  watcher.run(null)
  await Promise.resolve()
  const first = calls[0].signal
  outcomes.set("go", [result("new")])
  watcher.run(null)
  expect(first?.aborted).toBe(true)
  await releaseAll()
  expect(Object.keys(watcher.state.runners[0].results)).toEqual(["new"])
})

test("a runner that can't list says why, and the others still list", async () => {
  const states: TestsState[] = []
  const watcher = new TestsWatcher("/ws", {
    detect: async () => [GO, WEB],
    list: async (r) =>
      r.kind === "go"
        ? { tests: [], error: "go: no Go files", cwds: {} }
        : { tests: [{ id: "x", path: ["x"] }], error: null, cwds: {} },
    run: async () => null,
    onChange: (s) => states.push(s),
  })
  await watcher.idle()
  expect(watcher.state.runners.map((r) => [r.kind, r.error, r.tests.length])).toEqual([
    ["go", "go: no Go files", 0],
    ["vitest", null, 1],
  ])
})
