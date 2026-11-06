// Running review.ts's plans: bringing a PR into a jj workspace of its own,
// listing the review workspaces a repo has, and cleaning one up. Cleanup
// deletes a directory, so it only ever deletes one isReviewDir says ah made.

import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { run } from "../../../platform/proc.ts"
import { bringInCommands, cleanupCommands, isReviewDir, type ReviewPlan } from "./review.ts"

const message = (o: { stderr: string; stdout: string; code: number | null }) =>
  o.stderr.trim() || o.stdout.trim() || `exited with ${o.code}`

/** The repo's review workspaces, by name */
export async function reviewWorkspaces(root: string): Promise<string[]> {
  const o = await run("jj", ["workspace", "list", "-T", 'name ++ "\\n"'], { cwd: root })
  return o.success
    ? o.stdout
        .split("\n")
        .filter((n) => n.startsWith("review-"))
        .toSorted()
    : []
}

/** Fetch the PR and add its workspace, unless it's there already. Returns
 * null, or why it couldn't. */
export async function bringIn(plan: ReviewPlan, root: string): Promise<string | null> {
  if (existsSync(plan.dir) && (await reviewWorkspaces(root)).includes(plan.name))
    return null
  const gitRoot = await run("jj", ["git", "root"], { cwd: root })
  if (!gitRoot.success) return message(gitRoot)
  for (const [cmd, args] of bringInCommands(plan, gitRoot.stdout.trim())) {
    const o = await run(cmd, args, { cwd: root })
    if (!o.success) return `${cmd} ${args[0]}: ${message(o)}`
  }
  return null
}

/** Take a review away again: its workspace's commit, the workspace, the
 * bookmark, and its directory, which has to be one ah made. Returns null,
 * or why it couldn't. */
export async function cleanUp(
  name: string,
  bookmark: string,
  dir: string,
  root: string,
  reviewsRoot: string,
): Promise<string | null> {
  if (!isReviewDir(dir, reviewsRoot)) return `${dir} is not a review's directory`
  if (!name.startsWith("review-") || !bookmark.startsWith("ah-review/"))
    return `${name} is not a review`
  // Each goes on regardless: one already gone mustn't keep the rest
  const failed: string[] = []
  for (const [cmd, args] of cleanupCommands(name, bookmark)) {
    const o = await run(cmd, args, { cwd: root })
    if (!o.success) failed.push(`${cmd} ${args.join(" ")}: ${message(o)}`)
  }
  await rm(dir, { recursive: true, force: true })
  return failed.length && (await reviewWorkspaces(root)).includes(name)
    ? failed.join("\n")
    : null
}
