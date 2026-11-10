// What the editor pane's terminal (editor.ts) needs from the editor running
// in it, for the pty backend (pty.ts) and the terminal pane
// (terminal_pane.ts). The pane runs Neovim (neovim_command.ts on the server,
// neovim.ts in the page), picked in files.ts and client.ts. Its command gives
// an RPC socket, which the backend calls into for the page's reveal
// (⌘-click in the preview) and to follow the cursor. Each editor's two
// halves are separate files because the page's half is bundled for the
// browser.

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
  /** Rows below the text (status line, command line) */
  statusRows: number
  /** The fewest rows the editor keeps between the cursor and the top or
   * bottom of the view */
  scrolloff: number
}
