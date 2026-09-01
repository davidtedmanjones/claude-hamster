#!/usr/bin/env bash
# PostToolUse hook (matchers: Bash, Artifact) — capture session facts:
#  - Bash `gh pr create` output → PR URL into facts/<sid>.json
#  - Artifact tool publishes → claude.ai URL + local source file into
#    artifacts/<sid>.json
# Precision over recall: only creation output is trusted (a `gh pr list` or a
# pasted artifact link never lands). History: backfill_facts / backfill_artifacts.
# Fires on every matched call in every session — fast-exit before python on miss.
set -u
input="$(cat 2>/dev/null || true)"
case "$input" in *"pr create"*|*'"Artifact"'*) ;; *) exit 0;; esac
# heredoc = python's stdin, so the payload rides in via env (hamster idiom)
HF_INPUT="$input" python3 - <<'PY' 2>/dev/null || true
import datetime, json, os, re, sys


def merge(subdir, sid, key, items):
    if not items or not sid:
        return
    fd = os.path.expanduser("~/.claude/hamster/" + subdir)
    os.makedirs(fd, exist_ok=True)
    fp = os.path.join(fd, sid + ".json")
    try:
        cur = json.load(open(fp))
    except Exception:
        cur = {}
    cur[key] = items(cur.get(key))
    tmp = fp + ".tmp"
    json.dump(cur, open(tmp, "w"))
    os.replace(tmp, fp)


try:
    d = json.loads(os.environ.get("HF_INPUT", ""))
except Exception:
    sys.exit(0)
sid = d.get("session_id") or ""
tool = d.get("tool_name")
resp = d.get("tool_response")
text = resp if isinstance(resp, str) else json.dumps(resp)
now = datetime.datetime.utcnow().isoformat() + "Z"

if tool == "Bash":
    cmd = (d.get("tool_input") or {}).get("command", "")
    if not re.search(r"\bgh\s+pr\s+create\b", cmd):
        sys.exit(0)
    urls = set(re.findall(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+", text))

    def upd(prs):
        prs = prs or {}
        for u in urls:
            prs.setdefault(u, now)
        return prs
    merge("facts", sid, "prs", upd if urls else None)
elif tool == "Artifact":
    urls = set(re.findall(r"https://claude\.ai/(?:code/artifact|public/artifacts)/[\w-]+", text))
    path = (d.get("tool_input") or {}).get("file_path", "") or ""
    if not urls:
        sys.exit(0)

    def upd(arts):
        arts = arts or []
        known = {a.get("url") for a in arts}
        for u in urls:
            if u not in known:
                arts.append({"url": u, "path": path, "label": "", "at": now})
        return arts
    merge("artifacts", sid, "artifacts", upd)
PY
exit 0
