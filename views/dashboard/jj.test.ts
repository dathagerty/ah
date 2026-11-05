import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Output } from "../../platform/proc.ts"
import { composeLog, logText, MAX_FILES } from "./jj.ts"

const ok = (stdout: string): Output => ({ success: true, code: 0, stdout, stderr: "" })
const failed = (stderr: string): Output => ({ success: false, code: 1, stdout: "", stderr })
const LABEL = "Changes since main:\n"

test("the file list goes above the log under a label, then a blank line", () => {
  expect(composeLog(ok("M a.ts\nA b.md\n"), ok("@  log\n"))).toBe(
    `${LABEL}M a.ts\nA b.md\n\n@  log\n`,
  )
})

test("no changed files shows only the log", () => {
  expect(composeLog(ok(""), ok("@  log\n"))).toBe("@  log\n")
})

test("a failed diff still shows the log", () => {
  expect(composeLog(failed("Error: no such revision\n"), ok("@  log\n"))).toBe("@  log\n")
})

test("a failed log shows jj's message and keeps the file list", () => {
  expect(composeLog(ok("M a.ts\n"), failed("Error: stale workspace\n"))).toBe(
    `${LABEL}M a.ts\n\nError: stale workspace\n`,
  )
})

test("a file list past the cap is cut off with a count of the rest", () => {
  const lines = Array.from({ length: MAX_FILES + 3 }, (_, i) => `M f${i}\n`)
  expect(composeLog(ok(lines.join("")), ok("@  log\n"))).toBe(
    LABEL + lines.slice(0, MAX_FILES).join("") + "… 3 more files\n\n@  log\n",
  )
})

test("a file list exactly at the cap isn't cut off", () => {
  const lines = Array.from({ length: MAX_FILES }, (_, i) => `M f${i}\n`)
  expect(composeLog(ok(lines.join("")), ok("@  log\n"))).toBe(
    LABEL + lines.join("") + "\n@  log\n",
  )
})

const hasJj = spawnSync("jj", ["--version"]).status === 0
const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

describe.skipIf(!hasJj)("logText in a real repo", () => {
  let dir: string
  let repo: string
  const savedConfig = process.env.JJ_CONFIG

  const jj = (...args: string[]) => execFileSync("jj", args, { cwd: repo, stdio: "pipe" })
  // contents differ per file, or jj reads a delete and an add as a rename
  const write = (path: string) => writeFileSync(join(repo, path), `${path}\n`)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ah-jj-"))
    repo = join(dir, "repo")
    // Keep the user's own jj config out; `home` here only reports whether
    // ah turned the links on
    const config = join(dir, "config.toml")
    writeFileSync(
      config,
      [
        "[user]",
        'name = "Test"',
        'email = "test@example.com"',
        "[template-aliases]",
        `home = 'if(config("ah.links").as_boolean(), "links on", "links off") ++ "\\n"'`,
        "[ah]",
        "links = false",
      ].join("\n"),
    )
    process.env.JJ_CONFIG = config
    execFileSync("jj", ["git", "init", repo], { stdio: "pipe" })

    // base, then main moves on to a sibling the work isn't based on
    write("base.txt")
    write("old.txt")
    jj("commit", "-m", "base")
    jj("bookmark", "create", "main", "-r", "@-")
    write("side.txt")
    jj("commit", "-m", "side")
    jj("bookmark", "set", "main", "-r", "@-")

    // the work, from base: one committed rev, then edits in @
    jj("new", "main-")
    write("a.txt")
    jj("commit", "-m", "a")
    write("b.md")
    unlinkSync(join(repo, "base.txt"))
    renameSync(join(repo, "old.txt"), join(repo, "new.txt"))
    jj("util", "snapshot")
  })

  afterAll(() => {
    if (savedConfig === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = savedConfig
    rmSync(dir, { recursive: true, force: true })
  })

  test("lists the files changed since main's fork point, above the log", async () => {
    const text = await logText(repo)
    const [files, log] = text.split("\n\n")
    expect(files).toContain(link("ah:file/a.txt", "a.txt"))
    expect(files).toContain(link("ah:file/b.md", "b.md"))
    expect(log).toContain("links on")
  })

  test("a removed file is listed but not linked", async () => {
    const text = await logText(repo)
    expect(text).toContain("base.txt")
    expect(text).not.toContain("ah:file/base.txt")
  })

  test("a renamed file shows both paths and links the new one", async () => {
    expect(await logText(repo)).toContain(link("ah:file/new.txt", "{old.txt => new.txt}"))
  })

  test("main's own changes on a sibling branch aren't listed", async () => {
    expect(await logText(repo)).not.toContain("side.txt")
  })
})
