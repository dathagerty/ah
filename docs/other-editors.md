# Swapping out the editor

`ah` is not tied to any one editor. The markdown editor's editor pane runs Neovim, with `ah`'s plugin ([neovim.md](neovim.md)), but you can have your coding agent swap in whatever editor you prefer. My original prototype of the markdown editor used [CodeMirror](https://codemirror.net/) and it worked great. Besides Neovim, `ah` has a sample adapter for CodeMirror, which has had only light testing.

There's no setting to pick the editor. [`views/markdown/editor.ts`](../views/markdown/editor.ts) describes what fills the pane: a backend on the server and a component in the page. To switch, select the backend in [`files.ts`](../views/markdown/files.ts) and the page component in [`client.ts`](../views/markdown/client.ts).

## CodeMirror

CodeMirror runs in the page instead of in a terminal. [`codemirror_backend.ts`](../views/markdown/codemirror_backend.ts) and [`codemirror_pane.ts`](../views/markdown/codemirror_pane.ts) are the adapter. I left its npm packages out of `package.json`, so you'll need to add the ones listed at the top of `codemirror_pane.ts`.

## Another terminal editor

[`terminal_editor.ts`](../views/markdown/terminal_editor.ts) describes what the terminal needs from the editor running in it. To use a different terminal editor, implement its server and page halves and pick them in `files.ts` and `client.ts`. [`neovim.ts`](../views/markdown/neovim.ts) and [`neovim_command.ts`](../views/markdown/neovim_command.ts) do this for Neovim: it auto-saves, and merges the agent's edits into unsaved text with `ah view merge`. The page's ⌘-click and the preview following the cursor go over Neovim's RPC socket (`pty.ts`), so another editor would need its own way to do those.

## No editor pane

`ah view open --no-editor` opens the page without the editor pane. The preview and commenting still work, and you edit the file in your usual editor.
