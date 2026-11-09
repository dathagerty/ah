// What the editor pane's terminal (editor.ts) needs from the editor running
// in it, for the pty backend (pty.ts) and the terminal pane
// (terminal_pane.ts). The pane runs Neovim (neovim_command.ts on the server,
// neovim.ts in the page), picked in files.ts and client.ts. Helix
// (helix_command.ts, helix.ts) is the other one ah has; swapping those two
// imports back runs it. Each editor's two halves are separate files because
// the page's half is bundled for the browser.

/** The command that opens `file` in the editor. It has to set the editor up
 * to keep to the rules in editor.ts: save soon after typing stops, and reload
 * or merge the agent's edits on disk. `socket` is where it listens for RPC,
 * for an editor that does (Neovim): the pty backend calls into it there. */
export type TerminalCommand = (
  file: string,
) => Promise<{ command: string; args: string[]; socket?: string }>

export interface TerminalEditor {
  /** Shown in the notice when the editor exits */
  name: string
  /** ⌘-chords that go to the editor instead of the page, by key, as the
   * bytes to send. xterm.js doesn't encode ⌘ chords. */
  chords: Record<string, string>
  /** "rpc" for an editor whose command gives a socket: the page asks the
   * server to reveal a line there, and goto and lower go unused. Otherwise
   * the page types goto and lower. */
  reveal?: "rpc"
  /** Keys that put the cursor at `line` and `column` (0-based) from any mode,
   * with that line at the top of the view, or as near as the editor goes */
  goto(line: number, column: number): string
  /** Keys that move the view so the cursor's line shows `rows` rows lower,
   * leaving the cursor on it */
  lower(rows: number): string
  /** Rows below the text (status line, command line) */
  statusRows: number
  /** The fewest rows the editor keeps between the cursor and the top or
   * bottom of the view */
  scrolloff: number
}
