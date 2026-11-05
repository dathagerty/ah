// go test, for the Tests tab: listing with `go test -list`, running with
// `go test -json`. Tests sit under their package, relative to the module.

import { dirname, join, relative, sep } from "node:path"
import type { TestCase, TestResult, TestStatus } from "./model.ts"

/** The module path in a go.mod */
export function goModule(goMod: string): string | null {
  return /^module\s+(\S+)/m.exec(goMod)?.[1] ?? null
}

/** A package's directory relative to the module root, "." for the root */
function relPackage(pkg: string, module: string): string {
  return pkg === module
    ? "."
    : pkg.startsWith(`${module}/`)
      ? pkg.slice(module.length + 1)
      : pkg
}

/** What `go test -list . ./...` lists that `go test` runs: not benchmarks */
const RUNNABLE = /^(Test|Example|Fuzz)\w*$/

/** `go test -list . ./...`: each package's names, then its `ok` line (or
 * `?` for none, or FAIL for one that didn't build) */
export function parseGoList(out: string, _dir: string, module: string): TestCase[] {
  const tests: TestCase[] = []
  let names: string[] = []
  for (const line of out.split("\n")) {
    const done = /^(ok|\?|FAIL)\s+(\S+)/.exec(line)
    if (done) {
      const pkg = done[2]
      if (done[1] === "ok")
        for (const name of names)
          tests.push({ id: `${pkg}.${name}`, path: [relPackage(pkg, module), name] })
      names = []
    } else if (RUNNABLE.test(line.trim())) names.push(line.trim())
  }
  return tests
}

const STATUS: Record<string, TestStatus> = {
  pass: "passed",
  fail: "failed",
  skip: "skipped",
}

/** go's own lines in a test's output, which the tree already says */
const MARKER = /^(=== (RUN|PAUSE|CONT|NAME)|\s*--- (PASS|FAIL|SKIP):)/

interface GoEvent {
  Action: string
  Package?: string
  ImportPath?: string
  Test?: string
  Output?: string
}

/** `go test -json ./...`: each test's status and output, where the last
 * `file.go:line:` in a failure's output is where it failed. A package that
 * failed without a failing test (it didn't build) is a failure of its own. */
export function parseGoRun(out: string, dir: string, module: string): TestResult[] {
  const results = new Map<string, TestResult>()
  const pkgOutput = new Map<string, string>()
  const failedPkgs: string[] = []
  for (const line of out.split("\n")) {
    let e: GoEvent
    try {
      e = JSON.parse(line) as GoEvent
    } catch {
      continue
    }
    // A build's events name the package as `pkg [pkg.test]`
    const pkg = e.Package ?? e.ImportPath?.split(" ")[0]
    if (!pkg) continue
    if (!e.Test) {
      if ((e.Action === "output" || e.Action === "build-output") && e.Output)
        pkgOutput.set(pkg, (pkgOutput.get(pkg) ?? "") + e.Output)
      if (e.Action === "fail" && e.Package) failedPkgs.push(pkg)
      continue
    }
    const id = `${pkg}.${e.Test}`
    let r = results.get(id)
    if (!r) {
      r = {
        id,
        path: [relPackage(pkg, module), ...e.Test.split("/")],
        status: "skipped",
        output: "",
      }
      results.set(id, r)
    }
    if (e.Action === "output" && e.Output && !MARKER.test(e.Output)) r.output += e.Output
    if (STATUS[e.Action]) r.status = STATUS[e.Action]
  }
  for (const r of results.values()) {
    if (r.status !== "failed") continue
    const at = [...r.output.matchAll(/^\s*([\w./-]+\.go):(\d+):/gm)].at(-1)
    if (!at) continue
    const pkgDir = r.path[0] === "." ? dir : join(dir, r.path[0])
    r.failure = { file: join(pkgDir, at[1]), line: Number(at[2]) }
  }
  for (const pkg of failedPkgs) {
    const rel = relPackage(pkg, module)
    const anyFailed = [...results.values()].some(
      (r) => r.path[0] === rel && r.status === "failed",
    )
    if (!anyFailed)
      results.set(pkg, {
        id: pkg,
        path: [rel],
        status: "failed",
        output: pkgOutput.get(pkg) ?? "",
      })
  }
  return [...results.values()]
}

/** What `go test` runs for changed files: the packages of the .go files
 * under `dir`, or everything when go.mod or go.sum changed */
export function goPackagesOf(changed: string[], dir: string): string[] {
  const inside = changed.filter((f) => f.startsWith(dir + sep))
  if (inside.some((f) => /\/go\.(mod|sum)$/.test(f))) return ["./..."]
  const pkgs = new Set<string>()
  for (const f of inside) {
    if (!f.endsWith(".go")) continue
    const rel = relative(dir, dirname(f))
    pkgs.add(rel === "" ? "." : `./${rel}`)
  }
  return [...pkgs].toSorted()
}
