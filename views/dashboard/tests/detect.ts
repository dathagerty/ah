// Which test runners a workspace has, from the files that mark each stack:
// Cargo.toml, go.mod, and a package.json that uses vitest. The dashboard's
// Tests tab (watcher.ts) lists and runs each one.

import { readdir, readFile } from "node:fs/promises"
import { join, sep } from "node:path"

export type RunnerKind = "cargo" | "nextest" | "go" | "vitest"

export interface Runner {
  kind: RunnerKind
  /** Where its marker file is, which the runner runs in */
  dir: string
}

/** Never a project of the workspace's own: dependencies, build output, VCS state */
const SKIPPED = new Set([".git", ".jj", "node_modules", "target", "dist", "vendor"])

/** Deep enough for a monorepo's packages/<name>, without walking a big tree */
const MAX_DEPTH = 4

type Stack = "cargo" | "go" | "vitest"

async function usesVitest(file: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    return ["dependencies", "devDependencies"].some((field) => {
      const deps = pkg[field]
      return typeof deps === "object" && deps !== null && "vitest" in deps
    })
  } catch {
    return false
  }
}

/** The stack a directory's files mark, for each one it marks */
async function stacksIn(dir: string, names: Set<string>): Promise<Stack[]> {
  const stacks: Stack[] = []
  if (names.has("Cargo.toml")) stacks.push("cargo")
  if (names.has("go.mod")) stacks.push("go")
  if (names.has("package.json") && (await usesVitest(join(dir, "package.json"))))
    stacks.push("vitest")
  return stacks
}

/**
 * The workspace's runners, by directory. A marker under a directory that
 * already has the same stack is part of that project (a Cargo workspace's
 * crates, a monorepo's packages), so only the shallowest counts. `nextest`
 * says whether cargo-nextest is installed, to run Rust tests with it.
 */
export async function detectRunners(
  root: string,
  { nextest }: { nextest: boolean },
): Promise<Runner[]> {
  const found: { stack: Stack; dir: string }[] = []
  const covered = (stack: Stack, dir: string) =>
    found.some((f) => f.stack === stack && (dir === f.dir || dir.startsWith(f.dir + sep)))
  // Breadth first, so a shallower marker is found before the ones under it
  let level = [root]
  for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
    const next: string[] = []
    for (const dir of level) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))
      for (const stack of await stacksIn(dir, files))
        if (!covered(stack, dir)) found.push({ stack, dir })
      for (const e of entries)
        if (e.isDirectory() && !SKIPPED.has(e.name)) next.push(join(dir, e.name))
    }
    level = next
  }
  return found
    .map(({ stack, dir }) => ({
      kind: stack === "cargo" && nextest ? ("nextest" as const) : stack,
      dir,
    }))
    .toSorted((a, b) => a.dir.localeCompare(b.dir) || a.kind.localeCompare(b.kind))
}
