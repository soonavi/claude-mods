# claude-mods

Claude Code mods (plugins of function hooks).

| Mod | What it does |
| --- | --- |
| `usage-line` | Status line: the session's context fill and each usage window's use with a reset countdown. Toasts at 80% and 95% of a window, and at 80% and 90% context. |
| `unpushed-line` | Status line: each repo's uncommitted files and unpushed commits, refreshed after edits, commands and every turn. |
| `limit-parking` | At 95% of a usage window, Claude stops at a safe point, commits, pushes and saves a resume note (`save_note` tool). After the reset, a row above the prompt offers **Resume**. |
| `session-equalizer` | A ten-band equalizer above the prompt that moves with the session's work (read, find, edit, write, shell, test, git, GitHub, web, other). Red on a failure, flat while waiting on you. `/eq` hides it. |

## Loading them

Each folder is one plugin. Point Claude Code at the folders:

- **One session:** `claude --plugin-dir ./usage-line --plugin-dir ./unpushed-line --plugin-dir ./limit-parking --plugin-dir ./session-equalizer`
- **Every session:** set `CLAUDE_CODE_PLUGIN_DIRS` to the four absolute paths, separated by `:` (`;` on Windows), in the process environment or in the `env` block of `~/.claude/settings.json`.
- **Cloud sessions:** give the environment this repo as a source, so each session has a checkout of it, and set `CLAUDE_CODE_PLUGIN_DIRS` as an environment variable to the four folders in that checkout.

## Checking them

```
claude plugin validate <folder>
claude plugin test <folder>
```

Each folder's `tests/` holds its tests (usage-line 5, unpushed-line 8, limit-parking 9, session-equalizer 7).
