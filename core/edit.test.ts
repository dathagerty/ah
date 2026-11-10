import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { assetPath } from "../platform/assets.ts"
import { editPlan, parseEditArgs } from "./edit.ts"

const AH = assetPath("ah.ts")

describe("parseEditArgs", () => {
  test("makes the files absolute, from where it's run", () => {
    expect(parseEditArgs(["a.ts", "src/b.ts", "/abs/c.ts"], "/r/ah")).toEqual({
      ok: true,
      files: ["/r/ah/a.ts", "/r/ah/src/b.ts", "/abs/c.ts"],
      line: null,
    })
  })

  test("takes +line, for the first file, as nvim does", () => {
    expect(parseEditArgs(["+12", "a.ts", "b.ts"], "/r")).toEqual({
      ok: true,
      files: ["/r/a.ts", "/r/b.ts"],
      line: 12,
    })
  })

  test("takes no files, as a bare nvim does", () => {
    expect(parseEditArgs([], "/r")).toEqual({ ok: true, files: [], line: null })
  })

  test("needs a file for a +line, and a +line that's a line", () => {
    expect(parseEditArgs(["+12"], "/r")).toMatchObject({ ok: false })
    expect(parseEditArgs(["+x", "a.ts"], "/r")).toMatchObject({ ok: false })
    expect(parseEditArgs(["+0", "a.ts"], "/r")).toMatchObject({ ok: false })
  })
})

describe("editPlan", () => {
  test("opened in the tab's nvim: done", () => {
    expect(editPlan({ opened: true }, { tty: true })).toEqual({ kind: "done" })
    expect(editPlan({ opened: true }, { tty: false })).toEqual({ kind: "done" })
  })

  test("no nvim in the tab: one here for a person, an error for an agent", () => {
    expect(editPlan({ opened: false }, { tty: true })).toEqual({ kind: "nvim" })
    expect(editPlan({ opened: false }, { tty: false })).toMatchObject({ kind: "error" })
  })

  test("outside Rex or with the server down: nvim here for a person, never in the way", () => {
    expect(editPlan(null, { tty: true })).toEqual({ kind: "nvim" })
  })

  test("without a terminal, never an nvim nobody can see", () => {
    expect(editPlan(null, { tty: false })).toMatchObject({ kind: "error" })
  })
})

describe("ah edit --quickfix --from, the list from a file", () => {
  // Run outside Rex, so a list it read stops at needing the tab's nvim
  const run = (args: string[]) => {
    const { REX_BLOCK: _, ...env } = process.env
    return spawnSync(
      process.execPath,
      [AH, "edit", "--quickfix", "tests to review", ...args],
      {
        encoding: "utf8",
        env,
        input: "",
      },
    )
  }
  const dir = mkdtempSync(join(tmpdir(), "ah-quickfix-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("reads the list from the file instead of stdin", () => {
    const list = join(dir, "good.jsonl")
    writeFileSync(list, '{"file":"a.ts","line":3,"text":"fails"}\n')
    const done = run(["--from", list])
    expect(done.stderr).toContain("needs a Rex pane")
    expect(done.status).toEqual(1)
  })

  test("refuses a line it can't read, by its number", () => {
    const list = join(dir, "bad.txt")
    writeFileSync(list, "a.ts:1: fine\nnonsense\n")
    const done = run(["--from", list])
    expect(done.stderr).toContain("line 2")
    expect(done.status).toEqual(2)
  })

  test("says when the file isn't there", () => {
    const done = run(["--from", join(dir, "missing.txt")])
    expect(done.stderr).toContain("missing.txt")
    expect(done.status).toEqual(2)
  })
})
