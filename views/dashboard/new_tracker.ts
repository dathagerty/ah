// The dashboard's new-tracker button: the user's goal goes to the focused
// tab's agent, which makes the tracker with the tracker skill, as when asked
// in the terminal. The agent titles it, and its own `ah tracker add` binds
// the tracker to it.

import type { Pane } from "./openers.ts"

/** What the agent gets, after Core.send's line saying it's from the user;
 * null without a goal */
export function trackerMessage(goal: unknown): string | null {
  if (typeof goal !== "string" || !goal.trim()) return null
  return `Start a new tracker for this, with the tracker skill. The goal:\n\n${goal.trim()}`
}

export type Forwarded =
  | { ok: true; status: "sent" | "held" }
  | { ok: false; status: 400 | 404; error: string }

/** Send the goal from the tab's pane, so it reaches the agent that pane
 * sends to, or waits for one (Core.send) */
export async function forwardGoal(
  send: (block: string, text: string) => Promise<"sent" | "held">,
  pane: Pane | null,
  goal: unknown,
): Promise<Forwarded> {
  const message = trackerMessage(goal)
  if (!message) return { ok: false, status: 400, error: "a tracker needs a goal" }
  if (!pane) return { ok: false, status: 404, error: "no pane in the tab" }
  return { ok: true, status: await send(pane.block, message) }
}
