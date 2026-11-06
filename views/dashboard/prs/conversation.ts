// A PR's conversation for the PRs tab: its description, then its comments
// and reviews in the order they came, from GitHub's GraphQL API. Line
// comments are review threads (threads.ts); a review that's only their
// wrapper, with no body of its own, is left out here. Each item can go to
// the tab's agent, on the user's say. No Node imports: the page uses the
// types.

import type { Pr } from "./github.ts"

export interface ConversationItem {
  kind: "comment" | "review"
  author: string
  /** A review's verdict; null for a comment */
  state: "approved" | "changes" | "commented" | "dismissed" | null
  /** Its markdown, for the agent */
  body: string
  /** GitHub's rendering, for a sandboxed frame (comment_doc.ts) */
  html: string
  at: string
  url: string
}

export interface Conversation {
  description: { author: string; body: string; html: string }
  items: ConversationItem[]
}

/** For `gh api graphql -f query=… -F owner= -F name= -F number=` */
export const CONVERSATION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author { login } body bodyHTML createdAt
      comments(first: 100) { nodes { author { login } body bodyHTML createdAt url } }
      reviews(first: 100) { nodes { author { login } state body bodyHTML submittedAt url } }
    }
  }
}`

type Author = { login: string } | null

interface Node {
  author: Author
  body: string
  bodyHTML?: string
  url: string
}

const STATE: Record<string, ConversationItem["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
}

// A deleted account's posts have no author
const login = (a: Author) => a?.login ?? "ghost"

export function parseConversation(json: string): Conversation {
  const pr = (
    JSON.parse(json) as {
      data?: {
        repository?: {
          pullRequest?: Node & {
            comments?: { nodes: (Node & { createdAt: string })[] }
            reviews?: { nodes: (Node & { state: string; submittedAt: string })[] }
          }
        } | null
      }
    }
  ).data?.repository?.pullRequest
  if (!pr) return { description: { author: "ghost", body: "", html: "" }, items: [] }
  const comments = (pr.comments?.nodes ?? []).map((c): ConversationItem => ({
    kind: "comment",
    author: login(c.author),
    state: null,
    body: c.body,
    html: c.bodyHTML ?? "",
    at: c.createdAt,
    url: c.url,
  }))
  const reviews = (pr.reviews?.nodes ?? [])
    // A review that only commented, with no text of its own, is just the
    // wrapper for its line comments, which the threads show
    .filter((r) => r.body.trim() || r.state !== "COMMENTED")
    .map((r): ConversationItem => ({
      kind: "review",
      author: login(r.author),
      state: STATE[r.state] ?? "commented",
      body: r.body,
      html: r.bodyHTML ?? "",
      at: r.submittedAt,
      url: r.url,
    }))
  return {
    description: { author: login(pr.author), body: pr.body, html: pr.bodyHTML ?? "" },
    items: [...comments, ...reviews].toSorted((a, b) => a.at.localeCompare(b.at)),
  }
}

const VERDICT: Record<NonNullable<ConversationItem["state"]>, string> = {
  approved: "approved",
  changes: "requested changes",
  commented: "reviewed",
  dismissed: "had a review dismissed",
}

/** What the agent gets for a comment or review the user sent */
export function conversationMessage(pr: Pr, item: ConversationItem): string {
  const who = item.state
    ? `${item.author} ${VERDICT[item.state]}`
    : `${item.author} commented`
  return [
    `On ${pr.repo}#${pr.number} (${pr.title}), ${who}:`,
    "Look into it: change the code if it asks for that, or tell me what to reply.",
    "",
    item.body.trim() || "(no text)",
    `(${item.url})`,
  ].join("\n")
}
