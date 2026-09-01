# Hamster — VS Code sidebar

A rich sidebar over the [hamster core](../core/) tmux Claude-session system.

**Philosophy: the developer directs attention; hamster keeps
the board.** Hamster tracks session state (working /
needs-you / ready / snoozed) via Claude Code hooks and never moves your focus.
You jump: click a row, F4, `ctrl+alt+j`.

## Architecture

Pure viewer/controller. All state lives in hamster (`~/.claude/hamster/*.json`
+ tmux options); all reads go through `hamster json` (`wheelstate.py`,
read-only — the `statusline` reconciler is the only writer); all actions shell
back into `hamster` / `tmux`. Per-window actions from outside tmux use the
`HAMSTER_TARGET` env override honoured by `cur_target()`.

The webview renderer reconciles rows in place (keyed by target, minimal moves)
so activity animations run continuously: working rows shimmer and spin,
needs-you rows breathe amber, a finishing turn flashes green, a new question
flashes amber, ⚒N pops when the subagent count changes.

## Install

Symlinked into `~/.vscode/extensions/claude-hamster`.
No build step, no dependencies — plain JS. After editing `extension.js`,
"Developer: Reload Window". After editing only the python side, nothing —
the next poll picks it up.

## What a row shows

- state icon: ◐ working (spins) · ❓ needs you (amber edge) · 💤 snoozed (dimmed) · `·` ready
- ticket badge (`ABC-1929·1957+2`) — from branch + PR titles, relevance-ordered
  (branch ticket → open-PR tickets → recent), capped at 3, full list on hover
- ⚒N running subagents · wait-time / snooze-remaining
- detail line (one line, consistent row height): a `dir ⎇ branch` chip + open
  PR chips (terminal ones fill to 3) + a `+N ▾` expander when anything's
  hidden. Expanding a row (accordion, per-row, ephemeral) shows everything as
  wrapped chips: every PR with state + head branch, a 📁 chip when that branch
  is checked out as a worktree (mapped live via `git worktree list`), and
  ticket chips.
- chips are actions: PR → GitHub · ticket → Jira (`hamster.jiraBaseUrl`) ·
  dir/worktree → quick-pick: Open in New Window / Reveal in Finder / Copy Path
- tooltip: target, sid, cwd + branch, PR URLs, last assistant response preview
- activity-bar badge = need-you + ready count

Ordering: the base order is **alphabetical** — a stable shelf where each
session has a home position. **Pinned** sessions (📌 row button, `hamster pin`,
sid-keyed in `~/.claude/hamster/pins.json`) float above the shelf, a–z among
themselves; an engaged lens overrides pinning — a lens is an explicit ask for
a different view. Two mutually-exclusive **lenses** overlay it
(engaged chip = on; click again = back to the shelf): ❗ needs-you (attention →
working → ready → snoozed, a–z within groups, so bands stay stable) and
🕐 recent (last activity first). A **filter box** matches name, ticket and
branch (Esc clears) — search, not scanning, is how you find an old task.
No manual ordering by design: with a churning roster it decays into
accidental order that looks intentional. The 💤 chip hides snoozed rows
(true F8 parity — same tmux option as the tab bar; the active session always
shows).

## Row actions (hover)

📌 pin · 💤 snooze / ⏰ unsnooze · ✨ ai-name ·
⟲ restart claude in place (post claude-update; resumes the sid) ·
✕ close (confirmed). Header: ◀ prev, ✚ new, ⤓ adopt, ⟲ all
(restart every session — idle-only or force).

Clicking a row focuses it: selects the tmux window and reveals the hamster
terminal, created as a **full editor tab** (`hamster.terminalLocation`,
default `editor`). One tab is the viewport; the sidebar is the control surface.

## Session Notes

Second collapsible section: free-text notes for the **active** session
(click a row — the notes follow). Autosaved (debounce + blur + before
switching), keyed by session id at `~/.claude/hamster/notes/<sid>.md`.

## Keybindings (rebindable)

All UI is extension-level — native QuickPick overlays over the whole editor,
never tmux popups. **F4** (global) opens the jump picker; `ctrl+alt+j/p/h`
jump / previous / reveal tab. While a terminal is focused: **F3** snooze
active, **F6** rename active, **F8** hide-snoozed, **F11** new session,
**F12** command menu (every action, active-session aware), **F1/F2** window
step. Terminal-focused keys work via `terminal.integrated.commandsToSkipShell`
entries in user settings — VS Code intercepts them before tmux sees them.
tmux keeps zero UI (no popups/menus/prompts); its only remaining chrome is
the status bar, and F1/F2/F8 remain as bare-terminal fallbacks for attaching
outside VS Code.

## Artifacts

Per-session links and files (published artifact pages, recordings, demo HTML),
sid-keyed at `~/.claude/hamster/artifacts/<sid>.json`. Three rails, mirroring
PRs: the PostToolUse hook captures Artifact-tool publishes (URL shape:
`claude.ai/code/artifact/<id>` — verified against real transcripts — plus the
local source file path); `backfill_artifacts.py` scans transcripts
(tool_result-only precision); `hamster artifact add <url|path> [label]`
records anything else (also in the F12 menu). Collapsed row shows a 🔗N chip;
expanded shows each artifact as a chip — links open in browser, files get an
open / editor / reveal / copy quick-pick. `hamster artifact list|rm <i>`
manages them.

## PR decoration rails

1. `facts-hook.sh` — PostToolUse(Bash) hook in `~/.claude/settings.json`;
   captures ONLY `gh pr create` output (a `gh pr list` mentioning other PRs
   never lands) → `~/.claude/hamster/facts/<sid>.json`.
2. `hamster enrich` — gh backfill (branch → PR, and live state for fact URLs;
   merged/closed are terminal and never re-fetched). Fired here every 5 min.
3. `backfill_facts.py` — rerunnable transcript scan seeding facts for PRs
   created before the hook existed (same precision: pr-create tool_results only).

## Settings

- `hamster.path` — hamster script (default empty = auto-resolve: existing hook wiring, else the bundled core at `~/.claude/hamster/bin`)
- `hamster.terminalName` — the hamster terminal's name (default `hamster`)
- `hamster.terminalLocation` — `editor` (default) or `panel`
- `hamster.pollMs` — poll interval (default 1500)
- `hamster.newSessionDir` — default cwd for ✚ new (default `~`)
