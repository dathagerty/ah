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

/** A float in the tab running nvim on the file, as `openFloat` takes it */
export function nvimFloat(path: string, root: string) {
  return { label: basename(path), command: ["nvim", path], cwd: root }
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
