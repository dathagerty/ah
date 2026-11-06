import { expect, test } from "vitest"
import type { Tab } from "../../core/model.ts"
import {
  docLaunch,
  emacsCommands,
  nvimFloat,
  paneIn,
  shellQuote,
  skepsisDiffLaunch,
  skepsisLaunch,
} from "./openers.ts"

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

test("nvim in a float starts at the line, when there is one", () => {
  expect(nvimFloat("/ws/src/x.ts", "/ws", 13).command).toEqual([
    "nvim",
    "+13",
    "/ws/src/x.ts",
  ])
})

test("a file opens in nvim from the workspace, in a float named for it", () => {
  expect(nvimFloat("/ws/src/x.ts", "/ws")).toEqual({
    label: "x.ts",
    command: ["nvim", "/ws/src/x.ts"],
    cwd: "/ws",
  })
})

test("a change opens in skepsis from main's fork point, sending back through the tab's pane", () => {
  const ah = ["/usr/bin/node", "/opt/ah/ah.ts"]
  const pane = { session: "session:1", block: "block:b" }
  expect(skepsisLaunch("klxk", "/ws", pane, 7420, ah, "/opt/skepsis/cli.ts")).toEqual({
    cmd: "/usr/bin/node",
    args: [
      "/opt/skepsis/cli.ts",
      "--from",
      "fork_point(coalesce(present(main), trunk()) | klxk)",
      "--to",
      "klxk",
      "--send",
      "jq -r .prompt | '/usr/bin/node' '/opt/ah/ah.ts' message send --port 7420",
      "--open-cmd",
      "'/usr/bin/node' '/opt/ah/ah.ts' view open --port 7420 --name skepsis",
    ],
    cwd: "/ws",
    env: { REX_SESSION: "session:1", REX_BLOCK: "block:b" },
  })
})

test("shellQuote keeps spaces and quotes in one word", () => {
  expect(shellQuote("/Applications/My App/node")).toBe("'/Applications/My App/node'")
  expect(shellQuote("it's")).toBe("'it'\\''s'")
})

test("Emacs opens the file in the frame there is, at the line, then comes forward", () => {
  expect(emacsCommands("/ws/src/x.ts", 13)).toEqual([
    ["-a", "", "-r", "-n", "+13", "/ws/src/x.ts"],
    ["-n", "--eval", "(select-frame-set-input-focus (selected-frame))"],
  ])
  expect(emacsCommands("/ws/src/x.ts")[0]).toEqual(["-a", "", "-r", "-n", "/ws/src/x.ts"])
})

test("a path that looks like a flag or Lisp stays a file name", () => {
  const [open] = emacsCommands('/ws/--eval (shell-command "x").ts')
  expect(open.at(-1)).toBe('/ws/--eval (shell-command "x").ts')
  expect(open).not.toContain("--eval")
})

test("a review's skepsis runs in its workspace on the diff it's given", () => {
  const ah = ["/usr/bin/node", "/opt/ah/ah.ts"]
  const pane = { session: "session:1", block: "block:b" }
  const launch = skepsisDiffLaunch(
    "fork_point(main@upstream | ah-review/x-1)",
    "ah-review/x-1",
    "/state/ah/reviews/x-1",
    pane,
    7420,
    ah,
    "/opt/skepsis/cli.ts",
  )
  expect(launch.cwd).toBe("/state/ah/reviews/x-1")
  expect(launch.args.slice(0, 5)).toEqual([
    "/opt/skepsis/cli.ts",
    "--from",
    "fork_point(main@upstream | ah-review/x-1)",
    "--to",
    "ah-review/x-1",
  ])
  expect(launch.env).toEqual({ REX_SESSION: "session:1", REX_BLOCK: "block:b" })
})
