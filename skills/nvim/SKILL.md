---
name: nvim
description: "Point the user at code in the nvim of their Rex tab, and hand them quickfix lists of what needs them there: tests to review at a red step, decisions to check and open questions after green, answers to comments about particular lines, review findings, failing checks. Use when explaining a spot in the code, at each red and green stop, after answering a comment the user sent from nvim, or when the user mentions their editor, nvim or the quickfix list."
---

# The tab's nvim

Each Rex tab has one nvim that's the project's, like an Emacs frame per
project: the first started in the tab that's still running. `ah edit` opens
files and fills quickfix lists in it. The user reads the lists with `]q`, and
moves between them with `:colder`, `:cnewer` and `:chistory`.

Run every `ah` command as the whole Bash command, as the html skill says (in
Claude Code: no pipes, redirects or `$`), or it runs in the sandbox and
fails. That's why lists go in a file first.

## Pointing at code

```
ah edit --no-focus +42 src/thing.ts
```

Opens the file at the line in the tab's nvim and leaves the focus where it
is. Do this when explaining a spot, so the user has it in front of them.
Leave out `--no-focus` only when the user asks to be taken there.

If it says the tab has no nvim and exits 1, say so in a line and go on. Don't
start one: nvim run without a terminal is no use to anyone.

## Lists of what needs the user

Write the entries to a file in the scratchpad, one JSON object per line, with
`line` and `col` 1-based and `col` optional:

```
{"file": "core/edit.ts", "line": 77, "text": "fails: --from isn't an option yet"}
{"file": "core/edit.test.ts", "line": 120, "text": "passes, as a guard: no Rex pane"}
```

`file:line[:col]: text` lines work too, as compilers and `rg --vimgrep` print
them. Relative paths are from where `ah` runs. Then:

```
ah edit --quickfix 'tests to review' --no-focus --from /path/to/scratchpad/tests.jsonl
```

A list with that title is replaced, not added again, so keep to these titles
and fill a list again whenever it changes. Fill it with an empty file once
nothing in it is left for the user.

| Title                | When                                                                     | An entry                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests to review`    | at a red step                                                            | each new or changed test, at its `test(` line: what it expects, and why it fails, or that it passes on purpose as a guard                   |
| `decisions to check` | after green                                                              | where the work went a way the plan didn't say: a deviation, a dropped behavior, a guess at something untested. At the code, with the reason |
| `open questions`     | when asking the user something                                           | the question, at the lines it's about                                                                                                       |
| `answers`            | after answering a comment the user sent from nvim about particular lines | the gist of the answer, at those lines. The full answer stays in the terminal, as always                                                    |
| `review findings`    | after a code review                                                      | one per finding, at its code                                                                                                                |
| `failing checks`     | when a test, type or lint failure is the user's to look at               | the failure, at its line. Not the ones you're fixing yourself                                                                               |

Say what you filled in a line in the terminal ("4 in 'tests to review'"), so
the user knows to look. Keep `--no-focus` unless they asked: a list arriving
shouldn't pull them out of what they're doing.

If the tab has no nvim, the command says so and exits 1. Mention it once,
and keep the content in the terminal as usual.
