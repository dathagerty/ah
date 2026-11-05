import { expect, test } from "vitest"
import { forwardGoal, trackerMessage } from "./new_tracker.ts"

test("the message asks for a tracker with the tracker skill, with the goal as written", () => {
  const message = trackerMessage(
    "  Make the log's file list collapsible.\n\nKeep it fast.  ",
  )
  expect(message).toMatch(/tracker skill/)
  expect(message).toContain("Make the log's file list collapsible.\n\nKeep it fast.")
  expect(message?.endsWith("Keep it fast.")).toBe(true)
})

test("there's no message without a goal", () => {
  for (const goal of ["", "   \n ", 42, null, undefined])
    expect(trackerMessage(goal)).toBeNull()
})

const pane = { session: "session:1", block: "block:a" }

test("the goal goes to the agent the tab's pane sends to, and says whether it's waiting", async () => {
  const sent: [string, string][] = []
  const send = async (block: string, text: string) => {
    sent.push([block, text])
    return "held" as const
  }
  expect(await forwardGoal(send, pane, "Build the thing")).toEqual({
    ok: true,
    status: "held",
  })
  expect(sent).toEqual([["block:a", trackerMessage("Build the thing")]])
})

test("an empty goal isn't sent", async () => {
  const send = async () => {
    throw new Error("sent")
  }
  expect(await forwardGoal(send, pane, "  ")).toEqual({
    ok: false,
    status: 400,
    error: "a tracker needs a goal",
  })
})

test("a tab with no pane has no agent to ask", async () => {
  const send = async () => "sent" as const
  expect(await forwardGoal(send, null, "Build the thing")).toEqual({
    ok: false,
    status: 404,
    error: "no pane in the tab",
  })
})
