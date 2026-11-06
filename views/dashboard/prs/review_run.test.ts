import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { ReviewPlan } from "./review.ts"
import { bringIn, cleanUp, reviewWorkspaces } from "./review_run.ts"

const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0

describe.skipIf(!has("jj") || !has("git"))(
  "reviewing a PR in a workspace of its own",
  () => {
    let dir: string
    let clone: string
    let reviews: string
    let plan: ReviewPlan
    let headsBefore: string
    const savedConfig = process.env.JJ_CONFIG

    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" })
    const jj = (...args: string[]) =>
      execFileSync("jj", args, { cwd: clone, stdio: "pipe", encoding: "utf8" })

    beforeAll(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "ah-review-")))
      const config = join(dir, "jj.toml")
      writeFileSync(config, '[user]\nname = "Test"\nemail = "test@example.com"\n')
      process.env.JJ_CONFIG = config
      // A remote with main, and a PR's head at refs/pull/7/head as GitHub keeps it
      const remote = join(dir, "remote.git")
      git(dir, "init", "--bare", "-b", "main", remote)
      const seed = join(dir, "seed")
      git(dir, "init", "-b", "main", seed)
      const commit = (file: string, msg: string) => {
        writeFileSync(join(seed, file), `${file}\n`)
        git(seed, "add", file)
        git(seed, "-c", "user.name=T", "-c", "user.email=t@e", "commit", "-m", msg)
      }
      commit("base.txt", "base")
      git(seed, "push", remote, "main")
      git(seed, "checkout", "-b", "theirs")
      commit("theirs.txt", "their change")
      git(seed, "push", remote, "theirs:refs/pull/7/head")
      clone = join(dir, "clone")
      execFileSync("jj", ["git", "clone", "--colocate", remote, clone], { stdio: "pipe" })
      reviews = join(dir, "reviews")
      mkdirSync(reviews)
      plan = {
        name: "review-acme-widgets-7",
        bookmark: "ah-review/acme-widgets-7",
        dir: join(reviews, "acme-widgets-7"),
        remote: "origin",
        base: "main",
        number: 7,
        from: "fork_point(main@origin | ah-review/acme-widgets-7)",
        to: "ah-review/acme-widgets-7",
      }
    })

    afterAll(() => {
      if (savedConfig === undefined) delete process.env.JJ_CONFIG
      else process.env.JJ_CONFIG = savedConfig
      rmSync(dir, { recursive: true, force: true })
    })

    test("bringing it in makes the workspace at the PR's head, and leaves @ alone", async () => {
      const before = jj("log", "-r", "@", "--no-graph", "-T", "commit_id")
      headsBefore = jj(
        "log",
        "-r",
        "visible_heads()",
        "--no-graph",
        "-T",
        'change_id ++ "\\n"',
      )
      expect(await bringIn(plan, clone)).toBeNull()
      expect(readFileSync(join(plan.dir, "theirs.txt"), "utf8")).toBe("theirs.txt\n")
      expect(await reviewWorkspaces(clone)).toEqual(["review-acme-widgets-7"])
      expect(jj("bookmark", "list", "-T", 'name ++ "\\n"')).toContain(
        "ah-review/acme-widgets-7",
      )
      expect(jj("log", "-r", "@", "--no-graph", "-T", "commit_id")).toBe(before)
      // The diff skepsis gets is only the PR's change
      const diff = jj("diff", "--from", plan.from, "--to", plan.to, "--name-only")
      expect(diff.trim()).toBe("theirs.txt")
    })

    test("bringing it in again keeps the workspace there is", async () => {
      expect(await bringIn(plan, clone)).toBeNull()
      expect(await reviewWorkspaces(clone)).toEqual(["review-acme-widgets-7"])
    })

    test("a directory that isn't a review's is refused, and left alone", async () => {
      const elsewhere = join(dir, "seed")
      expect(await cleanUp(plan.name, plan.bookmark, elsewhere, clone, reviews)).toMatch(
        /not/,
      )
      expect(existsSync(join(elsewhere, "base.txt"))).toBe(true)
    })

    test("cleaning up takes away the workspace, its directory and the bookmark", async () => {
      expect(await cleanUp(plan.name, plan.bookmark, plan.dir, clone, reviews)).toBeNull()
      expect(existsSync(plan.dir)).toBe(false)
      expect(await reviewWorkspaces(clone)).toEqual([])
      expect(jj("bookmark", "list", "-T", 'name ++ "\\n"')).not.toContain("ah-review/")
      // Nothing of the review's is left as a head, not even its working copy
      expect(
        jj("log", "-r", "visible_heads()", "--no-graph", "-T", 'change_id ++ "\\n"'),
      ).toBe(headsBefore)
    })
  },
)
