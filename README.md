# hamster

**A board for running many Claude Code sessions in parallel — you direct your
attention, it keeps the board honest.**

tmux keeps every session alive (through editor reloads, quits, and crashes);
Claude Code hooks track what each session is doing; a VS Code sidebar shows
the live board and is the entire UI. Hamster never moves your focus for you —
no auto-rotation, no "next task served". You glance, you choose, you jump.

```
 HAMSTER                                    27 sess · 2 need-you · 1 unread · 6 ready
 ◀ prev  ✚ new  ⤓ adopt  ⟲ all  💤 shown  ❗ needs-you  🕐 recent
 ┌──────────────────────────────────────────────────────────────────────┐
 │ ● ·  APG-1929·1957  Proactive sourcing                           2h  │
 │      svc-python ⎇ main · #1265 open #1267 open 🔗1 +5 ▾              │
 │   ◐  APG-1411       SMSFs Companies and Trusts               ⚒2      │
 │      agent-ab2e9d ⎇ apg-1411-subitem-rehome · #1302 open  ▂▂▂▂▂▂▂▂  │
 │   ❓ APG-1585       Salesforce chat widget                      5m   │
 │ 📌 ·  APG-971        Billing integrity                           3d   │
 └──────────────────────────────────────────────────────────────────────┘
  Session Notes ──────────────────────────────────────────────────────────
  Proactive sourcing — d5b00e36
  next: wait for round-5 approvals, then merge order is pipeline→uploads…
```

- **●** a session returned and you haven't seen the response yet (survives you
  walking away; clears when you actually look / type / move on)
- **◐** working (animated shimmer) · **❓** needs you (breathing amber) ·
  **💤** snoozed (hidden behind one toggle) · **⚒N** live subagents
- every row decorates itself from reality: **ticket badges** (from branch +
  PR titles → your issue tracker), **PR chips** (state-aware, click through),
  **worktree chips** (open that checkout in a new window), **artifact chips**
  (pages/recordings/demos the session produced), **per-session notes**
- **F4** jump picker · **F12** command menu · **F3** snooze · **F8** hide-snoozed —
  native VS Code overlays, intercepted before the terminal

## Philosophy

Most multi-agent tooling models the *artifact* (a worktree, a ticket, a PR)
and treats agents as jobs. Hamster models the **session** — the accumulated
context is the asset; branches, PRs, and worktrees are its exhaust, shown as
decoration. And it is strictly **pull-based**: tools that decide where your
attention goes next are jarring; a board that makes state glanceable lets you
decide. (Hamster began life as a "wheel" that auto-rotated you to the oldest
waiting session. That design lost, decisively.)

## How it works

```
 Claude Code hooks (Stop / UserPromptSubmit / Notification / Subagent / PostToolUse)
        │ write                                   ┌────────────────────────┐
        ▼                                         │  VS Code extension     │
 ~/.claude/hamster/*.json  ◄─ reconcile ─┐        │  (webview sidebar,     │
   per-window state · pins · notes ·     │        │   QuickPick overlays)  │
   facts (PRs) · artifacts · pr-cache    │        └──────────┬─────────────┘
        ▲                                │             reads │ acts
        │ statusline (~1s, the ONLY      │        `hamster json`│`hamster <cmd>`
        │ reconciler/writer)  ───────────┘                 ▼
 tmux session "hamster" — one Claude per window, survives everything
```

- One tmux session, one Claude Code session per window. Hooks stamp state
  transitions; a once-a-second reconciler keeps them honest against the
  transcript files (interrupts, missed events, subagent fan-out).
- The extension is a stateless skin: it polls `hamster json` and shells back
  into `hamster` for every action. Kill VS Code and nothing stops.
- PR decoration is two-rail: a PostToolUse hook captures `gh pr create`
  output at creation (never `gh pr list` noise), and a background `gh`
  enrichment resolves states/branches. Artifact publishes are captured the
  same way. Transcript backfills (`backfill_facts.py`,
  `backfill_artifacts.py`) recover history, rerunnable.

## Install

Requirements: tmux, python3, [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
Optional: [gh](https://cli.github.com) for PR chips.

**Just the extension** — grab `claude-hamster-<version>.vsix` from
[releases](https://github.com/davidtedmanjones/claude-hamster/releases):

```sh
code --install-extension claude-hamster-<version>.vsix
```

Everything else is automatic: on first activation the extension installs its
bundled core to `~/.claude/hamster/bin`, wires the Claude Code hooks, and sets
up the F-key passthrough. Click the wheel icon in the activity bar — the
hamster tab creates the tmux session on first use. Run **"Hamster: Install
CLI"** from the command palette if you want the `hamster` command on your
PATH (sessions use it to register artifacts). Extension updates re-sync the
core; the hooks live at a stable path and never break.

**Or from a checkout** (headless tmux board works without VS Code):

```sh
git clone https://github.com/davidtedmanjones/claude-hamster
cd claude-hamster && ./install.sh
```

The installer is idempotent: symlinks `hamster` onto your PATH, wires the
Claude Code hooks, symlinks the extension, adds the F-key passthrough —
everything backed up first. The extension detects a checkout install and
adopts it rather than re-wiring.

Either way, after install:

```sh
hamster start          # create/attach the tmux session (the sidebar does this too)
hamster new ~/proj     # launch a Claude session on the board
hamster adopt <sid>    # or pull in an existing session by id
```

## Companion: claude-resurrect

[`claude-resurrect`](https://github.com/davidtedmanjones/claude-resurrect)
browses and revives Claude Code sessions across every project. Hamster sits
on the same ground truth (the transcript files) and integrates where they
meet: the **adopt** picker offers resurrect's session catalog, and session
names are shared through its name store. Use resurrect to find and revive
anything you ever ran; use hamster to live with the sessions you're running.

## CLI

`hamster` with no arguments prints the full command list — session lifecycle
(`new`, `adopt`, `close`, `restart`), board state (`status`, `json`,
`snooze`, `pin`, `hidesnooze`), naming (`rename`, `ai-name`, `relabel`),
facts (`artifact`, `enrich`), and disaster recovery (`heal` rebuilds every
window after a reboot, names and state intact).

## License

MIT
