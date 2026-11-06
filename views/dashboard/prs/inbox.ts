// A PR review's inbox: comments made in skepsis on a PR's diff, which its
// --send command hands to ah in full (skepsis's public JSON contract, v1),
// waiting in the PRs tab for the user to send each to GitHub or the agent;
// and the one GitHub review the ones for GitHub post as, on Submit. Nothing
// reaches GitHub before that. No Node imports: the page uses the types.

export interface SkepsisComment {
  file: string | null
  side: "additions" | "deletions" | null
  /** 1-based and inclusive, in `side`'s numbering */
  lines: [number, number] | null
  text: string
  /** skepsis's plain-text rendering of all of it, for the agent */
  prompt: string
}

export interface InboxComment extends SkepsisComment {
  id: string
  /** Where the user sent it: marked for the review, sent to the agent, or
   * not yet decided */
  to: "github" | "agent" | null
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES"

const isLines = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n >= 1)

/** skepsis's --send JSON, or null for anything else */
export function parseSkepsisComment(json: string): SkepsisComment | null {
  let p: Record<string, unknown>
  try {
    p = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  if (p.version !== 1 || typeof p.text !== "string" || !p.text.trim()) return null
  const file = typeof p.file === "string" ? p.file : null
  const side = p.side === "additions" || p.side === "deletions" ? p.side : null
  if (p.side !== null && p.side !== undefined && !side) return null
  if (p.lines !== null && p.lines !== undefined && !isLines(p.lines)) return null
  return {
    file,
    side,
    lines: isLines(p.lines) ? p.lines : null,
    text: p.text,
    prompt: typeof p.prompt === "string" ? p.prompt : p.text,
  }
}

/** GitHub's side for skepsis's: the new file or the old */
const SIDE = { additions: "RIGHT", deletions: "LEFT" } as const

/** `POST /repos/{owner}/{repo}/pulls/{number}/reviews`'s body: the comments
 * marked for GitHub, on their lines; one on no file joins the review's text */
export function reviewRequest(comments: InboxComment[], event: ReviewEvent, body: string) {
  const forGithub = comments.filter((c) => c.to === "github")
  const general = forGithub
    .filter((c) => !c.file || !c.lines || !c.side)
    .map((c) => c.text.trim())
  const onLines = forGithub.flatMap((c) => {
    if (!c.file || !c.lines || !c.side) return []
    const side = SIDE[c.side]
    const [start, end] = c.lines
    return [
      {
        path: c.file,
        ...(start !== end ? { start_line: start, start_side: side } : {}),
        line: end,
        side,
        body: c.text,
      },
    ]
  })
  return {
    event,
    body: [body.trim(), ...general].filter(Boolean).join("\n\n"),
    comments: onLines,
  }
}
