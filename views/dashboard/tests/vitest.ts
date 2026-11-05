// vitest, for the Tests tab: listing with `vitest list --json=<file>`,
// running with the JSON reporter into a file, and `vitest related` for the
// tests a change touches. Both write to files ah passes; left to itself,
// vitest writes its JSON into the project. Tests sit under their file, then
// their describe blocks.

import { relative, sep } from "node:path"
import type { TestCase, TestResult, TestStatus } from "./model.ts"

/** How vitest joins a test's describe blocks and name in a listing */
const JOIN = " > "

const testId = (file: string, names: string[]) => [file, ...names].join(JOIN)

interface Listed {
  name: string
  file: string
  location?: { line: number }
}

export function parseVitestList(out: string, dir: string): TestCase[] {
  const listed = JSON.parse(out) as Listed[]
  return listed.map(({ name, file, location }) => {
    const names = name.split(JOIN)
    return {
      id: testId(file, names),
      path: [relative(dir, file), ...names],
      file,
      ...(location ? { line: location.line } : {}),
    }
  })
}

const STATUS: Record<string, TestStatus> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  pending: "skipped",
  todo: "skipped",
}

interface Report {
  testResults: {
    name: string
    status: string
    message: string
    assertionResults: {
      ancestorTitles: string[]
      title: string
      status: string
      failureMessages: string[]
    }[]
  }[]
}

/** The first frame of a stack in the workspace and outside its dependencies */
function failureIn(stack: string, dir: string): { file: string; line: number } | undefined {
  for (const m of stack.matchAll(/(?:file:\/\/)?(\/[^\s:()]+):(\d+):\d+/g)) {
    const file = m[1]
    if (file.startsWith(dir + sep) && !file.includes(`${sep}node_modules${sep}`))
      return { file, line: Number(m[2]) }
  }
  return undefined
}

/** The JSON reporter's file. A test file that failed with no tests run (it
 * didn't load) is a failure of its own. */
export function parseVitestRun(out: string, dir: string): TestResult[] {
  const report = JSON.parse(out) as Report
  const results: TestResult[] = []
  for (const suite of report.testResults) {
    const file = suite.name
    const rel = relative(dir, file)
    if (!suite.assertionResults.length && suite.status === "failed") {
      results.push({ id: file, path: [rel], file, status: "failed", output: suite.message })
      continue
    }
    for (const a of suite.assertionResults) {
      const names = [...a.ancestorTitles, a.title]
      const output = a.failureMessages.join("\n")
      const status = STATUS[a.status] ?? "skipped"
      const failure = status === "failed" ? failureIn(output, dir) : undefined
      results.push({
        id: testId(file, names),
        path: [rel, ...names],
        file,
        status,
        output,
        ...(failure ? { failure } : {}),
      })
    }
  }
  return results
}

/** The changed files `vitest related` should start from: those under the
 * runner, outside its dependencies */
export function vitestFilesOf(changed: string[], dir: string): string[] {
  return changed.filter(
    (f) => f.startsWith(dir + sep) && !f.includes(`${sep}node_modules${sep}`),
  )
}
