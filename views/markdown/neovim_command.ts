// Neovim's command for the editor pane's terminal (terminal_editor.ts).
//
// The pane's nvim loads ah's plugin (editors/neovim/) before the user's
// config, which may load it again. The plugin keeps to editor.ts's rules:
// in the pane (AH_PANE, set by pty.ts) it saves 650ms after typing stops and
// when the pane loses focus, and in every nvim it merges the agent's edits
// into unsaved text with `ah view merge`. See editors/neovim/lua/ah/merge.lua.
//
// Each pane's nvim also listens on a socket of its own, in a temp directory,
// which the pty backend calls into for the page's reveal (⌘-click in the
// preview; editors/neovim/remote.ts).

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assetPath } from "../../platform/assets.ts"
import type { TerminalCommand } from "./terminal_editor.ts"

const PLUGIN = assetPath("editors/neovim")

/** nvim's arguments to open `file` with the plugin set up, listening on
 * `socket` if given. The path goes in as a Lua string, escaped for
 * 'runtimepath' (commas separate its entries), rather than through `set
 * rtp^=`, which would need its spaces escaped too, or vim.opt's prepend,
 * which splits it at commas. */
export function neovimArgs(plugin: string, file: string, socket?: string): string[] {
  return [
    ...(socket ? ["--listen", socket] : []),
    // --cmd runs before the file loads, so the first BufReadPost sets the
    // merge base
    "--cmd",
    `lua vim.o.rtp = vim.fn.escape(${JSON.stringify(plugin)}, ",\\\\") .. "," .. vim.o.rtp require("ah").setup()`,
    file,
  ]
}

export const neovimCommand: TerminalCommand = async (file) => {
  // A Unix socket's path is limited to about 100 bytes, which the temp dir
  // keeps well under
  const socket = join(await mkdtemp(join(tmpdir(), "ah-nvim-")), "nvim.sock")
  return { command: "nvim", args: neovimArgs(PLUGIN, file, socket), socket }
}
