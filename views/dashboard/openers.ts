// Opening what a link in the dashboard's jj log points at (links.ts). The
// server belongs to no session, so it runs each opener as if from a pane in
// the clicked tab: the tab's Rex session and one of its blocks in the env.
// `ah view open` then binds the file to that tab's agent, and a diff
// review's `ah message send` reaches it, as when run from that pane.

import { basename } from "node:path"
import type { Tab } from "../../core/model.ts"

/** A pane to run an opener as */
export interface Pane {
  session: string
  block: string
}

/** A command to run, with the Rex env it runs under */
export interface Launch {
  cmd: string
  args: string[]
  cwd: string
  env: { REX_SESSION: string; REX_BLOCK: string }
}

/** The tab's focused pane, or its first when none is focused */
export function paneIn(session: string, tab: Tab): Pane | null {
  const block = tab.focused ?? tab.blocks[0]?.id
  return block ? { session, block } : null
}

/** A float in the tab running nvim on the file, at `line` if given, as
 * `openFloat` takes it */
export function nvimFloat(path: string, root: string, line?: number) {
  const at = line ? [`+${line}`] : []
  return { label: basename(path), command: ["nvim", ...at, path], cwd: root }
}

/** One word to a POSIX shell, whatever's in it */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** skepsis on what the change's stack adds since main, from the same base
 * as the log's file list (jj.ts). Its Send and its page go through ah from
 * the tab's pane, so comments reach that tab's agent. */
export function skepsisLaunch(
  rev: string,
  root: string,
  pane: Pane,
  port: number,
  ah: string[],
  skepsis: string,
): Launch {
  const [node] = ah
  const ahCmd = `${ah.map(shellQuote).join(" ")}`
  return {
    cmd: node,
    args: [
      skepsis,
      "--from",
      `fork_point(coalesce(present(main), trunk()) | ${rev})`,
      "--to",
      rev,
      "--send",
      `jq -r .prompt | ${ahCmd} message send --port ${port}`,
      "--open-cmd",
      `${ahCmd} view open --port ${port} --name skepsis`,
    ],
    cwd: root,
    env: { REX_SESSION: pane.session, REX_BLOCK: pane.block },
  }
}

/** `ah view open` on the file. `ah` is how to run ah: node, its flags, and
 * the script. */
export function docLaunch(
  path: string,
  root: string,
  pane: Pane,
  port: number,
  ah: string[],
): Launch {
  const [cmd, ...rest] = ah
  return {
    cmd,
    args: [...rest, "view", "open", "--port", String(port), path],
    cwd: root,
    env: { REX_SESSION: pane.session, REX_BLOCK: pane.block },
  }
}
