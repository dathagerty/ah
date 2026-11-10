// `ah edit [+line] <file>…`: an emacsclient for the tab's nvim. In a Rex
// pane, the files go to the nvim of the pane's tab (the first started there;
// core/registry.ts tabEditor), which takes the focus unless --no-focus. With
// none to hand them to, a person gets nvim in this pane, which becomes the
// tab's, and an agent (no terminal) an error rather than an nvim nobody sees.
// Outside Rex, or with the server down, it runs nvim for a person: it never
// stands between you and editing.

import { Command } from "@commander-js/extra-typings"
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { portOption } from "../platform/cli.ts"

// TODO(david): document parseEditArgs(argv, cwd)
export function parseEditArgs(
  argv: string[],
  cwd: string,
): { ok: true; files: string[]; line: number | null } | { ok: false; error: string } {
  let line: number | null = null
  let rest = argv
  if (argv[0]?.startsWith("+")) {
    const n = Number(argv[0].slice(1))
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: `not a line: ${argv[0]}` }
    line = n
    rest = argv.slice(1)
  }
  // None, as for a bare nvim, but not a line with no file for it
  if (!rest.length && line !== null) return { ok: false, error: "a +line needs a file" }
  return { ok: true, files: rest.map((f) => resolve(cwd, f)), line }
}

export type EditPlan =
  | { kind: "done" }
  | { kind: "nvim" }
  | { kind: "error"; error: string }

// TODO(david): document editPlan(reply, { tty }): what to do once the server
// has answered, or null when there was none to ask
export function editPlan(
  reply: { opened: boolean } | null,
  { tty }: { tty: boolean },
): EditPlan {
  if (reply?.opened) return { kind: "done" }
  if (tty) return { kind: "nvim" }
  // An nvim without a terminal would only hang whoever ran it
  return {
    kind: "error",
    error: reply
      ? "this tab has no nvim to open files in"
      : "couldn't reach the tab's nvim through ah",
  }
}

/** The server's answer, or null outside Rex or when it isn't up */
async function ask(
  port: number,
  body: { block: string; files: string[]; line: number | null; focus: boolean },
): Promise<{ opened: boolean } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/core/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      console.error(`ah: edit refused: ${res.status} ${await res.text()}`)
      return null
    }
    return (await res.json()) as { opened: boolean }
  } catch {
    return null
  }
}

/** nvim in this terminal, exiting as it does */
function runNvim(files: string[], line: number | null): Promise<never> {
  return new Promise(() => {
    const child = spawn("nvim", [...(line ? [`+${line}`] : []), ...files], {
      stdio: "inherit",
    })
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
    child.on("error", (e) => {
      console.error(`ah: couldn't run nvim: ${e.message}`)
      process.exit(1)
    })
  })
}

export const edit = new Command("edit")
  .summary("Open files in the tab's nvim, like emacsclient")
  .description(
    "Open files in the nvim of this Rex tab: the first one started there, which ah's nvim plugin tells it about. It takes the focus unless --no-focus. With no nvim in the tab, nvim runs here and becomes the tab's, or, without a terminal (an agent), it says so and exits 1. Outside Rex, or when the server isn't up, nvim runs here, given a terminal. +line goes to the first file, as in nvim. With no files, the tab's nvim takes the focus, or a bare nvim runs here. For a shell: alias v=\"ah edit\".",
  )
  .argument("[args...]", "[+line] then the files, or none for the tab's nvim as it is")
  .option("--no-focus", "Leave the focus where it is, as an agent pointing at code does")
  .addOption(portOption())
  .action(async (args, { focus, port }) => {
    const parsed = parseEditArgs(args, process.cwd())
    if (!parsed.ok) {
      console.error(`ah: ${parsed.error}`)
      process.exit(2)
    }
    const { files, line } = parsed
    const block = process.env.REX_BLOCK
    const reply = block ? await ask(port, { block, files, line, focus }) : null
    const plan = editPlan(reply, {
      tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    })
    if (plan.kind === "done") return
    if (plan.kind === "error") {
      console.error(`ah: ${plan.error}`)
      process.exit(1)
    }
    await runNvim(files, line)
  })
