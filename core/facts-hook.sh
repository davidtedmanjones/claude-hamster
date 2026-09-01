#!/usr/bin/env bash
# PostToolUse hook (matchers: Bash, Artifact) — capture session facts.
# Precision over recall: only creation output is trusted (a `gh pr list` or a
# pasted artifact link never lands). History: backfill_facts / backfill_artifacts.
# Fires on every matched call in every session — fast-exit before python on
# miss; the payload is piped on stdin (env vars hit ARG_MAX on big responses).
set -u
SRC="${BASH_SOURCE[0]}"; [ -L "$SRC" ] && SRC="$(readlink "$SRC")"
HERE="$(cd "$(dirname "$SRC")" && pwd)"
input="$(cat 2>/dev/null || true)"
case "$input" in *"pr create"*|*'"Artifact"'*) ;; *) exit 0;; esac
printf '%s' "$input" | python3 "$HERE/facts_hook.py" 2>/dev/null || true
exit 0
