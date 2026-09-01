#!/usr/bin/env python3
"""PostToolUse payload processor for facts-hook.sh — reads the hook JSON on
stdin (env would hit ARG_MAX on large tool responses) and records:
  Bash `gh pr create` output  -> PR URL into facts/<sid>.json
  Artifact tool publishes     -> claude.ai URL + source file into artifacts/<sid>.json
"""
import datetime
import json
import os
import re
import sys


def merge(subdir, sid, key, update):
    fd = os.path.expanduser("~/.claude/hamster/" + subdir)
    os.makedirs(fd, exist_ok=True)
    fp = os.path.join(fd, sid + ".json")
    try:
        cur = json.load(open(fp))
    except Exception:
        cur = {}
    cur[key] = update(cur.get(key))
    tmp = fp + ".tmp"
    json.dump(cur, open(tmp, "w"))
    os.replace(tmp, fp)


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        return 0
    sid = os.path.basename(d.get("session_id") or "")
    if not sid:
        return 0
    tool = d.get("tool_name")
    resp = d.get("tool_response")
    text = resp if isinstance(resp, str) else json.dumps(resp)
    now = datetime.datetime.now(datetime.timezone.utc).replace(
        tzinfo=None).isoformat() + "Z"

    if tool == "Bash":
        cmd = (d.get("tool_input") or {}).get("command", "")
        if not re.search(r"\bgh\s+pr\s+create\b", cmd):
            return 0
        urls = set(re.findall(
            r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+", text))
        if not urls:
            return 0

        def upd(prs):
            prs = prs or {}
            for u in urls:
                prs.setdefault(u, now)
            return prs
        merge("facts", sid, "prs", upd)
    elif tool == "Artifact":
        urls = set(re.findall(
            r"https://claude\.ai/(?:code/artifact|public/artifacts)/[\w-]+",
            text))
        if not urls:
            return 0
        path = (d.get("tool_input") or {}).get("file_path", "") or ""

        def upd(arts):
            arts = arts or []
            known = {a.get("url") for a in arts}
            for u in urls:
                if u not in known:
                    arts.append({"url": u, "path": path, "label": "",
                                 "at": now})
            return arts
        merge("artifacts", sid, "artifacts", upd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
