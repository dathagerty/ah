// Jira for the dashboard's Issues tab: a team's current sprint from
// `acli jira workitem search --json`, a ticket's transitions from `twg`, and
// its description, which Jira keeps as Atlassian Document Format (ADF),
// turned into HTML for the page and text for the agent. The HTML is built
// here, every bit of text escaped and links only http(s) or mailto, so it's
// safe to put in the page. No Node imports: the page uses the types.

export interface Issue {
  key: string
  summary: string
  status: string
  /** Jira's status category: to do, in progress, done */
  category: "todo" | "progress" | "done"
  /** Display name only; Jira's account emails stay out of the page */
  assignee: string | null
  type: string
  priority: string
  url: string
}

export interface Transition {
  id: string
  /** What the transition is called */
  name: string
  /** The status it moves to */
  to: string
}

interface Listed {
  key: string
  fields: {
    summary?: string
    status?: { name?: string; statusCategory?: { key?: string } }
    assignee?: { displayName?: string } | null
    issuetype?: { name?: string }
    priority?: { name?: string }
  }
}

const CATEGORY: Record<string, Issue["category"]> = {
  new: "todo",
  indeterminate: "progress",
  done: "done",
}

/** `acli jira workitem search --json`'s tickets; `site` is the Jira host,
 * for links to them */
export function parseIssues(json: string, site: string): Issue[] {
  const listed = (JSON.parse(json) as Listed[] | null) ?? []
  return listed.map(({ key, fields: f }) => ({
    key,
    summary: f.summary ?? "",
    status: f.status?.name ?? "",
    category: CATEGORY[f.status?.statusCategory?.key ?? ""] ?? "todo",
    assignee: f.assignee?.displayName ?? null,
    type: f.issuetype?.name ?? "",
    priority: f.priority?.name ?? "",
    url: `https://${site}/browse/${key}`,
  }))
}

/** `twg jira workitem transitions query -o json` */
export function parseTransitions(json: string): Transition[] {
  const data = (
    JSON.parse(json) as {
      data?: { transitions?: { id: string; name: string; toName?: string }[] }
    }
  ).data
  return (data?.transitions ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    to: t.toName ?? t.name,
  }))
}

interface Node {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: Node[]
}

const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

/** A link's href if it's one the page may follow */
const safeHref = (href: unknown) =>
  typeof href === "string" && /^(https?:|mailto:)/i.test(href) ? href : null

const MARK: Record<string, string> = {
  strong: "strong",
  em: "em",
  code: "code",
  strike: "s",
  underline: "u",
  subsup: "sub",
}

function textHtml(n: Node): string {
  let html = escape(n.text ?? "")
  for (const m of n.marks ?? []) {
    if (m.type === "link") {
      const href = safeHref(m.attrs?.href)
      if (href) html = `<a href="${escape(href)}" target="_blank">${html}</a>`
    } else if (MARK[m.type]) html = `<${MARK[m.type]}>${html}</${MARK[m.type]}>`
  }
  return html
}

const BLOCK: Record<string, string> = {
  paragraph: "p",
  bulletList: "ul",
  orderedList: "ol",
  listItem: "li",
  blockquote: "blockquote",
  table: "table",
  tableRow: "tr",
  tableHeader: "th",
  tableCell: "td",
}

function nodeHtml(n: Node): string {
  const inner = () => (n.content ?? []).map(nodeHtml).join("")
  switch (n.type) {
    case "text":
      return textHtml(n)
    case "hardBreak":
      return "<br>"
    case "rule":
      return "<hr>"
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.level) || 3))
      return `<h${level}>${inner()}</h${level}>`
    }
    case "codeBlock":
      return `<pre><code>${inner()}</code></pre>`
    case "panel":
      return `<div class="adf-panel">${inner()}</div>`
    case "mention":
    case "status":
    case "date":
      return escape(String(n.attrs?.text ?? ""))
    case "emoji":
      return escape(String(n.attrs?.text ?? n.attrs?.shortName ?? ""))
    case "inlineCard":
    case "blockCard": {
      const href = safeHref(n.attrs?.url)
      return href ? `<a href="${escape(href)}" target="_blank">${escape(href)}</a>` : ""
    }
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return '<p class="adf-media">[attachment]</p>'
    default: {
      const tag = BLOCK[n.type]
      return tag ? `<${tag}>${inner()}</${tag}>` : inner()
    }
  }
}

/** A description as HTML, safe to put in the page */
export function adfToHtml(doc: unknown): string {
  const n = doc as Node | null | undefined
  return n?.content ? n.content.map(nodeHtml).join("") : ""
}

function nodeText(n: Node, indent = ""): string {
  const inline = (nodes: Node[] = []) => nodes.map((c) => nodeText(c, indent)).join("")
  switch (n.type) {
    case "text":
      return n.text ?? ""
    case "hardBreak":
      return "\n"
    case "mention":
    case "status":
    case "date":
      return String(n.attrs?.text ?? "")
    case "emoji":
      return String(n.attrs?.text ?? n.attrs?.shortName ?? "")
    case "inlineCard":
    case "blockCard":
      return String(n.attrs?.url ?? "")
    case "bulletList":
    case "orderedList":
      return (n.content ?? [])
        .map((item, i) => {
          const bullet = n.type === "orderedList" ? `${i + 1}. ` : "- "
          return indent + bullet + blocksText(item.content ?? [], `${indent}  `).trimStart()
        })
        .join("\n")
    default:
      return n.content && isBlock(n.content[0])
        ? blocksText(n.content, indent)
        : inline(n.content)
  }
}

const isBlock = (n?: Node) =>
  !!n &&
  !["text", "hardBreak", "mention", "emoji", "status", "date", "inlineCard"].includes(
    n.type,
  )

const blocksText = (nodes: Node[], indent: string) =>
  nodes
    .map((n) => nodeText(n, indent))
    .filter(Boolean)
    .join("\n\n")

/** A description as plain text, for the agent */
export function adfToText(doc: unknown): string {
  const n = doc as Node | null | undefined
  return n?.content ? blocksText(n.content, "") : ""
}

/** What a tracker started from a ticket is for, as the agent gets it */
export function issueGoal(issue: Issue, description: string): string {
  const head = `${issue.key}: ${issue.summary}\n${issue.url}`
  return description ? `${head}\n\n${description}` : head
}
