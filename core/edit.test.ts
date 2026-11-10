import { describe, expect, test } from "vitest"
import { editPlan, parseEditArgs } from "./edit.ts"

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
