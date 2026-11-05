import { expect, test } from "vitest"
import { goModule, goPackagesOf, parseGoList, parseGoRun } from "./go.ts"

const DIR = "/ws"
const MODULE = "example.com/sample"

test("the module path comes from go.mod", () => {
  expect(goModule("// a comment\nmodule example.com/sample\n\ngo 1.26\n")).toBe(MODULE)
  expect(goModule("go 1.26\n")).toBeNull()
})

test("a listing's names belong to the package line after them", () => {
  const out = [
    "TestPass",
    "TestFail",
    "BenchmarkSpeed",
    "ok  \texample.com/sample\t0.337s",
    "?   \texample.com/sample/empty\t[no test files]",
    "TestSub",
    "ok  \texample.com/sample/sub\t0.491s",
  ].join("\n")
  expect(parseGoList(out, DIR, MODULE)).toEqual([
    { id: "example.com/sample.TestPass", path: [".", "TestPass"] },
    { id: "example.com/sample.TestFail", path: [".", "TestFail"] },
    { id: "example.com/sample/sub.TestSub", path: ["sub", "TestSub"] },
  ])
})

const event = (e: Record<string, unknown>) => JSON.stringify({ Time: "t", ...e })

test("a run gives each test its status and output, without go's own markers", () => {
  const out = [
    event({ Action: "run", Package: MODULE, Test: "TestPass" }),
    event({
      Action: "output",
      Package: MODULE,
      Test: "TestPass",
      Output: "=== RUN   TestPass\n",
    }),
    event({
      Action: "output",
      Package: MODULE,
      Test: "TestPass",
      Output: "--- PASS: TestPass (0.00s)\n",
    }),
    event({ Action: "pass", Package: MODULE, Test: "TestPass", Elapsed: 0 }),
    event({
      Action: "output",
      Package: MODULE,
      Test: "TestFail",
      Output: "=== RUN   TestFail\n",
    }),
    event({
      Action: "output",
      Package: MODULE,
      Test: "TestFail",
      Output: "    a_test.go:8: about to fail\n",
    }),
    event({
      Action: "output",
      Package: MODULE,
      Test: "TestFail",
      Output: "    a_test.go:9: got 1, want 2\n",
    }),
    event({
      Action: "output",
      Package: MODULE,
      Test: "TestFail",
      Output: "--- FAIL: TestFail (0.00s)\n",
    }),
    event({ Action: "fail", Package: MODULE, Test: "TestFail", Elapsed: 0 }),
    event({
      Action: "output",
      Package: MODULE,
      Test: "TestSkip",
      Output: "    a_test.go:12: not yet\n",
    }),
    event({ Action: "skip", Package: MODULE, Test: "TestSkip", Elapsed: 0 }),
    event({ Action: "fail", Package: MODULE, Elapsed: 0.3 }),
  ].join("\n")
  expect(parseGoRun(out, DIR, MODULE)).toEqual([
    { id: `${MODULE}.TestPass`, path: [".", "TestPass"], status: "passed", output: "" },
    {
      id: `${MODULE}.TestFail`,
      path: [".", "TestFail"],
      status: "failed",
      output: "    a_test.go:8: about to fail\n    a_test.go:9: got 1, want 2\n",
      failure: { file: "/ws/a_test.go", line: 9 },
    },
    {
      id: `${MODULE}.TestSkip`,
      path: [".", "TestSkip"],
      status: "skipped",
      output: "    a_test.go:12: not yet\n",
    },
  ])
})

test("a subtest sits under its parent, in its package's directory", () => {
  const pkg = `${MODULE}/sub`
  const out = [
    event({
      Action: "output",
      Package: pkg,
      Test: "TestTable/two",
      Output: "    b_test.go:16: two broke\n",
    }),
    event({ Action: "fail", Package: pkg, Test: "TestTable/two" }),
    event({ Action: "fail", Package: pkg, Test: "TestTable" }),
  ].join("\n")
  expect(parseGoRun(out, DIR, MODULE)).toEqual([
    {
      id: `${pkg}.TestTable/two`,
      path: ["sub", "TestTable", "two"],
      status: "failed",
      output: "    b_test.go:16: two broke\n",
      failure: { file: "/ws/sub/b_test.go", line: 16 },
    },
    { id: `${pkg}.TestTable`, path: ["sub", "TestTable"], status: "failed", output: "" },
  ])
})

test("a package that fails to build is a failure of its own, with the compiler's output", () => {
  const pkg = `${MODULE}/broken`
  const out = [
    event({
      Action: "build-output",
      ImportPath: `${pkg} [${pkg}.test]`,
      Output: "# example.com/sample/broken\n",
    }),
    event({
      Action: "build-output",
      ImportPath: `${pkg} [${pkg}.test]`,
      Output: "broken/x.go:3:2: undefined: nope\n",
    }),
    event({ Action: "build-fail", ImportPath: `${pkg} [${pkg}.test]` }),
    event({
      Action: "output",
      Package: pkg,
      Output: "FAIL\texample.com/sample/broken [build failed]\n",
    }),
    event({
      Action: "fail",
      Package: pkg,
      Elapsed: 0,
      FailedBuild: `${pkg} [${pkg}.test]`,
    }),
  ].join("\n")
  expect(parseGoRun(out, DIR, MODULE)).toEqual([
    {
      id: pkg,
      path: ["broken"],
      status: "failed",
      output:
        "# example.com/sample/broken\nbroken/x.go:3:2: undefined: nope\nFAIL\texample.com/sample/broken [build failed]\n",
    },
  ])
})

test("a change runs the packages of the go files it touched, or everything for go.mod", () => {
  expect(
    goPackagesOf(["/ws/a.go", "/ws/sub/b_test.go", "/ws/sub/c.go", "/ws/README.md"], DIR),
  ).toEqual([".", "./sub"])
  expect(goPackagesOf(["/ws/README.md", "/other/x.go"], DIR)).toEqual([])
  expect(goPackagesOf(["/ws/go.mod"], DIR)).toEqual(["./..."])
})
