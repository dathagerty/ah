// A PR's review threads, for sending one to the tab's agent from the PRs
// tab: fetched with GitHub's GraphQL API through `gh api graphql`, and the
// message that carries a thread to the agent. Only what the user sends goes:
// nothing is forwarded on its own. No Node imports: the page uses the types.

import type { Pr } from "./github.ts"

export interface ThreadComment {
  author: string
  /** Its markdown, for the agent */
  body: string
  /** GitHub's rendering of it, sanitized there, for the page to show in a
   * sandboxed frame (comment_doc.ts) */
  html: string
  url: string
}

export interface Thread {
  /** GraphQL node id, for sending it and, later, replying and resolving */
  id: string
  path: string
  /** Where it is now, or where it was left on an outdated thread */
  line: number | null
  resolved: boolean
  outdated: boolean
  comments: ThreadComment[]
}

/** For `gh api graphql -f query=… -F owner= -F name= -F number=` */
export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) { nodes { author { login } body bodyHTML url } }
        }
      }
    }
  }
}`

interface ThreadNode {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  comments: {
    nodes: {
      author: { login: string } | null
      body: string
      bodyHTML?: string
      url: string
    }[]
  }
}

/** The response's threads, unresolved first */
export function parseThreads(json: string): Thread[] {
  const nodes = (
    JSON.parse(json) as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: ThreadNode[] } } } }
    }
  ).data?.repository?.pullRequest?.reviewThreads?.nodes
  const threads = (nodes ?? []).map((n) => ({
    id: n.id,
    path: n.path,
    line: n.line ?? n.originalLine,
    resolved: n.isResolved,
    outdated: n.isOutdated,
    comments: n.comments.nodes.map((c) => ({
      // A deleted account's comments have no author
      author: c.author?.login ?? "ghost",
      body: c.body,
      html: c.bodyHTML ?? "",
      url: c.url,
    })),
  }))
  return [...threads.filter((t) => !t.resolved), ...threads.filter((t) => t.resolved)]
}

/** What the agent gets for a thread the user sent: the PR, where the thread
 * is, and every comment in it, to answer or fix */
export function threadMessage(pr: Pr, thread: Thread): string {
  const at = `${thread.path}${thread.line ? `:${thread.line}` : ""}`
  const where = thread.outdated ? `${at} (outdated: the code may have moved since)` : at
  const comments = thread.comments
    .map((c) => `${c.author}: ${c.body.trim()}\n(${c.url})`)
    .join("\n\n")
  return [
    `A review thread on ${pr.repo}#${pr.number} (${pr.title}), at ${where}.`,
    "Look into it: fix the code if it asks for a change, or tell me what to reply.",
    "",
    comments,
  ].join("\n")
}
