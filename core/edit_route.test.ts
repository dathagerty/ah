// POST /core/edit end to end: a real nvim listening on a socket, registered
// as the nvim in one pane of a Rex tab, and `ah edit` asking from another
// pane in that tab. Rex's tab and focus calls are mocked. Real timers, unlike
// core.test.ts, for the client. Skipped without nvim.

import { type ChildProcess, spawn } from "node:child_process"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attach } from "neovim"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { assetPath } from "../platform/assets.ts"
import { hasNvim } from "../editors/neovim/testing.ts"
import type { RexState } from "./model.ts"
import { emptyRegistry } from "./registry.ts"
import { Core } from "./core.ts"

const focused = vi.hoisted(() => ({ blocks: [] as string[], tabs: [] as string[] }))
vi.mock("../platform/rex.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/rex.ts")>()),
  focusBlock: async (_session: string, block: string) => void focused.blocks.push(block),
  selectTab: async (_session: string, tab: string) => void focused.tabs.push(tab),
}))

/** A logger that says nothing, for the test's own client */
const QUIET = Object.fromEntries(
  ["info", "warn", "error", "debug"]
    .map((k) => [k, () => QUIET])
    .concat([["level", "error"]]),
) as unknown as NonNullable<NonNullable<Parameters<typeof attach>[0]["options"]>["logger"]>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const rex = (tabs: Record<string, string[]>) =>
  ({
    front: null,
    sessions: [
      {
        id: "w",
        selectedTab: null,
        tabs: Object.entries(tabs).map(([id, blocks]) => ({
          id,
          name: id,
          focused: null,
          blocks: blocks.map((t) => ({ id: t, cwd: "/r/ah" })),
        })),
      },
    ],
  }) as RexState

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

let dir: string
let core: Core
beforeEach(async () => {
  focused.blocks = []
  focused.tabs = []
  dir = await mkdtemp(join(tmpdir(), "ah-edit-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  core = new Core(emptyRegistry(), join(dir, "registry.json"))
  core.onRex(rex({ t1: ["block:1", "block:2"], t2: ["block:3"] }))
})

/** A headless nvim with the plugin, listening, registered in `block` */
async function nvimIn(block: string) {
  const sock = join(dir, `${block.replace(":", "-")}.sock`)
  const child: ChildProcess = spawn(
    "nvim",
    [
      "--headless",
      "--clean",
      "--listen",
      sock,
      "--cmd",
      `set rtp^=${assetPath("editors/neovim")}`,
    ],
    { stdio: "ignore" },
  )
  cleanups.push(() => void child.kill())
  for (let i = 0; i < 50 && !(await exists(sock)); i++) await sleep(100)
  core.receive({ kind: "editor", event: "start", block, socket: sock })
  const client = attach({ socket: sock, options: { logger: QUIET } })
  cleanups.push(() => client.close())
  return { sock, client }
}

async function file(name: string) {
  const path = join(dir, name)
  await writeFile(
    path,
    Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  )
  return path
}

const edit = async (body: object) => {
  const res = await core.handle(
    new Request("http://ah/core/edit", { method: "POST", body: JSON.stringify(body) }),
    "edit",
  )
  const text = await res.text()
  // A refusal is text
  return {
    status: res.status,
    body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text,
  }
}

describe.skipIf(!hasNvim)("POST /core/edit", { timeout: 15_000 }, () => {
  test("opens a file in the tab's nvim, at the line, and focuses its pane", async () => {
    const { client } = await nvimIn("block:2")
    const a = await file("a.ts")
    expect(await edit({ block: "block:1", files: [a], line: 12, focus: true })).toEqual({
      status: 200,
      body: { opened: true },
    })
    expect(await client.call("expand", ["%:p"])).toEqual(a)
    expect(await client.request("nvim_win_get_cursor", [0])).toEqual([12, 0])
    expect(focused).toEqual({ blocks: ["block:2"], tabs: ["t1"] })
  })

  test("opens several, the last one showing", async () => {
    const { client } = await nvimIn("block:2")
    const a = await file("a.ts")
    const b = await file("b.ts")
    await edit({ block: "block:1", files: [a, b], line: null, focus: true })
    expect(await client.call("expand", ["%:p"])).toEqual(b)
    expect(await client.call("bufloaded", [a])).toEqual(1)
  })

  test("leaves the focus alone when told to", async () => {
    await nvimIn("block:2")
    const a = await file("a.ts")
    expect(
      (await edit({ block: "block:1", files: [a], line: null, focus: false })).body,
    ).toEqual({
      opened: true,
    })
    expect(focused).toEqual({ blocks: [], tabs: [] })
  })

  test("says when the tab has no nvim", async () => {
    await nvimIn("block:3")
    const a = await file("a.ts")
    expect(
      (await edit({ block: "block:1", files: [a], line: null, focus: true })).body,
    ).toEqual({
      opened: false,
    })
  })

  test("forgets an nvim it can't reach, and says the tab has none", async () => {
    core.receive({
      kind: "editor",
      event: "start",
      block: "block:2",
      socket: join(dir, "gone.sock"),
    })
    const a = await file("a.ts")
    expect(
      (await edit({ block: "block:1", files: [a], line: null, focus: true })).body,
    ).toEqual({
      opened: false,
    })
    expect(core.registry.editors.has("block:2")).toBe(false)
  })

  test("with no files, focuses the tab's nvim", async () => {
    await nvimIn("block:2")
    expect(
      (await edit({ block: "block:1", files: [], line: null, focus: true })).body,
    ).toEqual({
      opened: true,
    })
    expect(focused).toEqual({ blocks: ["block:2"], tabs: ["t1"] })
  })

  test("with no files, still forgets an nvim it can't reach", async () => {
    core.receive({
      kind: "editor",
      event: "start",
      block: "block:2",
      socket: join(dir, "gone.sock"),
    })
    expect(
      (await edit({ block: "block:1", files: [], line: null, focus: true })).body,
    ).toEqual({
      opened: false,
    })
    expect(core.registry.editors.has("block:2")).toBe(false)
    expect(focused).toEqual({ blocks: [], tabs: [] })
  })

  test("refuses a body that isn't one", async () => {
    for (const body of [
      { files: ["/a"], line: null, focus: true },
      { block: "block:1", files: ["a.ts"], line: null, focus: true },
      { block: "block:1", files: ["/a"], line: 0, focus: true },
    ])
      expect((await edit(body)).status).toEqual(400)
  })
})

const quickfix = async (body: object) => {
  const res = await core.handle(
    new Request("http://ah/core/quickfix", { method: "POST", body: JSON.stringify(body) }),
    "quickfix",
  )
  const text = await res.text()
  return {
    status: res.status,
    body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text,
  }
}

describe.skipIf(!hasNvim)("POST /core/quickfix", { timeout: 15_000 }, () => {
  test("fills the list in the tab's nvim, opens it, and focuses its pane", async () => {
    const { client } = await nvimIn("block:2")
    const a = await file("a.ts")
    const items = [{ file: a, line: 4, col: 1, text: "fails" }]
    expect(
      await quickfix({ block: "block:1", title: "tests to review", items, focus: true }),
    ).toEqual({ status: 200, body: { shown: true } })
    expect(await client.call("getqflist", [{ title: 1, size: 1 }])).toEqual({
      title: "tests to review",
      size: 1,
    })
    expect(focused).toEqual({ blocks: ["block:2"], tabs: ["t1"] })
  })

  test("leaves the focus alone when told to", async () => {
    await nvimIn("block:2")
    const a = await file("a.ts")
    const items = [{ file: a, line: 4, col: 1, text: "fails" }]
    expect(
      (await quickfix({ block: "block:1", title: "t", items, focus: false })).body,
    ).toEqual({ shown: true })
    expect(focused).toEqual({ blocks: [], tabs: [] })
  })

  test("says when the tab has no nvim, and forgets one it can't reach", async () => {
    core.receive({
      kind: "editor",
      event: "start",
      block: "block:2",
      socket: join(dir, "gone.sock"),
    })
    const items = [{ file: "/r/a.ts", line: 1, col: 1, text: "x" }]
    expect(
      (await quickfix({ block: "block:1", title: "t", items, focus: true })).body,
    ).toEqual({ shown: false })
    expect(core.registry.editors.has("block:2")).toBe(false)
  })

  test("refuses a body that isn't one", async () => {
    const item = { file: "/r/a.ts", line: 1, col: 1, text: "x" }
    for (const body of [
      { title: "t", items: [item], focus: true },
      { block: "block:1", title: "", items: [item], focus: true },
      { block: "block:1", title: "t", items: [{ ...item, file: "a.ts" }], focus: true },
      { block: "block:1", title: "t", items: [{ ...item, line: 0 }], focus: true },
      { block: "block:1", title: "t", items: [{ ...item, text: 3 }], focus: true },
      { block: "block:1", title: "t", items: "nope", focus: true },
    ])
      expect((await quickfix(body)).status).toEqual(400)
  })
})
