#!/usr/bin/env bash
# Hermetic board lifecycle test: isolated tmux server (own socket), temp state
# + transcript dirs, fake claude. Never touches the real board.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
H="$HERE/../core/hamster"

export HAMSTER_SOCKET="hamtest$$"
export HAMSTER_TMUX_SESSION="hamtest"
export HAMSTER_DIR="$(mktemp -d)"
export HAMSTER_PROJECTS="$(mktemp -d)"
FAKE="$(mktemp -d)/claude"
printf '#!/bin/sh\nsleep 600\n' > "$FAKE" && chmod +x "$FAKE"
export HAMSTER_CLAUDE_CMD="$FAKE"

fails=0
cleanup(){ tmux -L "$HAMSTER_SOCKET" kill-server 2>/dev/null; rm -rf "$HAMSTER_DIR" "$HAMSTER_PROJECTS" "$(dirname "$FAKE")"; }
trap cleanup EXIT
say(){ printf '  %s\n' "$*"; }
check(){ # check <desc> <python-expr over board json as d>
  local desc="$1" expr="$2"
  if "$H" json | EXPR="$expr" python3 -c '
import json,os,sys
d=json.load(sys.stdin)
sys.exit(0 if eval(os.environ["EXPR"]) else 1)'; then say "ok: $desc"
  else say "FAIL: $desc"; fails=$((fails+1)); "$H" json | head -c 400; echo; fi
}

# ── lifecycle ──
"$H" new /tmp t1 >/dev/null
T="hamtest:1"; SID="itest-0000-4000-8000-000000000001"
check "new session on the board" "any(w['target']=='$T' for w in d['windows'])"

# fabricate the session's transcript (fresh, mid-turn) + register via stop-hook
TDIR="$HAMSTER_PROJECTS/-tmp"; mkdir -p "$TDIR"
python3 - "$TDIR/$SID.jsonl" <<'PY'
import json,sys
lines=[{"type":"assistant","message":{"content":[
          {"type":"text","text":"did the thing"},
          {"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/x.py"}}]}},
       {"type":"user","message":{"content":[{"type":"text","text":"thanks"}]}}]
open(sys.argv[1],"w").write("\n".join(json.dumps(l) for l in lines)+"\n")
PY
printf '{"session_id":"%s","cwd":"/tmp"}' "$SID" | HAMSTER_TARGET="$T" "$H" stop-hook
check "stop-hook: sid recorded" "[w for w in d['windows'] if w['target']=='$T'][0]['sid']=='$SID'"
check "working state from fresh mid-turn transcript" "[w for w in d['windows'] if w['target']=='$T'][0]['state']=='working'"
check "last_text surfaced" "'did the thing' in [w for w in d['windows'] if w['target']=='$T'][0]['last_text']"

# make transcript stale -> returned/ready; the unread dot shows only once
# the session is no longer working (the spinner owns the working state)
touch -t 202601010000 "$TDIR/$SID.jsonl"
check "stale transcript reads ready" "[w for w in d['windows'] if w['target']=='$T'][0]['state']=='ready'"
check "unseen set once not working" "[w for w in d['windows'] if w['target']=='$T'][0]['unseen']"
printf '' | HAMSTER_TARGET="$T" "$H" submit-hook   # user replied -> clears unseen
check "submit-hook clears unseen" "not [w for w in d['windows'] if w['target']=='$T'][0]['unseen']"

HAMSTER_TARGET="$T" "$H" snooze 5m >/dev/null 2>&1
check "snoozed with time left" "[w for w in d['windows'] if w['target']=='$T'][0]['state']=='snoozed' and [w for w in d['windows'] if w['target']=='$T'][0]['snooze_left_s']>0"
HAMSTER_TARGET="$T" "$H" unsnooze >/dev/null 2>&1
check "unsnoozed" "[w for w in d['windows'] if w['target']=='$T'][0]['state']=='ready'"

HAMSTER_TARGET="$T" "$H" pin >/dev/null
check "pinned" "[w for w in d['windows'] if w['target']=='$T'][0]['pin']"
HAMSTER_TARGET="$T" "$H" artifact add https://example.com/demo "demo" >/dev/null
check "artifact recorded" "len([w for w in d['windows'] if w['target']=='$T'][0]['artifacts'])==1"
HAMSTER_TARGET="$T" "$H" primary /tmp >/dev/null
check "manual primary" "[w for w in d['windows'] if w['target']=='$T'][0]['primary']['source']=='manual'"

"$H" adopt "$SID" >/dev/null 2>&1 && { say "FAIL: duplicate adopt allowed"; fails=$((fails+1)); } || say "ok: duplicate adopt refused (already on board)"

FID=$("$H" folder new "test folder")
HAMSTER_TARGET="$T" "$H" folder assign "$FID" >/dev/null
check "folder assigned" "[w for w in d['windows'] if w['target']=='$T'][0]['folder']=='$FID' and d['folders']['$FID']=='test folder'"
HAMSTER_TARGET="$T" "$H" folder clear >/dev/null
check "folder cleared" "not [w for w in d['windows'] if w['target']=='$T'][0]['folder']"
"$H" folder rm "$FID" >/dev/null

HAMSTER_TARGET="$T" "$H" fork "forked-t1" >/dev/null
check "fork creates a named window, original intact" "any(w['name']=='forked-t1' for w in d['windows']) and any(w['target']=='$T' for w in d['windows'])"
FT=$("$H" json | python3 -c "import json,sys; print([w['target'] for w in json.load(sys.stdin)['windows'] if w['name']=='forked-t1'][0])")
HAMSTER_TARGET="$FT" "$H" close >/dev/null
check "forked window closed" "not any(w['name']=='forked-t1' for w in d['windows'])"

HAMSTER_TARGET="$T" "$H" hibernate >/dev/null
sleep 2
check "hibernated: process off, window kept" "not [w for w in d['windows'] if w['target']=='$T'][0]['proc']['alive'] and d['counts']['off']>=1"
HAMSTER_TARGET="$T" "$H" restart current >/dev/null
sleep 1
check "restart wakes it" "[w for w in d['windows'] if w['target']=='$T'][0]['proc']['alive']"

"$H" statusline >/dev/null || { say "FAIL: statusline"; fails=$((fails+1)); }
say "ok: statusline runs"

HAMSTER_TARGET="$T" "$H" close >/dev/null
check "closed: gone from the board" "not any(w['target']=='$T' for w in d['windows'])"

if [ "$fails" -eq 0 ]; then echo "integration: ALL PASS"; else echo "integration: $fails FAILURE(S)"; exit 1; fi
