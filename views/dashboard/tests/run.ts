// Listing and running a runner's tests (detect.ts), each with its own
// commands and parser. Runs write JSON reports to a temp dir of their own,
// never into the project. A run whose tests fail succeeded; an error is a
// run or listing that produced nothing to read, with the runner's message.

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run, type Output } from "../../../platform/proc.ts"
import {
  cratesOf,
  nextestCwds,
  parseCargoList,
  parseCargoRun,
  parseNextestList,
  parseNextestRun,
} from "./cargo.ts"
import type { Runner } from "./detect.ts"
import { goModule, goPackagesOf, parseGoList, parseGoRun } from "./go.ts"
import type { TestCase, TestResult } from "./model.ts"
import { parseVitestList, parseVitestRun, vitestFilesOf } from "./vitest.ts"

/** Each Rust test binary's directory, from a nextest listing, for where a
 * run's panics are */
export type Cwds = Record<string, string>

export interface Listing {
  tests: TestCase[]
  error: string | null
  cwds: Cwds
}

export interface RunOutcome {
  results: TestResult[]
  error: string | null
}

// No colors in what gets parsed or shown; npx never installs what's missing
const ENV = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CARGO_TERM_COLOR: "never" }

/** The end of a runner's message, which says what went wrong */
const tail = (text: string) => text.trim().split("\n").slice(-40).join("\n")

const errorOf = (o: Output) => tail(o.stderr || o.stdout) || `exited with ${o.code}`

async function exec(
  runner: Runner,
  cmd: string,
  args: string[],
  signal?: AbortSignal,
  env: Record<string, string> = {},
): Promise<Output> {
  return await run(cmd, args, { cwd: runner.dir, env: { ...ENV, ...env }, signal })
}

/** A temp dir for a command's report files, removed after */
async function withTemp<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ah-tests-"))
  try {
    return await f(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const readOr = (file: string) => readFile(file, "utf8").catch(() => null)

async function goModuleOf(runner: Runner): Promise<string> {
  return goModule((await readOr(join(runner.dir, "go.mod"))) ?? "") ?? ""
}

/** The runner's tests, without running them */
export async function listTests(runner: Runner, signal?: AbortSignal): Promise<Listing> {
  const none = (error: string): Listing => ({ tests: [], error, cwds: {} })
  switch (runner.kind) {
    case "vitest":
      return await withTemp(async (tmp) => {
        const file = join(tmp, "list.json")
        const o = await exec(
          runner,
          "npx",
          ["--no", "vitest", "list", `--json=${file}`],
          signal,
        )
        const out = await readOr(file)
        return out
          ? { tests: parseVitestList(out, runner.dir), error: null, cwds: {} }
          : none(errorOf(o))
      })
    case "go": {
      const o = await exec(runner, "go", ["test", "-list", ".", "./..."], signal)
      const tests = parseGoList(o.stdout, runner.dir, await goModuleOf(runner))
      return { tests, error: o.success ? null : errorOf(o), cwds: {} }
    }
    case "nextest": {
      const o = await exec(
        runner,
        "cargo",
        ["nextest", "list", "--message-format", "json"],
        signal,
      )
      if (!o.success) return none(errorOf(o))
      return { tests: parseNextestList(o.stdout), error: null, cwds: nextestCwds(o.stdout) }
    }
    case "cargo": {
      const o = await exec(runner, "cargo", ["test", "--", "--list"], signal)
      if (!o.success) return none(errorOf(o))
      return { tests: parseCargoList(o.stdout), error: null, cwds: {} }
    }
  }
}

/**
 * Run the runner's tests: all of them for `changed` null, otherwise only
 * what the changed files touch, or null when they touch none. `cwds` is from
 * the runner's last listing.
 */
export async function runTests(
  runner: Runner,
  changed: string[] | null,
  cwds: Cwds,
  signal?: AbortSignal,
): Promise<RunOutcome | null> {
  const outcome = (results: TestResult[], o: Output): RunOutcome => ({
    results,
    // Failing tests exit nonzero too; only a run that reported nothing failed
    error: results.length || o.success ? null : errorOf(o),
  })
  switch (runner.kind) {
    case "vitest": {
      const files = changed && vitestFilesOf(changed, runner.dir)
      if (files && !files.length) return null
      return await withTemp(async (tmp) => {
        const file = join(tmp, "run.json")
        const report = ["--reporter=json", `--outputFile.json=${file}`]
        const args = files
          ? ["--no", "vitest", "related", "--run", ...report, ...files]
          : ["--no", "vitest", "run", ...report]
        const o = await exec(runner, "npx", args, signal)
        const out = await readOr(file)
        return outcome(out ? parseVitestRun(out, runner.dir) : [], o)
      })
    }
    case "go": {
      const pkgs = changed ? goPackagesOf(changed, runner.dir) : ["./..."]
      if (!pkgs.length) return null
      const o = await exec(runner, "go", ["test", "-json", ...pkgs], signal)
      return outcome(parseGoRun(o.stdout, runner.dir, await goModuleOf(runner)), o)
    }
    case "nextest":
    case "cargo": {
      const crates = changed ? await cratesOf(changed, runner.dir) : []
      if (changed && !crates.length) return null
      const only = crates.flatMap((c) => ["-p", c])
      if (runner.kind === "cargo") {
        const o = await exec(runner, "cargo", ["test", "--no-fail-fast", ...only], signal)
        return outcome(parseCargoRun(o.stdout, runner.dir), o)
      }
      const args = [
        "nextest",
        "run",
        "--message-format",
        "libtest-json",
        "--no-fail-fast",
        ...only,
      ]
      const o = await exec(runner, "cargo", args, signal, {
        NEXTEST_EXPERIMENTAL_LIBTEST_JSON: "1",
      })
      return outcome(parseNextestRun(o.stdout, runner.dir, cwds), o)
    }
  }
}
