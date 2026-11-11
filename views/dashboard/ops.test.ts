import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { MAIN } from "./jj.ts"
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

test("every op on a change takes only a change ID, so nothing reaches jj as a flag or a revset", () => {
  for (const op of ["new", "edit", "describe", "push"])
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

test("fetch fetches from the remote", () => {
  expect(resolveOp({ op: "fetch" })).toEqual({ ok: true, args: ["git", "fetch"] })
})

test("rebase moves the workspace's stack, from its roots past main, onto main", () => {
  expect(resolveOp({ op: "rebase" })).toEqual({
    ok: true,
    args: ["rebase", "-s", `roots(${MAIN}..@)`, "-d", MAIN],
  })
})

test("push pushes a change under its own generated bookmark, marked as reaching the remote, so there's no Undo", () => {
  expect(resolveOp({ op: "push", rev: REV })).toEqual({
    ok: true,
    args: ["git", "push", "-c", TARGET],
    remote: true,
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

  test("an operation that changes nothing gives nothing to undo, not the operation before it", async () => {
    // jj says "Nothing changed." and records no operation
    const result = await runOp(repo, ["describe", "-m", "from the dashboard"])
    expect(result).toMatchObject({ ok: true, operation: null })
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

describe.skipIf(!hasJj)("catching up with the remote", () => {
  let dir: string
  let origin: string
  let clone: string
  const savedConfig = process.env.JJ_CONFIG

  const jjIn = (cwd: string, ...args: string[]) =>
    execFileSync("jj", args, { cwd, stdio: "pipe", encoding: "utf8" })
  const parentOf = (rev: string) =>
    jjIn(clone, "log", "-r", `${rev}-`, "--no-graph", "-T", "description").trim()
  const run = async (body: object) => {
    const op = resolveOp(body)
    if (!op.ok) throw new Error(op.error)
    return await runOp(clone, op.args)
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ah-ops-remote-"))
    origin = join(dir, "origin")
    clone = join(dir, "clone")
    const config = join(dir, "config.toml")
    writeFileSync(
      config,
      ["[user]", 'name = "Test"', 'email = "test@example.com"'].join("\n"),
    )
    process.env.JJ_CONFIG = config
    execFileSync("jj", ["git", "init", origin], { stdio: "pipe" })
    writeFileSync(join(origin, "a.txt"), "a\n")
    jjIn(origin, "commit", "-m", "old main")
    jjIn(origin, "bookmark", "create", "main", "-r", "@-")
    execFileSync("jj", ["git", "clone", origin, clone], { stdio: "pipe" })

    // The work, on the old main
    jjIn(clone, "new", "main", "-m", "work")
    writeFileSync(join(clone, "b.txt"), "b\n")
    jjIn(clone, "new", "-m", "more work")

    // Main moves on at the remote
    writeFileSync(join(origin, "c.txt"), "c\n")
    jjIn(origin, "commit", "-m", "new main")
    jjIn(origin, "bookmark", "set", "main", "-r", "@-")
  })

  afterAll(() => {
    if (savedConfig === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = savedConfig
    rmSync(dir, { recursive: true, force: true })
  })

  test("fetch then rebase puts the whole stack on the new main", async () => {
    expect(await run({ op: "fetch" })).toMatchObject({ ok: true })
    expect(await run({ op: "rebase" })).toMatchObject({ ok: true })
    expect(parentOf("@")).toBe("work")
    expect(parentOf("@-")).toBe("new main")
  })

  test("rebasing again, with the stack already on main, gives nothing to undo", async () => {
    expect(await run({ op: "rebase" })).toMatchObject({ ok: true, operation: null })
  })

  test("fetching with nothing new gives nothing to undo", async () => {
    expect(await run({ op: "fetch" })).toMatchObject({ ok: true, operation: null })
  })
})

describe.skipIf(!hasJj)("pushing to the remote", () => {
  let dir: string
  let origin: string
  let clone: string
  const savedConfig = process.env.JJ_CONFIG

  const jjIn = (...args: string[]) =>
    execFileSync("jj", args, { cwd: clone, stdio: "pipe", encoding: "utf8" })
  const commitOf = (rev: string) =>
    jjIn("log", "-r", rev, "--no-graph", "-T", "commit_id").trim()
  const changeOf = (rev: string) =>
    jjIn("log", "-r", rev, "--no-graph", "-T", "change_id").trim()
  // The remote's branches, as git sees them: name -> commit
  const remoteBranches = () =>
    new Map(
      execFileSync(
        "git",
        ["--git-dir", origin, "for-each-ref", "--format=%(refname:short) %(objectname)"],
        {
          encoding: "utf8",
        },
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ") as [string, string]),
    )
  const run = async (body: object) => {
    const op = resolveOp(body)
    if (!op.ok) throw new Error(op.error)
    return await runOp(clone, op.args)
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ah-ops-push-"))
    origin = join(dir, "origin.git")
    clone = join(dir, "clone")
    const config = join(dir, "config.toml")
    writeFileSync(
      config,
      ["[user]", 'name = "Test"', 'email = "test@example.com"'].join("\n"),
    )
    process.env.JJ_CONFIG = config
    execFileSync("git", ["init", "--bare", "--quiet", origin])
    execFileSync("jj", ["git", "clone", origin, clone], { stdio: "pipe" })
  })

  afterAll(() => {
    if (savedConfig === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = savedConfig
    rmSync(dir, { recursive: true, force: true })
  })

  test("a pushed change is on the remote, under one generated bookmark", async () => {
    writeFileSync(join(clone, "a.txt"), "a\n")
    jjIn("describe", "-m", "work")
    expect(await run({ op: "push", rev: changeOf("@") })).toMatchObject({ ok: true })
    const branches = remoteBranches()
    expect(branches.size).toBe(1)
    expect([...branches.values()]).toEqual([commitOf("@")])
  })

  test("pushing it again after an amend moves the same bookmark, rather than making another", async () => {
    writeFileSync(join(clone, "a.txt"), "a, amended\n")
    expect(await run({ op: "push", rev: changeOf("@") })).toMatchObject({ ok: true })
    const branches = remoteBranches()
    expect(branches.size).toBe(1)
    expect([...branches.values()]).toEqual([commitOf("@")])
  })

  test("pushing it again with nothing new says why nothing changed", async () => {
    const result = await run({ op: "push", rev: changeOf("@") })
    expect(result).toMatchObject({ ok: true, operation: null })
    if (!result.ok || result.operation !== null) return
    expect(result.message).toMatch(/already matches/)
  })
})
