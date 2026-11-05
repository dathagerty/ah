import { expect, test } from "vitest"
import type { Tab } from "../../core/model.ts"
import { docLaunch, nvimFloat, paneIn } from "./openers.ts"

const tab = (focused: string | null, ...blocks: string[]): Tab => ({
  id: "tab:1",
  name: "ah",
  focused,
  blocks: blocks.map((id) => ({ id, cwd: "/ws" })),
})

test("a tab's opener runs as its focused pane", () => {
  expect(paneIn("session:1", tab("block:b", "block:a", "block:b"))).toEqual({
    session: "session:1",
    block: "block:b",
  })
})

test("a tab with no focused pane runs its opener as its first", () => {
  expect(paneIn("session:1", tab(null, "block:a", "block:b"))).toEqual({
    session: "session:1",
    block: "block:a",
  })
})

test("a tab with no panes has nowhere to run one", () => {
  expect(paneIn("session:1", tab(null))).toBeNull()
})

test("a doc opens with ah view open from the workspace, as the tab's pane", () => {
  const ah = ["/usr/bin/node", "/opt/ah/ah.ts"]
  expect(
    docLaunch(
      "/ws/notes/a.md",
      "/ws",
      { session: "session:1", block: "block:b" },
      7420,
      ah,
    ),
  ).toEqual({
    cmd: "/usr/bin/node",
    args: ["/opt/ah/ah.ts", "view", "open", "--port", "7420", "/ws/notes/a.md"],
    cwd: "/ws",
    env: { REX_SESSION: "session:1", REX_BLOCK: "block:b" },
  })
})

test("a file opens in nvim from the workspace, in a float named for it", () => {
  expect(nvimFloat("/ws/src/x.ts", "/ws")).toEqual({
    label: "x.ts",
    command: ["nvim", "/ws/src/x.ts"],
    cwd: "/ws",
  })
})
