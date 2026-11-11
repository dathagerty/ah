import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { resolveOp, runOp } from "./ops.ts"

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

test("new on a change starts one on top of it, named as a change ID so a bookmark can't stand in", () => {
  expect(resolveOp({ op: "new", rev: REV })).toEqual({
    ok: true,
    args: ["new", `change_id(${REV})`],
  })
})

test("new with no change starts one on top of the working copy, for the button", () => {
  expect(resolveOp({ op: "new" })).toEqual({ ok: true, args: ["new"] })
})

test("edit makes a change the working copy", () => {
  expect(resolveOp({ op: "edit", rev: REV })).toEqual({
    ok: true,
    args: ["edit", `change_id(${REV})`],
  })
})

test("edit needs a change to edit", () => {
  expect(resolveOp({ op: "edit" })).toMatchObject({ ok: false, status: 400 })
})

test("new and edit take only a change ID, so nothing reaches jj as a flag or a revset", () => {
  for (const op of ["new", "edit"])
    for (const rev of ["@", "main", "--help", "", "kx yz", "KXYZ", `${REV})|all(`, 1])
      expect(resolveOp({ op, rev })).toMatchObject({ ok: false, status: 400 })
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
})
