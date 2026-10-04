# claude-mods

Claude Code mods (plugins of function hooks).

| Mod | What it does |
| --- | --- |
| `usage-line` | Status line: the session's context fill and each usage window's use with a reset countdown. Toasts at 80% and 95% of a window, and at 80% and 90% context. |
| `unpushed-line` | Status line: each repo's uncommitted files and unpushed commits, refreshed after edits, commands and every turn. |
| `limit-parking` | At 95% of a usage window, Claude stops at a safe point, commits, pushes and saves a resume note (`save_note` tool). After the reset, a row above the prompt offers **Resume**. |
| `session-equalizer` | A ten-band equalizer above the prompt that moves with the session's work (read, find, edit, write, shell, test, git, GitHub, web, other). Red on a failure, flat while waiting on you. `/eq` hides it. |
| `reply-line` | The three above as one line at the end of each of Claude's replies: context fill, usage windows and their resets, each repo's unpushed work, and what the turn did (with failures). |

## Which to load where

Status lines, rows above the prompt and toasts are drawn by Claude Code's own interface: the terminal, or the desktop app's Code tab running locally. A cloud session watched from the Claude app or the web has no surface to draw them on, so there use `reply-line` in their place:

- **Cloud sessions:** `limit-parking` and `reply-line`.
- **Terminal / local desktop:** `usage-line`, `unpushed-line`, `limit-parking`, `session-equalizer` (and `reply-line` only if you want the line in replies too).

## Loading them

Each folder is one plugin. Point Claude Code at the folders:

- **One session:** `claude --plugin-dir ./usage-line --plugin-dir ./unpushed-line --plugin-dir ./limit-parking --plugin-dir ./session-equalizer`
- **Every session:** set `CLAUDE_CODE_PLUGIN_DIRS` to the four absolute paths, separated by `:` (`;` on Windows), in the process environment or in the `env` block of `~/.claude/settings.json`.
- **Cloud sessions:** clone this repo in the environment's setup script (`[ -d /home/user/claude-mods ] || git clone --depth 1 https://github.com/soonavi/claude-mods /home/user/claude-mods || true`) and set the environment variable `CLAUDE_CODE_PLUGIN_DIRS=/home/user/claude-mods/limit-parking:/home/user/claude-mods/reply-line`.

## Checking them

```
claude plugin validate <folder>
claude plugin test <folder>
```

Each folder's `tests/` holds its tests (usage-line 5, unpushed-line 8, limit-parking 9, session-equalizer 7, reply-line 5).
