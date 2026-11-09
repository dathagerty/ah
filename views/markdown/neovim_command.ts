// Neovim's command for the editor pane's terminal (terminal_editor.ts).
//
// The pane's nvim loads ah's plugin (editors/neovim/) before the user's
// config, which may load it again. The plugin keeps to editor.ts's rules:
// in the pane (AH_PANE, set by pty.ts) it saves 650ms after typing stops and
// when the pane loses focus, and in every nvim it merges the agent's edits
// into unsaved text with `ah view merge`. See editors/neovim/lua/ah/merge.lua.

import { assetPath } from "../../platform/assets.ts"
import type { TerminalCommand } from "./terminal_editor.ts"

const PLUGIN = assetPath("editors/neovim")

/** nvim's arguments to open `file` with the plugin set up. The path goes in
 * as a Lua string, escaped for 'runtimepath' (commas separate its entries),
 * rather than through `set rtp^=`, which would need its spaces escaped too,
 * or vim.opt's prepend, which splits it at commas. */
export function neovimArgs(plugin: string, file: string): string[] {
  return [
    // --cmd runs before the file loads, so the first BufReadPost sets the
    // merge base
    "--cmd",
    `lua vim.o.rtp = vim.fn.escape(${JSON.stringify(plugin)}, ",\\\\") .. "," .. vim.o.rtp require("ah").setup()`,
    file,
  ]
}

export const neovimCommand: TerminalCommand = async (file) => ({
  command: "nvim",
  args: neovimArgs(PLUGIN, file),
})
