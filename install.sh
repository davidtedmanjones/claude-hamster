#!/usr/bin/env bash
# claude-hamster installer — idempotent; run it again any time.
#  1. symlinks `hamster` onto your PATH (~/.local/bin)
#  2. wires the Claude Code hooks (~/.claude/settings.json) that keep the board honest
#  3. symlinks the VS Code extension (~/.vscode/extensions)
#  4. adds the F-key commands to VS Code's terminal.integrated.commandsToSkipShell
# Every settings file is backed up beside itself (.bak-claude-hamster) before edits.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say(){ printf '\033[1m%s\033[0m\n' "$*"; }
need(){ command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 — $2"; exit 1; }; }

need tmux "brew install tmux (or your package manager)"
need python3 "required by hamster's state handling"
need claude "https://docs.anthropic.com/en/docs/claude-code"

# 1. PATH
mkdir -p "$HOME/.local/bin"
ln -sfn "$HERE/core/hamster" "$HOME/.local/bin/hamster"
say "✓ hamster -> ~/.local/bin/hamster (make sure ~/.local/bin is on your PATH)"

# 2. Claude Code hooks
python3 - "$HERE" <<'PY'
import json, os, sys
here = sys.argv[1]
p = os.path.expanduser("~/.claude/settings.json")
d = {}
raw = None
try:
    raw = open(p).read()
except Exception:
    pass
if raw is not None:
    try:
        d = json.loads(raw)
    except Exception:
        print("! %s exists but is not valid JSON — not touching it." % p)
        print("  Fix it, then re-run this installer to wire the hooks.")
        raise SystemExit(0)
    open(p + ".bak-claude-hamster", "w").write(raw)
h = d.setdefault("hooks", {})
ham = os.path.join(here, "core", "hamster")
facts = os.path.join(here, "core", "facts-hook.sh")
WANTED = [
    ("UserPromptSubmit", None, ham + " submit-hook"),
    ("Stop", None, ham + " stop-hook"),
    ("Notification", None, ham + " notify-hook"),
    ("SubagentStart", None, ham + " subagent 1"),
    ("SubagentStop", None, ham + " subagent -1"),
    ("PostToolUse", "Bash", facts),
    ("PostToolUse", "Artifact", facts),
]
def strip_stale(entries, needle, cmd):
    """this installer owns hamster wiring: within the event, any hamster-ish
    hook that isn't exactly the wanted command is a stale prior install"""
    for e in entries:
        e["hooks"] = [k for k in e.get("hooks", [])
                      if not (needle in k.get("command", "")
                              and k["command"] != cmd)]
    return [e for e in entries if e.get("hooks")]
for ev, matcher, cmd in WANTED:
    entries = h.setdefault(ev, [])
    tail = cmd.split("/")[-1].split(" ")[0]   # hamster / facts-hook.sh
    h[ev] = entries = strip_stale(entries, "/" + tail, cmd)
    hit = any(any(k.get("command") == cmd for k in e.get("hooks", []))
              and (matcher is None or e.get("matcher") == matcher)
              for e in entries)
    if not hit:
        e = {"hooks": [{"type": "command", "command": cmd, "timeout": 10}]}
        if matcher:
            e["matcher"] = matcher
        entries.append(e)
json.dump(d, open(p, "w"), indent=2)
print("✓ Claude Code hooks wired (~/.claude/settings.json)")
PY

# 3. VS Code extension (skip silently if VS Code isn't set up)
linked=""
for extdir in "$HOME/.vscode/extensions" "$HOME/.vscode-insiders/extensions" \
              "$HOME/.cursor/extensions" "$HOME/.vscode-oss/extensions"; do
  if [ -d "$(dirname "$extdir")" ]; then
    mkdir -p "$extdir"
    ln -sfn "$HERE" "$extdir/claude-hamster"
    say "✓ VS Code extension -> $extdir/claude-hamster (reload the window)"
    linked=1
  fi
done
[ -z "$linked" ] && say "· no ~/.vscode found — skipped the extension (re-run after installing VS Code)"

# 4. VS Code terminal key passthrough (F-keys reach hamster, not the shell)
python3 - <<'PY'
import json, os, sys
cands = [
    "~/Library/Application Support/Code/User/settings.json",             # macOS
    "~/Library/Application Support/Cursor/User/settings.json",
    "~/Library/Application Support/Code - Insiders/User/settings.json",
    "~/Library/Application Support/VSCodium/User/settings.json",
    "~/.config/Code/User/settings.json",                                 # linux
    "~/.config/Cursor/User/settings.json",
    "~/.config/Code - Insiders/User/settings.json",
    "~/.config/VSCodium/User/settings.json",
]
cmds = ["hamster.jump", "hamster.menu", "hamster.snoozeActive",
        "hamster.renameActive", "hamster.hidesnooze", "hamster.new",
        "hamster.stepPrev", "hamster.stepNext", "hamster.prev", "hamster.attach"]
for c in cands:
    p = os.path.expanduser(c)
    if not os.path.exists(p):
        continue
    try:
        d = json.load(open(p))
    except Exception:
        print("· %s isn't strict JSON (comments?) — add these to "
              "terminal.integrated.commandsToSkipShell yourself:\n  %s"
              % (p, ", ".join(cmds)))
        continue
    open(p + ".bak-claude-hamster", "w").write(json.dumps(d, indent=2))
    key = "terminal.integrated.commandsToSkipShell"
    cur = d.get(key, [])
    d[key] = cur + [x for x in cmds if x not in cur]
    json.dump(d, open(p, "w"), indent=4)
    print("✓ editor terminal key passthrough (%s)" % p)
    # no break: a user may run both VS Code and Cursor — patch every editor found
else:
    print("· no VS Code user settings found — skipped key passthrough")
PY

say ""
say "Done. Next:"
say "  1. hamster start            # creates/attaches the tmux session"
say "  2. reload your VS Code window, click the wheel icon in the activity bar"
say "  3. optional: gh CLI for PR chips · davidtedmanjones/claude-resurrect for the adopt catalog"
