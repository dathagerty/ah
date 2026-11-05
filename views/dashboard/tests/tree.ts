// A runner's tests as the Tests tab's tree: its listed tests and the latest
// results, merged by id and nested by path, with counts rolled up. A node
// can be a test and a group at once: a Go test with subtests, or a vitest
// file that failed before its tests ran. No Node imports: the page uses it.

import type { RunnerTests, TestCase, TestResult } from "./model.ts"

export type NodeStatus = TestResult["status"] | "not run"

export interface Counts {
  passed: number
  failed: number
  skipped: number
  notRun: number
}

export interface TreeNode {
  /** Unique in the runner's tree, for keeping a node open across updates */
  key: string
  name: string
  children: TreeNode[]
  /** Set when the node is a test */
  test?: TestCase
  result?: TestResult
  status: NodeStatus
  /** Of the tests at and under it */
  counts: Counts
}

const zero = (): Counts => ({ passed: 0, failed: 0, skipped: 0, notRun: 0 })

const COUNT: Record<NodeStatus, keyof Counts> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  "not run": "notRun",
}

function add(into: Counts, from: Counts) {
  into.passed += from.passed
  into.failed += from.failed
  into.skipped += from.skipped
  into.notRun += from.notRun
}

/** The runner's top-level nodes */
export function buildTree(runner: RunnerTests): TreeNode[] {
  const root: TreeNode = {
    key: "",
    name: "",
    children: [],
    status: "not run",
    counts: zero(),
  }
  const byKey = new Map<string, TreeNode>([["", root]])
  const nodeAt = (path: string[]): TreeNode => {
    let node = root
    for (let i = 0; i < path.length; i++) {
      const key = path.slice(0, i + 1).join("\u0000")
      let child = byKey.get(key)
      if (!child) {
        child = { key, name: path[i], children: [], status: "not run", counts: zero() }
        byKey.set(key, child)
        node.children.push(child)
      }
      node = child
    }
    return node
  }
  const listed = new Set<string>()
  for (const test of runner.tests) {
    listed.add(test.id)
    const node = nodeAt(test.path)
    node.test = test
    const result = runner.results[test.id]
    if (result) {
      node.result = result
      node.status = result.status
    }
  }
  for (const result of Object.values(runner.results)) {
    if (listed.has(result.id)) continue
    const node = nodeAt(result.path)
    node.test = result
    node.result = result
    node.status = result.status
  }
  const roll = (node: TreeNode): Counts => {
    node.counts = zero()
    if (node.test) node.counts[COUNT[node.status]]++
    for (const child of node.children) add(node.counts, roll(child))
    return node.counts
  }
  roll(root)
  return root.children
}

/** Every runner's tests, counted */
export function totals(runners: RunnerTests[]): Counts {
  const all = zero()
  for (const runner of runners) for (const node of buildTree(runner)) add(all, node.counts)
  return all
}
