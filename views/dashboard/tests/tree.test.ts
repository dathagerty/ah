import { expect, test } from "vitest"
import type { RunnerTests, TestResult } from "./model.ts"
import { buildTree, type TreeNode, totals } from "./tree.ts"

const runner = (over: Partial<RunnerTests>): RunnerTests => ({
  kind: "go",
  dir: "/ws",
  tests: [],
  results: {},
  error: null,
  ...over,
})

const result = (id: string, path: string[], status: TestResult["status"]): TestResult => ({
  id,
  path,
  status,
  output: status === "failed" ? "boom" : "",
})

/** The tree as names and statuses, for comparing */
const shape = (n: TreeNode): unknown => ({
  name: n.name,
  ...(n.test ? { status: n.status } : {}),
  ...(n.children.length ? { children: n.children.map(shape) } : {}),
})

test("listed tests nest by their path, in listing order, none run yet", () => {
  const tree = buildTree(
    runner({
      tests: [
        { id: "a", path: [".", "TestA"] },
        { id: "b", path: ["sub", "TestB"] },
        { id: "c", path: [".", "TestC"] },
      ],
    }),
  )
  expect(tree.map(shape)).toEqual([
    {
      name: ".",
      children: [
        { name: "TestA", status: "not run" },
        { name: "TestC", status: "not run" },
      ],
    },
    { name: "sub", children: [{ name: "TestB", status: "not run" }] },
  ])
})

test("results land on their listed tests, and ones the listing didn't have are added", () => {
  const tree = buildTree(
    runner({
      tests: [{ id: "a", path: [".", "TestA"] }],
      results: {
        a: result("a", [".", "TestA"], "failed"),
        "a/one": result("a/one", [".", "TestA", "one"], "failed"),
        z: result("z", ["new", "TestZ"], "passed"),
      },
    }),
  )
  expect(tree.map(shape)).toEqual([
    {
      name: ".",
      children: [
        { name: "TestA", status: "failed", children: [{ name: "one", status: "failed" }] },
      ],
    },
    { name: "new", children: [{ name: "TestZ", status: "passed" }] },
  ])
  expect(tree[0].children[0].result?.output).toBe("boom")
})

test("counts roll up from the tests under a node", () => {
  const tree = buildTree(
    runner({
      tests: [
        { id: "a", path: ["p", "A"] },
        { id: "b", path: ["p", "B"] },
        { id: "c", path: ["p", "C"] },
        { id: "d", path: ["p", "D"] },
      ],
      results: {
        a: result("a", ["p", "A"], "passed"),
        b: result("b", ["p", "B"], "failed"),
        c: result("c", ["p", "C"], "skipped"),
      },
    }),
  )
  expect(tree[0].counts).toEqual({ passed: 1, failed: 1, skipped: 1, notRun: 1 })
})

test("totals add up every runner's tests", () => {
  const go = runner({
    tests: [{ id: "a", path: ["A"] }],
    results: { a: result("a", ["A"], "failed") },
  })
  const web = runner({
    kind: "vitest",
    tests: [
      { id: "b", path: ["B"] },
      { id: "c", path: ["C"] },
    ],
    results: { b: result("b", ["B"], "passed") },
  })
  expect(totals([go, web])).toEqual({ passed: 1, failed: 1, skipped: 0, notRun: 1 })
})
