import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Runner } from "./detect.ts"
import { listTests, runTests } from "./run.ts"

const has = (cmd: string, ...args: string[]) => spawnSync(cmd, args).status === 0

let root: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-run-")))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const statuses = (results: { path: string[]; status: string }[]) =>
  Object.fromEntries(results.map((r) => [r.path.join(" / "), r.status]))

describe.skipIf(!has("go", "version"))("go", () => {
  let runner: Runner

  beforeAll(() => {
    runner = {
      kind: "go",
      dir: project("go", {
        "go.mod": "module example.com/sample\n\ngo 1.21\n",
        "a_test.go":
          'package sample\n\nimport "testing"\n\nfunc TestPass(t *testing.T) {}\n\nfunc TestFail(t *testing.T) {\n\tt.Error("no")\n}\n',
        "sub/b_test.go":
          'package sub\n\nimport "testing"\n\nfunc TestSub(t *testing.T) {}\n',
      }),
    }
  })

  test("lists without running", async () => {
    const { tests, error } = await listTests(runner)
    expect(error).toBeNull()
    expect(tests.map((t) => t.path.join(" / "))).toEqual([
      ". / TestPass",
      ". / TestFail",
      "sub / TestSub",
    ])
  })

  test("runs everything, or only the packages a change touched", async () => {
    const all = await runTests(runner, null, {})
    expect(all && statuses(all.results)).toEqual({
      ". / TestPass": "passed",
      ". / TestFail": "failed",
      "sub / TestSub": "passed",
    })
    const some = await runTests(runner, [join(runner.dir, "sub", "b_test.go")], {})
    expect(some && statuses(some.results)).toEqual({ "sub / TestSub": "passed" })
    expect(await runTests(runner, [join(runner.dir, "README.md")], {})).toBeNull()
  })
})

// vitest from ah's own dependencies, as a project would have it
const ahModules = resolve(import.meta.dirname, "../../../node_modules")

describe.skipIf(!existsSync(join(ahModules, "vitest")))("vitest", () => {
  let runner: Runner

  beforeAll(() => {
    const dir = project("vt", {
      "package.json": JSON.stringify({ type: "module", devDependencies: { vitest: "*" } }),
      "src/math.ts": "export const add = (a: number, b: number) => a + b\n",
      "src/math.test.ts":
        'import { describe, expect, test } from "vitest"\nimport { add } from "./math.ts"\n\ntest("adds", () => expect(add(1, 1)).toBe(2))\n\ndescribe("math", () => {\n  test("fails", () => expect(add(1, 1)).toBe(3))\n})\n',
      "src/other.test.ts": 'import { test } from "vitest"\n\ntest("other", () => {})\n',
    })
    symlinkSync(ahModules, join(dir, "node_modules"))
    runner = { kind: "vitest", dir }
  })

  test("lists without running, and leaves no report in the project", async () => {
    const { tests, error } = await listTests(runner)
    expect(error).toBeNull()
    expect(tests.map((t) => t.path.join(" / ")).toSorted()).toEqual([
      "src/math.test.ts / adds",
      "src/math.test.ts / math / fails",
      "src/other.test.ts / other",
    ])
    expect(readdirSync(runner.dir).toSorted()).toEqual([
      "node_modules",
      "package.json",
      "src",
    ])
  })

  test("runs everything, or the tests related to a change", async () => {
    const all = await runTests(runner, null, {})
    expect(all && statuses(all.results)).toEqual({
      "src/math.test.ts / adds": "passed",
      "src/math.test.ts / math / fails": "failed",
      "src/other.test.ts / other": "passed",
    })
    const some = await runTests(runner, [join(runner.dir, "src", "math.ts")], {})
    expect(some && Object.keys(statuses(some.results)).toSorted()).toEqual([
      "src/math.test.ts / adds",
      "src/math.test.ts / math / fails",
    ])
    expect(readdirSync(runner.dir).toSorted()).toEqual([
      "node_modules",
      "package.json",
      "src",
    ])
  })
})

describe.skipIf(!has("cargo", "nextest", "--version"))("nextest", () => {
  let runner: Runner

  beforeAll(() => {
    runner = {
      kind: "nextest",
      dir: project("rs", {
        "Cargo.toml": '[package]\nname = "sample"\nversion = "0.1.0"\nedition = "2021"\n',
        "src/lib.rs":
          "#[cfg(test)]\nmod tests {\n    #[test]\n    fn passes() {}\n\n    #[test]\n    fn fails() {\n        assert_eq!(1, 2);\n    }\n}\n",
      }),
    }
  })

  test("lists, then runs with failures where they panicked", async () => {
    const { tests, error, cwds } = await listTests(runner)
    expect(error).toBeNull()
    expect(tests.map((t) => t.path.join(" / ")).toSorted()).toEqual([
      "sample / tests / fails",
      "sample / tests / passes",
    ])
    const run = await runTests(runner, null, cwds)
    expect(run && statuses(run.results)).toEqual({
      "sample / tests / passes": "passed",
      "sample / tests / fails": "failed",
    })
    expect(run?.results.find((r) => r.status === "failed")?.failure).toEqual({
      file: join(runner.dir, "src", "lib.rs"),
      line: 8,
    })
  }, 120_000)

  test("a crate that doesn't compile is an error, in the compiler's words", async () => {
    const dir = project("rs-broken", {
      "Cargo.toml": '[package]\nname = "broken"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": 'fn nope() -> u8 { "x" }\n',
    })
    const { tests, error } = await listTests({ kind: "nextest", dir })
    expect(tests).toEqual([])
    expect(error).toMatch(/mismatched types/)
  }, 120_000)
})
