import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import {
  cratesOf,
  nextestCwds,
  parseCargoList,
  parseCargoRun,
  parseNextestList,
  parseNextestRun,
} from "./cargo.ts"

const DIR = "/ws"

const listing = JSON.stringify({
  "test-count": 3,
  "rust-suites": {
    sample: {
      "package-name": "sample",
      "binary-id": "sample",
      "binary-name": "sample",
      kind: "lib",
      cwd: "/ws/crates/sample",
      testcases: {
        "tests::passes": { kind: "test", ignored: false },
        "tests::ignored": { kind: "test", ignored: true },
      },
    },
    "sample::it": {
      "package-name": "sample",
      "binary-id": "sample::it",
      "binary-name": "it",
      kind: "test",
      cwd: "/ws/crates/sample",
      testcases: { integrates: { kind: "test", ignored: false } },
    },
  },
})

test("nextest's listing puts each test under its binary and modules", () => {
  expect(parseNextestList(listing)).toEqual([
    { id: "sample::sample$tests::passes", path: ["sample", "tests", "passes"] },
    { id: "sample::sample$tests::ignored", path: ["sample", "tests", "ignored"] },
    { id: "sample::it$integrates", path: ["sample::it", "integrates"] },
  ])
  expect(nextestCwds(listing)).toEqual({
    "sample::sample": "/ws/crates/sample",
    "sample::it": "/ws/crates/sample",
  })
})

test("a nextest run gives each test its status, and a panic where it happened", () => {
  const stdout =
    "about to fail\n\nthread 'tests::fails' (737238) panicked at src/lib.rs:13:9:\nassertion `left == right` failed: math\n"
  const out = [
    '{"type":"suite","event":"started","test_count":4}',
    '{"type":"test","event":"started","name":"sample::sample$tests::passes"}',
    '{"type":"test","event":"ok","name":"sample::sample$tests::passes","exec_time":0.01}',
    '{"type":"test","event":"ignored","name":"sample::sample$tests::ignored"}',
    JSON.stringify({
      type: "test",
      event: "failed",
      name: "sample::sample$tests::fails",
      stdout,
    }),
    '{"type":"test","event":"ok","name":"sample::it$integrates","exec_time":0.01}',
    '{"type":"suite","event":"failed","passed":2,"failed":1}',
  ].join("\n")
  expect(parseNextestRun(out, DIR, nextestCwds(listing))).toEqual([
    {
      id: "sample::sample$tests::passes",
      path: ["sample", "tests", "passes"],
      status: "passed",
      output: "",
    },
    {
      id: "sample::sample$tests::ignored",
      path: ["sample", "tests", "ignored"],
      status: "skipped",
      output: "",
    },
    {
      id: "sample::sample$tests::fails",
      path: ["sample", "tests", "fails"],
      status: "failed",
      output: stdout,
      failure: { file: "/ws/crates/sample/src/lib.rs", line: 13 },
    },
    {
      id: "sample::it$integrates",
      path: ["sample::it", "integrates"],
      status: "passed",
      output: "",
    },
  ])
})

test("without nextest's listing, a panic is found from the runner's directory", () => {
  const out = JSON.stringify({
    type: "test",
    event: "failed",
    name: "sample::sample$t",
    stdout: "panicked at src/lib.rs:2:1:\n",
  })
  expect(parseNextestRun(out, DIR, {})[0].failure).toEqual({
    file: "/ws/src/lib.rs",
    line: 2,
  })
})

test("cargo test's listing is each test once, under its modules", () => {
  const out =
    "tests::fails: test\ntests::passes: test\nbench_it: benchmark\n\nintegrates: test\ntests::passes: test\n"
  expect(parseCargoList(out)).toEqual([
    { id: "tests::fails", path: ["tests", "fails"] },
    { id: "tests::passes", path: ["tests", "passes"] },
    { id: "integrates", path: ["integrates"] },
  ])
})

test("cargo test's output gives each test its status, and a failure its own stdout", () => {
  const out = [
    "running 3 tests",
    "test tests::ignored ... ignored",
    "test tests::passes ... ok",
    "test tests::fails ... FAILED",
    "",
    "failures:",
    "",
    "---- tests::fails stdout ----",
    "about to fail",
    "",
    "thread 'tests::fails' (737314) panicked at src/lib.rs:13:9:",
    "assertion `left == right` failed: math",
    "",
    "",
    "failures:",
    "    tests::fails",
    "",
    "test result: FAILED. 1 passed; 1 failed; 1 ignored",
  ].join("\n")
  expect(parseCargoRun(out, DIR)).toEqual([
    { id: "tests::ignored", path: ["tests", "ignored"], status: "skipped", output: "" },
    { id: "tests::passes", path: ["tests", "passes"], status: "passed", output: "" },
    {
      id: "tests::fails",
      path: ["tests", "fails"],
      status: "failed",
      output:
        "about to fail\n\nthread 'tests::fails' (737314) panicked at src/lib.rs:13:9:\nassertion `left == right` failed: math\n",
      failure: { file: "/ws/src/lib.rs", line: 13 },
    },
  ])
})

let ws: string

beforeAll(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "ah-cargo-")))
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(ws, path)), { recursive: true })
    writeFileSync(join(ws, path), text)
  }
  write("Cargo.toml", "[workspace]\nmembers = ['crates/*']\n")
  write("crates/a/Cargo.toml", '[package]\nname = "alpha"\nversion = "0.1.0"\n')
  write("crates/a/src/lib.rs", "")
  write("crates/b/Cargo.toml", "[package]\nname = 'beta'\n")
  write("crates/b/src/deep/mod.rs", "")
})

afterAll(() => rmSync(ws, { recursive: true, force: true }))

test("a change runs the crates whose files it touched", async () => {
  const changed = [
    join(ws, "crates/a/src/lib.rs"),
    join(ws, "crates/b/src/deep/mod.rs"),
    join(ws, "crates/b/Cargo.toml"),
    join(ws, "README.md"),
  ]
  expect(await cratesOf(changed, ws)).toEqual(["alpha", "beta"])
})

test("a change outside any crate runs nothing", async () => {
  expect(await cratesOf([join(ws, "README.md"), "/elsewhere/x.rs"], ws)).toEqual([])
})
