import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, test } from "vitest"
import { detectRunners } from "./detect.ts"

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ah-detect-")))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(path: string, text = "") {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const vitestPackage = JSON.stringify({ devDependencies: { vitest: "^3.0.0" } })

test("a Cargo.toml is cargo, or nextest when it's installed", async () => {
  write("Cargo.toml", "[package]\nname = 'a'\n")
  expect(await detectRunners(root, { nextest: false })).toEqual([
    { kind: "cargo", dir: root },
  ])
  expect(await detectRunners(root, { nextest: true })).toEqual([
    { kind: "nextest", dir: root },
  ])
})

test("a go.mod is go test", async () => {
  write("go.mod", "module example.com/a\n")
  expect(await detectRunners(root, { nextest: false })).toEqual([{ kind: "go", dir: root }])
})

test("a package.json is vitest only when it uses vitest", async () => {
  write("package.json", JSON.stringify({ dependencies: { react: "^19" } }))
  expect(await detectRunners(root, { nextest: false })).toEqual([])
  write("package.json", vitestPackage)
  expect(await detectRunners(root, { nextest: false })).toEqual([
    { kind: "vitest", dir: root },
  ])
})

test("a workspace with several stacks gets each, by directory", async () => {
  write("Cargo.toml", "[workspace]\n")
  write("web/package.json", vitestPackage)
  write("tools/go.mod", "module example.com/tools\n")
  expect(await detectRunners(root, { nextest: false })).toEqual([
    { kind: "cargo", dir: root },
    { kind: "go", dir: join(root, "tools") },
    { kind: "vitest", dir: join(root, "web") },
  ])
})

test("a marker under one of the same stack is part of it", async () => {
  write("Cargo.toml", "[workspace]\nmembers = ['crates/*']\n")
  write("crates/a/Cargo.toml", "[package]\nname = 'a'\n")
  write("go.mod", "module example.com/a\n")
  write("cmd/x/go.mod", "module example.com/x\n")
  expect(await detectRunners(root, { nextest: false })).toEqual([
    { kind: "cargo", dir: root },
    { kind: "go", dir: root },
  ])
})

test("the shallowest package.json that uses vitest is the one", async () => {
  write("package.json", JSON.stringify({ private: true, workspaces: ["packages/*"] }))
  write("packages/app/package.json", vitestPackage)
  expect(await detectRunners(root, { nextest: false })).toEqual([
    { kind: "vitest", dir: join(root, "packages", "app") },
  ])
})

test("dependencies, build output and VCS state aren't searched", async () => {
  for (const dir of ["node_modules/x", "target/debug", ".git/x", ".jj/x", "dist"])
    write(`${dir}/package.json`, vitestPackage)
  expect(await detectRunners(root, { nextest: false })).toEqual([])
})

test("a package.json that isn't JSON is passed over", async () => {
  write("package.json", "{ not json")
  expect(await detectRunners(root, { nextest: false })).toEqual([])
})
