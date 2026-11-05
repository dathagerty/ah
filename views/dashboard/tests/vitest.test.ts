import { expect, test } from "vitest"
import { parseVitestList, parseVitestRun, vitestFilesOf } from "./vitest.ts"

const DIR = "/ws"

test("a listing puts each test under its file and suites, with where it's defined", () => {
  const out = JSON.stringify([
    { name: "adds", file: "/ws/src/math.test.ts", location: { line: 3, column: 1 } },
    {
      name: "math > nested > deep",
      file: "/ws/src/math.test.ts",
      location: { line: 14, column: 5 },
    },
  ])
  expect(parseVitestList(out, DIR)).toEqual([
    {
      id: "/ws/src/math.test.ts > adds",
      path: ["src/math.test.ts", "adds"],
      file: "/ws/src/math.test.ts",
      line: 3,
    },
    {
      id: "/ws/src/math.test.ts > math > nested > deep",
      path: ["src/math.test.ts", "math", "nested", "deep"],
      file: "/ws/src/math.test.ts",
      line: 14,
    },
  ])
})

const report = (testResults: unknown[]) => JSON.stringify({ success: false, testResults })

test("a run gives each test its status, a failure its messages and where in the workspace it failed", () => {
  const stack = [
    "AssertionError: expected 2 to be 3 // Object.is equality",
    "    at /ws/node_modules/vitest/dist/chunks/run.js:1628:35",
    "    at /ws/src/math.test.ts:10:19",
    "    at file:///ws/node_modules/vitest/dist/chunks/run.js:2783:26",
  ].join("\n")
  const out = report([
    {
      name: "/ws/src/math.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        { ancestorTitles: [], title: "adds", status: "passed", failureMessages: [] },
        {
          ancestorTitles: ["math"],
          title: "fails",
          status: "failed",
          failureMessages: [stack],
        },
        {
          ancestorTitles: ["math"],
          title: "skipped",
          status: "skipped",
          failureMessages: [],
        },
        { ancestorTitles: ["math"], title: "later", status: "todo", failureMessages: [] },
      ],
    },
  ])
  expect(parseVitestRun(out, DIR)).toEqual([
    {
      id: "/ws/src/math.test.ts > adds",
      path: ["src/math.test.ts", "adds"],
      file: "/ws/src/math.test.ts",
      status: "passed",
      output: "",
    },
    {
      id: "/ws/src/math.test.ts > math > fails",
      path: ["src/math.test.ts", "math", "fails"],
      file: "/ws/src/math.test.ts",
      status: "failed",
      output: stack,
      failure: { file: "/ws/src/math.test.ts", line: 10 },
    },
    {
      id: "/ws/src/math.test.ts > math > skipped",
      path: ["src/math.test.ts", "math", "skipped"],
      file: "/ws/src/math.test.ts",
      status: "skipped",
      output: "",
    },
    {
      id: "/ws/src/math.test.ts > math > later",
      path: ["src/math.test.ts", "math", "later"],
      file: "/ws/src/math.test.ts",
      status: "skipped",
      output: "",
    },
  ])
})

test("a file that fails before its tests run is a failure of its own", () => {
  const out = report([
    {
      name: "/ws/src/broken.test.ts",
      status: "failed",
      message: "Failed to load url ./nope.ts",
      assertionResults: [],
    },
  ])
  expect(parseVitestRun(out, DIR)).toEqual([
    {
      id: "/ws/src/broken.test.ts",
      path: ["src/broken.test.ts"],
      file: "/ws/src/broken.test.ts",
      status: "failed",
      output: "Failed to load url ./nope.ts",
    },
  ])
})

test("a change runs vitest on the changed files under the runner, skipping its dependencies", () => {
  expect(
    vitestFilesOf(
      ["/ws/src/a.ts", "/ws/node_modules/x/index.js", "/other/b.ts", "/ws/README.md"],
      DIR,
    ),
  ).toEqual(["/ws/src/a.ts", "/ws/README.md"])
})
