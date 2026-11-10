import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { resolveLink } from "./links.ts"

let dir: string
let root: string

beforeAll(() => {
  // realpath: the temp dir is under a symlink on macOS (/var -> /private/var)
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-links-")))
  root = join(dir, "ws")
  mkdirSync(join(root, "notes"), { recursive: true })
  mkdirSync(join(root, "src"))
  for (const name of ["a.md", "b.MD", "c.markdown", "d.html", "e.HTM"])
    writeFileSync(join(root, "notes", name), "doc\n")
  writeFileSync(join(root, "src", "x.ts"), "x\n")
  writeFileSync(join(dir, "outside.txt"), "secret\n")
  symlinkSync(join(dir, "outside.txt"), join(root, "escape.txt"))
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("a markdown file opens in the doc editor", async () => {
  expect(await resolveLink(root, { file: "notes/a.md" })).toEqual({
    ok: true,
    target: { open: "doc", path: join(root, "notes", "a.md") },
  })
})

test("markdown and html files open in the doc editor, whatever the extension's case", async () => {
  for (const name of ["b.MD", "c.markdown", "d.html", "e.HTM"])
    expect(await resolveLink(root, { file: `notes/${name}` })).toEqual({
      ok: true,
      target: { open: "doc", path: join(root, "notes", name) },
    })
})

test("any other file opens in nvim, in the dashboard's split", async () => {
  expect(await resolveLink(root, { file: "src/x.ts" })).toEqual({
    ok: true,
    target: { open: "nvim", path: join(root, "src", "x.ts"), in: "split" },
  })
})

test("an ⌥-click opens it in the tab's nvim instead, which falls back to a float", async () => {
  expect(await resolveLink(root, { file: "src/x.ts", float: true })).toEqual({
    ok: true,
    target: { open: "nvim", path: join(root, "src", "x.ts"), in: "tab" },
  })
})

test("the menu's pick says where a file opens, over its default", async () => {
  const x = join(root, "src", "x.ts")
  expect(await resolveLink(root, { file: "src/x.ts", with: "emacs", line: 4 })).toEqual({
    ok: true,
    target: { open: "emacs", path: x, line: 4 },
  })
  expect(await resolveLink(root, { file: "src/x.ts", with: "float" })).toEqual({
    ok: true,
    target: { open: "nvim", path: x, in: "float" },
  })
  expect(await resolveLink(root, { file: "src/x.ts", with: "nvim" })).toEqual({
    ok: true,
    target: { open: "nvim", path: x, in: "split" },
  })
  expect(await resolveLink(root, { file: "src/x.ts", with: "tab", line: 2 })).toEqual({
    ok: true,
    target: { open: "nvim", path: x, in: "tab", line: 2 },
  })
  // A doc can go to nvim or Emacs too
  expect(await resolveLink(root, { file: "notes/a.md", with: "emacs" })).toEqual({
    ok: true,
    target: { open: "emacs", path: join(root, "notes", "a.md") },
  })
})

test("the doc editor is only for docs, and the pick has to be one there is", async () => {
  for (const body of [
    { file: "src/x.ts", with: "doc" },
    { file: "src/x.ts", with: "vim" },
    { file: "src/x.ts", with: 3 },
  ])
    expect(await resolveLink(root, body)).toMatchObject({ ok: false, status: 400 })
  expect(await resolveLink(root, { file: "notes/a.md", with: "doc" })).toMatchObject({
    ok: true,
    target: { open: "doc" },
  })
})

test("a line goes along to nvim and the doc editor", async () => {
  expect(await resolveLink(root, { file: "src/x.ts", line: 13 })).toEqual({
    ok: true,
    target: { open: "nvim", path: join(root, "src", "x.ts"), in: "split", line: 13 },
  })
  expect(await resolveLink(root, { file: "notes/a.md", line: 2 })).toEqual({
    ok: true,
    target: { open: "doc", path: join(root, "notes", "a.md"), line: 2 },
  })
})

test("a line is a whole number from 1", async () => {
  for (const line of [0, -3, 1.5, "13"])
    expect(await resolveLink(root, { file: "src/x.ts", line })).toMatchObject({
      ok: false,
      status: 400,
    })
})

test("float has to be a boolean", async () => {
  expect(await resolveLink(root, { file: "src/x.ts", float: "yes" })).toMatchObject({
    ok: false,
    status: 400,
  })
})

test("a change ID opens in skepsis", async () => {
  expect(await resolveLink(root, { rev: "klxkmyyoslpqtosymxslltykwxsquxon" })).toEqual({
    ok: true,
    target: { open: "skepsis", rev: "klxkmyyoslpqtosymxslltykwxsquxon" },
  })
})

test("a path out of the workspace is refused", async () => {
  for (const file of [
    "../outside.txt",
    "notes/../../outside.txt",
    join(dir, "outside.txt"),
  ])
    expect(await resolveLink(root, { file })).toMatchObject({ ok: false, status: 400 })
})

test("a symlink out of the workspace is refused", async () => {
  expect(await resolveLink(root, { file: "escape.txt" })).toMatchObject({
    ok: false,
    status: 400,
  })
})

test("a file that's gone is not found", async () => {
  expect(await resolveLink(root, { file: "src/gone.ts" })).toMatchObject({
    ok: false,
    status: 404,
  })
})

test("a rev that isn't a change ID is refused", async () => {
  // skepsis runs it through jj, so no revsets or other syntax
  for (const rev of ["main", "@-", "abc123", "klx; rm -rf ~", ""])
    expect(await resolveLink(root, { rev })).toMatchObject({ ok: false, status: 400 })
})

test("a request needs exactly one of file and rev, as a string", async () => {
  for (const body of [{}, { file: "src/x.ts", rev: "klx" }, { file: 1 }, null, "src/x.ts"])
    expect(await resolveLink(root, body)).toMatchObject({ ok: false, status: 400 })
})
