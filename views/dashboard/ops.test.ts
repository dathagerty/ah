import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { readDescription, resolveOp, runOp } from "./ops.ts"

const OP_ID = "5dd5c50018c2a1b3"

test("undo reverts the one operation it names, not whatever is latest", () => {
  expect(resolveOp({ op: "undo", operation: OP_ID })).toEqual({
    ok: true,
    args: ["op", "revert", OP_ID],
  })
})

test("undo refuses anything but an operation ID, so nothing reaches jj as a flag or an op expression", () => {
  for (const operation of ["@", "@-", "--help", "", "5dd5c50018c2 x", OP_ID.toUpperCase()])
    expect(resolveOp({ op: "undo", operation })).toMatchObject({ ok: false, status: 400 })
})

test("an operation the dashboard doesn't offer is refused", () => {
  expect(resolveOp({ op: "abandon", rev: "zzzzzzzz" })).toMatchObject({
    ok: false,
    status: 400,
  })
})

test("a body that isn't an object is refused", () => {
  for (const body of [null, "undo", 1, undefined])
    expect(resolveOp(body)).toMatchObject({ ok: false, status: 400 })
})

const REV = "kxyzqrst"
// One commit, by change ID: not a bookmark of that name, and an error when
// the change is gone or divergent rather than nothing done or a merge made
const TARGET = `exactly(change_id(${REV}), 1)`

test("new on a change starts one on top of it", () => {
  expect(resolveOp({ op: "new", rev: REV })).toEqual({ ok: true, args: ["new", TARGET] })
})

test("new with no change starts one on top of the working copy, for the button", () => {
  expect(resolveOp({ op: "new" })).toEqual({ ok: true, args: ["new"] })
})

test("edit makes a change the working copy", () => {
  expect(resolveOp({ op: "edit", rev: REV })).toEqual({ ok: true, args: ["edit", TARGET] })
})

test("edit needs a change to edit", () => {
  expect(resolveOp({ op: "edit" })).toMatchObject({ ok: false, status: 400 })
})

test("describe sets a change's description, as one argument however it starts", () => {
  expect(resolveOp({ op: "describe", rev: REV, description: "-x" })).toEqual({
    ok: true,
    args: ["describe", "-r", TARGET, "--message=-x"],
  })
})

test("describe with an empty description clears it", () => {
  expect(resolveOp({ op: "describe", rev: REV, description: "" })).toEqual({
    ok: true,
    args: ["describe", "-r", TARGET, "--message="],
  })
})

test("describe needs a change and a description", () => {
  for (const body of [{ rev: REV }, { rev: REV, description: 1 }, { description: "x" }])
    expect(resolveOp({ op: "describe", ...body })).toMatchObject({ ok: false, status: 400 })
})

test("new, edit and describe take only a change ID, so nothing reaches jj as a flag or a revset", () => {
  for (const op of ["new", "edit", "describe"])
    for (const rev of ["@", "main", "--help", "", "kx yz", "KXYZ", `${REV})|all(`, 1])
      expect(resolveOp({ op, rev, description: "x" })).toMatchObject({
        ok: false,
        status: 400,
      })
})

test("reading a description takes only a change ID too", async () => {
  for (const rev of ["@", "main", "--help", "", `${REV})|all(`])
    expect(await readDescription("/nonexistent", rev)).toMatchObject({
      ok: false,
      status: 400,
    })
})

const hasJj = spawnSync("jj", ["--version"]).status === 0

describe.skipIf(!hasJj)("runOp in a real repo", () => {
  let dir: string
  let repo: string
  const savedConfig = process.env.JJ_CONFIG

  const jj = (...args: string[]) =>
    execFileSync("jj", args, { cwd: repo, stdio: "pipe", encoding: "utf8" })
  const latestOp = () => jj("op", "log", "-n", "1", "--no-graph", "-T", "id").trim()
  const description = (rev: string) =>
    jj("log", "-r", rev, "--no-graph", "-T", "description").trim()
  const changeId = (rev: string) =>
    jj("log", "-r", rev, "--no-graph", "-T", "change_id").trim()

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ah-ops-"))
    repo = join(dir, "repo")
    const config = join(dir, "config.toml")
    writeFileSync(
      config,
      ["[user]", 'name = "Test"', 'email = "test@example.com"'].join("\n"),
    )
    process.env.JJ_CONFIG = config
    execFileSync("jj", ["git", "init", repo], { stdio: "pipe" })
  })

  afterAll(() => {
    if (savedConfig === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = savedConfig
    rmSync(dir, { recursive: true, force: true })
  })

  test("an operation that works gives back the ID of the operation it made, for Undo", async () => {
    const result = await runOp(repo, ["describe", "-m", "from the dashboard"])
    expect(result).toEqual({ ok: true, operation: latestOp() })
  })

  test("an operation that fails gives back jj's message, without color, for the toast", async () => {
    const result = await runOp(repo, ["edit", "nosuchrev"])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/nosuchrev/)
    expect(result.error).not.toContain("\x1b[")
  })

  test("Undo after a later operation reverts only the dashboard's, keeping the later one", async () => {
    const made = await runOp(repo, ["describe", "-m", "to undo"])
    if (!made.ok) throw new Error(made.error)
    // Something else lands first: an agent's command, or the snapshot watcher
    jj("new", "-m", "later")

    const undo = resolveOp({ op: "undo", operation: made.operation })
    if (!undo.ok) throw new Error(undo.error)
    expect(await runOp(repo, undo.args)).toMatchObject({ ok: true })

    expect(description("@-")).toBe("from the dashboard")
    expect(description("@")).toBe("later")
  })

  test("edit goes to the change even when a bookmark has its ID for a name", async () => {
    const target = changeId("@-")
    // jj resolves a bare symbol as a bookmark before a change ID
    jj("bookmark", "create", target, "-r", "@")
    const edit = resolveOp({ op: "edit", rev: target })
    if (!edit.ok) throw new Error(edit.error)
    expect(await runOp(repo, edit.args)).toMatchObject({ ok: true })
    expect(changeId("@")).toBe(target)
  })

  const run = async (body: object) => {
    const op = resolveOp(body)
    if (!op.ok) throw new Error(op.error)
    return await runOp(repo, op.args)
  }

  test("a description with a body, quotes and a leading dash lands as written, and reads back the same", async () => {
    const rev = changeId("@")
    const description = '-feat: the "dashboard" describes\n\nWith a body.\n\nAnd another.'
    expect(await run({ op: "describe", rev, description })).toMatchObject({ ok: true })
    expect(await readDescription(repo, rev)).toEqual({ ok: true, description })
  })

  test("a change with no description reads as empty, for an empty dialog", async () => {
    jj("new")
    expect(await readDescription(repo, changeId("@"))).toEqual({
      ok: true,
      description: "",
    })
  })

  describe("a change that's gone since the log showed it", () => {
    let gone: string
    beforeAll(() => {
      jj("new", "-m", "soon gone")
      gone = changeId("@")
      jj("abandon", "@")
    })

    test("can't be read, rather than reading as empty", async () => {
      expect(await readDescription(repo, gone)).toMatchObject({ ok: false })
    })

    test("can't be described, rather than jj describing nothing and calling it done", async () => {
      expect(await run({ op: "describe", rev: gone, description: "x" })).toMatchObject({
        ok: false,
      })
    })
  })
})
