import { expect, test } from "vitest"
import { adfToHtml, adfToText, issueGoal, parseIssues, parseTransitions } from "./jira.ts"

const issue = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    assignee: { displayName: "Jane Doe", emailAddress: "jane@example.com" },
    issuetype: { name: "Story" },
    priority: { name: "Medium" },
    ...over,
  },
})

test("a sprint's tickets, with status, its category, and who has each", () => {
  const json = JSON.stringify([
    issue("EDGE-1"),
    issue("EDGE-2", {
      status: { name: "ToDo", statusCategory: { key: "new" } },
      assignee: null,
    }),
    issue("EDGE-3", { status: { name: "Done", statusCategory: { key: "done" } } }),
  ])
  expect(parseIssues(json, "cfacorp.atlassian.net")).toEqual([
    {
      key: "EDGE-1",
      summary: "Summary of EDGE-1",
      status: "In Progress",
      category: "progress",
      assignee: "Jane Doe",
      type: "Story",
      priority: "Medium",
      url: "https://cfacorp.atlassian.net/browse/EDGE-1",
    },
    expect.objectContaining({ key: "EDGE-2", category: "todo", assignee: null }),
    expect.objectContaining({ key: "EDGE-3", category: "done" }),
  ])
})

test("only display names come through, not emails", () => {
  expect(JSON.stringify(parseIssues(JSON.stringify([issue("EDGE-1")]), "s"))).not.toContain(
    "jane@example.com",
  )
})

test("a ticket's transitions, as twg lists them", () => {
  const json = JSON.stringify({
    data: {
      transitions: [
        { id: "31", name: "In Progress", toName: "In Progress", category: "In Progress" },
        {
          id: "3",
          name: "Ready for Review",
          toName: "Ready for Feedback",
          category: "In Progress",
        },
      ],
    },
  })
  expect(parseTransitions(json)).toEqual([
    { id: "31", name: "In Progress", to: "In Progress" },
    { id: "3", name: "Ready for Review", to: "Ready for Feedback" },
  ])
})

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content })
const text = (t: string, marks: unknown[] = []) => ({ type: "text", text: t, marks })
const para = (...content: unknown[]) => ({ type: "paragraph", content })

test("a description becomes HTML: headings, marks, lists, code, panels", () => {
  const html = adfToHtml(
    doc(
      {
        type: "heading",
        attrs: { level: 3 },
        content: [text("User Story:", [{ type: "strong" }])],
      },
      { type: "panel", content: [para(text("As "), text("on-call", [{ type: "em" }]))] },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [para(text("one"))] },
          { type: "listItem", content: [para(text("two", [{ type: "code" }]))] },
        ],
      },
      { type: "codeBlock", content: [text("let x = 1")] },
      para(text("a"), { type: "hardBreak" }, text("b")),
    ),
  )
  expect(html).toBe(
    "<h3><strong>User Story:</strong></h3>" +
      '<div class="adf-panel"><p>As <em>on-call</em></p></div>' +
      "<ul><li><p>one</p></li><li><p><code>two</code></p></li></ul>" +
      "<pre><code>let x = 1</code></pre>" +
      "<p>a<br>b</p>",
  )
})

test("a description's text is escaped, and its links are only http(s) or mailto", () => {
  const html = adfToHtml(
    doc(
      para(
        text("<script>x</script> & more"),
        text("ok", [{ type: "link", attrs: { href: "https://example.com/a?b=1&c=2" } }]),
        text("bad", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
        {
          type: "inlineCard",
          attrs: { url: "https://cfacorp.atlassian.net/browse/EDGE-9" },
        },
      ),
    ),
  )
  expect(html).toContain("&lt;script&gt;x&lt;/script&gt; &amp; more")
  expect(html).toContain(
    '<a href="https://example.com/a?b=1&amp;c=2" target="_blank">ok</a>',
  )
  expect(html).not.toContain("javascript:")
  expect(html).toContain("bad")
  expect(html).toContain('href="https://cfacorp.atlassian.net/browse/EDGE-9"')
})

test("mentions, emoji and statuses show their text; unknown nodes show their content", () => {
  const html = adfToHtml(
    doc(
      para(
        { type: "mention", attrs: { text: "@Jane" } },
        text(" "),
        { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } },
        { type: "status", attrs: { text: "BLOCKED" } },
      ),
      { type: "someFutureNode", content: [para(text("still here"))] },
    ),
  )
  expect(html).toContain("@Jane")
  expect(html).toContain("🎉")
  expect(html).toContain("BLOCKED")
  expect(html).toContain("still here")
})

test("a description's plain text, for the agent", () => {
  const d = doc(
    { type: "heading", attrs: { level: 3 }, content: [text("User Story")] },
    para(text("As on-call,"), { type: "hardBreak" }, text("I want alerts.")),
    {
      type: "bulletList",
      content: [{ type: "listItem", content: [para(text("one"))] }],
    },
  )
  expect(adfToText(d)).toBe("User Story\n\nAs on-call,\nI want alerts.\n\n- one")
})

test("starting a tracker from a ticket gives the agent its key, summary, link and description", () => {
  const goal = issueGoal(
    {
      key: "EDGE-1",
      summary: "Alert on stale orders",
      status: "ToDo",
      category: "todo",
      assignee: null,
      type: "Story",
      priority: "Medium",
      url: "https://cfacorp.atlassian.net/browse/EDGE-1",
    },
    "As on-call, I want alerts.",
  )
  expect(goal).toBe(
    "EDGE-1: Alert on stale orders\nhttps://cfacorp.atlassian.net/browse/EDGE-1\n\nAs on-call, I want alerts.",
  )
})

test("a description that's missing or empty is no HTML and no text", () => {
  expect(adfToHtml(null)).toBe("")
  expect(adfToText(undefined)).toBe("")
})
