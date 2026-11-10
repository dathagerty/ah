// The page's half of Neovim as a terminal editor (terminal_editor.ts), with
// its name and keys: the editor the pane runs, picked in client.ts. The
// server's half is neovim_command.ts, and the Lua it loads is
// editors/neovim/.

import type { TerminalEditor } from "./terminal_editor.ts"

export const neovim: TerminalEditor = {
  name: "neovim",
  // ⌘S as a kitty keyboard protocol super chord, which Neovim reads as <D-s>
  // and neovim_command.ts maps to a save
  chords: { s: `\x1b[${"s".codePointAt(0)};9u` },
  statusRows: 2,
  // Neovim's default
  scrolloff: 0,
}
