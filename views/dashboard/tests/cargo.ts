// Rust tests, for the Tests tab: cargo-nextest when it's installed (a JSON
// listing, and libtest JSON events from a run), plain `cargo test` when it
// isn't (its human output, since its JSON is nightly only). A change runs
// the crates it touched.

import { readFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import type { TestCase, TestResult, TestStatus } from "./model.ts"

interface Suite {
  "package-name": string
  "binary-id": string
  "binary-name": string
  cwd: string
  testcases: Record<string, unknown>
}

const suitesOf = (out: string) =>
  Object.values(
    (JSON.parse(out) as { "rust-suites": Record<string, Suite> })["rust-suites"],
  )

/** How a run's events name a binary: package::binary */
const runKey = (s: Suite) => `${s["package-name"]}::${s["binary-name"]}`

/** `cargo nextest list --message-format json`: tests under their binary,
 * then their modules, with ids as a run names them */
export function parseNextestList(out: string): TestCase[] {
  return suitesOf(out).flatMap((s) =>
    Object.keys(s.testcases).map((name) => ({
      id: `${runKey(s)}$${name}`,
      path: [s["binary-id"], ...name.split("::")],
    })),
  )
}

/** Each binary's directory, which its panics' paths are relative to */
export function nextestCwds(out: string): Record<string, string> {
  return Object.fromEntries(suitesOf(out).map((s) => [runKey(s), s.cwd]))
}

/** Where a panic happened: `panicked at src/lib.rs:13:9`, relative to the
 * crate */
function panicIn(output: string, cwd: string) {
  const m = /panicked at ([^\s:]+):(\d+):\d+/.exec(output)
  return m ? { file: join(cwd, m[1]), line: Number(m[2]) } : undefined
}

const NEXTEST_STATUS: Record<string, TestStatus> = {
  ok: "passed",
  failed: "failed",
  ignored: "skipped",
}

/** `cargo nextest run --message-format libtest-json`: each test's status,
 * and a failure's stdout. A run names a test package::binary$name, and it
 * sits under the binary's id as the listing has it: the package for a lib,
 * package::target for a test target. */
export function parseNextestRun(
  out: string,
  dir: string,
  cwds: Record<string, string>,
): TestResult[] {
  const results: TestResult[] = []
  for (const line of out.split("\n")) {
    let e: { type?: string; event?: string; name?: string; stdout?: string }
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const status = e.event && NEXTEST_STATUS[e.event]
    if (e.type !== "test" || !status || !e.name) continue
    const [key, name] = e.name.split("$")
    const [pkg, binary] = key.split("::")
    const output = e.stdout ?? ""
    const group = binary === pkg ? pkg : key
    const failure = status === "failed" ? panicIn(output, cwds[key] ?? dir) : undefined
    results.push({
      id: e.name,
      path: [group, ...name.split("::")],
      status,
      output,
      ...(failure ? { failure } : {}),
    })
  }
  return results
}

/** `cargo test -- --list`: one `name: test` line per test, per binary.
 * Without the binaries' names, a name in two of them is listed once. */
export function parseCargoList(out: string): TestCase[] {
  const seen = new Set<string>()
  const tests: TestCase[] = []
  for (const line of out.split("\n")) {
    const m = /^(\S+): test$/.exec(line)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    tests.push({ id: m[1], path: m[1].split("::") })
  }
  return tests
}

const CARGO_STATUS: Record<string, TestStatus> = {
  ok: "passed",
  FAILED: "failed",
  ignored: "skipped",
}

/** `cargo test`'s output: a `test name ... ok` line per test, and each
 * failure's stdout under `---- name stdout ----`. A panic's path is taken
 * as relative to the runner's directory. */
export function parseCargoRun(out: string, dir: string): TestResult[] {
  const results = new Map<string, TestResult>()
  const lines = out.split("\n")
  for (const line of lines) {
    const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line)
    if (m)
      results.set(m[1], {
        id: m[1],
        path: m[1].split("::"),
        status: CARGO_STATUS[m[2]],
        output: "",
      })
  }
  let current: TestResult | undefined
  for (const line of lines) {
    const head = /^---- (\S+) stdout ----$/.exec(line)
    if (head) {
      current = results.get(head[1])
      continue
    }
    if (line === "failures:") current = undefined
    else if (current) current.output += `${line}\n`
  }
  for (const r of results.values()) {
    // The blank lines before the next section
    r.output = r.output.replace(/\n+$/, "\n").replace(/^\n$/, "")
    if (r.status !== "failed") continue
    const failure = panicIn(r.output, dir)
    if (failure) r.failure = failure
  }
  return [...results.values()]
}

/** The package a Cargo.toml names, or null for a workspace's */
async function packageName(manifest: string): Promise<string | null> {
  try {
    const text = await readFile(manifest, "utf8")
    const pkg = /^\[package\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1]
    return (pkg && /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pkg)?.[1]) || null
  } catch {
    return null
  }
}

/** The crates the changed files under `dir` belong to: each file's nearest
 * Cargo.toml with a package, up to `dir` */
export async function cratesOf(changed: string[], dir: string): Promise<string[]> {
  const crates = new Set<string>()
  for (const file of changed) {
    if (!file.startsWith(dir + sep)) continue
    for (let d = dirname(file); d === dir || d.startsWith(dir + sep); d = dirname(d)) {
      const name = await packageName(join(d, "Cargo.toml"))
      if (name) {
        crates.add(name)
        break
      }
      if (d === dir) break
    }
  }
  return [...crates].toSorted()
}
