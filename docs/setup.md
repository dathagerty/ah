# Setup

## Prerequisites

`ah` runs on macOS and requires Node 24 or newer and either Claude Code, Codex, or OpenCode. The tools below are needed for particular features; you can skip those features or swap in your own tools.

| Dependency                                                           | Used for                                                             | Skipping or replacing it                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Rex](https://www.superlogical.com/updates/public-testing-beginning) | Dashboard, tab titles, and finding agents in terminal tabs.          | Pages opened directly by an agent work without Rex. Supporting another terminal or multiplexer takes new integration code.                                                                     |
| Xcode Command Line Tools                                             | Native windows.                                                      | Optional for file views: pass `--in tab` to open in a browser tab and skip building the native window app.                                                                                     |
| jj                                                                   | Dashboard workspace discovery and commit log.                        | File views work without it. Replacing it with git requires reworking the dashboard's workspace and log queries.                                                                                |
| [Neovim](neovim.md)                                                  | The embedded editor pane, and merging and comments in your own nvim. | Optional. `--no-editor` keeps the preview and commenting working, or you can switch the editor pane to Helix or the included CodeMirror sample adapter; see [Editor pane](#editor-pane) below. |
| skepsis and jq                                                       | Diff review.                                                         | Optional. Another diff viewer can be connected by having it call `ah message send`. The [skepsis skill](../skills/skepsis/SKILL.md) needs the path to your local checkout.                     |
| An LLM CLI                                                           | Tab-title summaries for Claude Code and Codex.                       | Optional. Without it, tab titles fall back to the directory name. Easy to swap for another command ([Tab titles](#tab-titles)); OpenCode generates its own summaries.                          |

## Installation

Run `npm install` and put `ah.ts` on your `PATH` as `ah`. `ah.ts` has a `#!/usr/bin/env node` shebang so Node 24 can run it directly.

`ah` commands that need the `ah` server will start it if it isn't running, and so will the agent hooks below. The server listens on `127.0.0.1:7420`, and serves HTML pages on `127.0.0.1:7421`. It talks to Rex over Rex's socket, so it has to start outside any agent sandbox. In practice a hook starts it when the first agent session starts. An `ah` command in a sandbox that blocks localhost can't reach or start the server, and exits saying so. Use `ah server status`, `restart`, and `stop` to manage the server.

## Hooks

`ah` uses agent harness hooks to keep track of which agent is running in which Rex pane. Each hook runs `ah hook agent`, which reads the hook payload JSON from stdin.

| Harness     | Command                          | Events                                                                 |
| ----------- | -------------------------------- | ---------------------------------------------------------------------- |
| Claude Code | `ah hook agent --harness claude` | `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`               |
| Codex       | `ah hook agent --harness codex`  | `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`               |
| OpenCode    | none                             | the server follows the event stream from OpenCode's background service |

OpenCode needs no setup. In OpenCode 2, every TUI is a client of one background service that runs all the sessions. The server finds that service through the file OpenCode writes in `~/.local/state/opencode/`, and looks for it again whenever it stops.

For example, the `SessionStart` entry in Claude Code's settings:

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "ah hook agent --harness claude" }] }]
```

Claude Code sessions that bypass permission prompts need [`crossSessionInbound: "accept"`](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages) to receive `ah`'s messages without an approval prompt.

Codex fires `SessionStart` on the first prompt rather than at launch, so a Codex session only shows up in `ah` once you've sent it a prompt.

## Skills

`skills/` contains agent-facing instructions for using the `ah` tools (`markdown`, `html`, `tracker`, and `skepsis`) and for opening panes with `rex split`. Copy or symlink them into your harness's skills directory.

## Editor pane

The editor pane runs the `nvim` on your `PATH` with `ah`'s plugin, which auto-saves and takes the agent's edits; see [neovim.md](neovim.md), which also covers loading the plugin in your own nvim. To use Helix, the included CodeMirror adapter, or no editor pane, see [Swapping out the editor](other-editors.md).

## Tab titles

The server sets each Rex tab's title to its directory name and a few words about what the tab's agent is working on, like `ah | Port tab titles`. If two agents are running in a tab, the title includes both summaries separated by `|`.

The summaries need an LLM CLI. Nothing else in `ah` needs one: without it, the tab title is just the directory name. I use my own CLI, [`ai`](https://github.com/david-crespo/llm-cli). To use another one, like `claude -p`, change `summaryCommand` at the top of [`core/summary.ts`](../core/summary.ts). It receives the system prompt as an argument and a JSON payload on stdin, and prints the label on stdout as plain text, so any CLI works without structured output. OpenCode is an exception: `ah` just uses OpenCode's own session title, so no CLI is needed.

The hooks above trigger the title updates. On each `UserPromptSubmit` event, the server passes the CLI the session's first prompt, its most recent prompts, the agent's last reply, and the previous summary. The system prompt in `core/summary.ts` tells the model to keep the previous summary unless the work has changed. If a summary isn't generated, the server logs a `summary-skipped` line in `~/.local/state/ah/registry-events.jsonl` with the reason, like `ai not found` or `ai exited 1` followed by the CLI's error.

To show a custom label in the tab title instead of the directory name, have zsh run `ah hook shell <label>` on startup and in `chpwd`. Rex sets `REX_BLOCK` to identify the current pane, and subshells started by an agent inherit the agent pane's `REX_BLOCK`. An agent's shell can also pick up your zsh functions, `chpwd` included, so without a check every `cd` the agent ran would relabel its pane. Only interactive shells should run the hook. Here `$title` is whatever label your `.zshrc` computes:

```zsh
if [[ -o interactive && -n $REX_BLOCK ]] && (( $+commands[ah] )); then
  ah hook shell "$title" >/dev/null 2>&1 &!
fi
```
