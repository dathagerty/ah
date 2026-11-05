// A workspace's tests as the Tests tab shows them: each runner's tests as a
// tree, from listing them (before any run) and from running them. Shared by
// the runners' parsers (vitest.ts, go.ts, nextest.ts, cargo.ts), the watcher
// that runs them, and the page.

import type { RunnerKind } from "./detect.ts"

export type TestStatus = "passed" | "failed" | "skipped"

/** A test as a runner lists or reports it */
export interface TestCase {
  /** Unique within its runner, and the same from a listing and a run */
  id: string
  /** Its place in the tree: groups from the outside in (file or package,
   * then suites or modules), then the test's own name */
  path: string[]
  /** Where it's defined, when the runner says */
  file?: string
  line?: number
}

/** How a test came out of a run */
export interface TestResult extends TestCase {
  status: TestStatus
  /** What it printed, or its failure messages */
  output: string
  /** Where it failed, when its output says, for opening there */
  failure?: { file: string; line: number }
}

/** One runner's tests, as the watcher sends them to the page */
export interface RunnerTests {
  kind: RunnerKind
  dir: string
  tests: TestCase[]
  /** Results of the latest run, by test id; a run of only some tests
   * replaces only theirs */
  results: Record<string, TestResult>
  /** Why it couldn't list or run, in the runner's own words */
  error: string | null
}
