# Neovim

The markdown editor's editor pane runs the `nvim` on your `PATH` with `ah`'s plugin, [`editors/neovim/`](../editors/neovim/), loaded before your config. You can load the same plugin in your own nvim, so every buffer takes the agent's edits and you can comment to the agent from it.

## What the plugin does

- **Takes the agent's edits.** It checks the file on disk every 300ms and when nvim gains focus. An unmodified buffer reloads. A modified one has the file on disk merged into its unsaved text by `ah view merge --words`, against the text as of the last read or save. Where both changed the same words, both versions are marked, yours first: `{~~yours~>agent's~~}` within a line, git conflict markers across lines. After a merge, `:w` writes without asking whether to write over a file changed since it was read.
- **Stops saving after a failed merge.** If `ah view merge` fails (say `ah` isn't on the `PATH`), the buffer keeps its text and saves stop, so it never writes over the agent's edit. The next change on disk that merges starts them again.
- **Auto-saves in the pane.** In the markdown page's pane (`AH_PANE` set), it saves 650ms after typing stops and when the pane loses focus, since the preview follows the file. Elsewhere it doesn't save on its own. ⌘S saves anywhere a terminal sends it as `<D-s>`.
- **Comments to the agent.** `<leader>ac` comments on the cursor's line, or the selected lines in visual mode, with the selected text. `<leader>aC` comments on the whole file. The comment goes in a float under the lines. Enter sends, Ctrl-J (or Shift- or Alt-Enter) adds a line, and Esc then Esc (or `q`) cancels, as does leaving the float. The file is saved first, so the agent reads the lines the comment is on. After a failed merge, it refuses until a merge succeeds.
- **Picks the agent.** In a Rex pane, the comment goes to an agent in the tab, as `ah message send` picks it. With one, the float's title names it. With several, the title starts on the pane's pick and Tab or Shift-Tab changes it. In the markdown page's pane, outside Rex, the comment goes into the file's thread instead.

- **Tells ah it's there.** In a Rex pane (not the markdown pane), nvim reports starting and quitting with the socket it listens on (`ah hook editor`), so ah can open files in it. `ah debug editors` lists them. The first nvim started in a tab is that tab's nvim, the way an Emacs frame can belong to a project: the dashboard's ⌥-click on a file, and "nvim in this tab" in its open-with menu, open the file there and focus its pane, or a Rex float when the tab has none.
- **`ah edit [+line] <file>…`** is an emacsclient for that nvim: from any shell in the tab, it opens the files in the tab's nvim and focuses it (`--no-focus` leaves the focus alone, for an agent pointing at code). With no nvim in the tab, it runs nvim right there, which becomes the tab's. Without a terminal (an agent) it says the tab has none instead. Alias it: `alias v="ah edit"`.

## Your own nvim

Add the plugin's directory to the runtimepath and call `setup()`:

```lua
local ah_plugin = vim.fn.expand("~/path/to/ah/editors/neovim")
if vim.fn.isdirectory(ah_plugin) == 1 then
  vim.opt.rtp:prepend(ah_plugin)
  require("ah").setup()
end
```

The pane sets the plugin up before your config, and setting it up again is the same as once, so the same lines work in the pane too. The pane sets `AH_PANE=1`, so your config can tell it's there.

## Tests

`editors/neovim/*.test.ts` run the plugin in a headless nvim through nvim's main loop, so typed keys and timers behave as in a real session (`editors/neovim/testing.ts`). They're skipped where `nvim` isn't on the `PATH`.
