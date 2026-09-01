#!/usr/bin/env python3
"""Seed facts/<sid>.json from session transcripts: PR URLs taken ONLY from
the tool_result of a `gh pr create` Bash call — same precision as
facts-hook.sh, for sessions that created PRs before the hook existed.
Idempotent; hook-captured entries win on timestamp collisions.

usage: backfill_facts.py <hdir> <projects_dir>
"""
import datetime
import glob
import json
import os
import re
import sys

from wheelstate import SKIP_FILES, tpath

PR_RE = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/\d+")
CREATE_RE = re.compile(r"\bgh\s+pr\s+create\b")


def flatten(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            (c.get("text", "") if isinstance(c, dict) else str(c))
            for c in content)
    return json.dumps(content) if content else ""


def scan(tp):
    pending = set()
    found = {}
    for line in open(tp):
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get("type")
        msg = d.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        if t == "assistant":
            for c in content:
                if (isinstance(c, dict) and c.get("type") == "tool_use"
                        and c.get("name") == "Bash"
                        and CREATE_RE.search(
                            (c.get("input") or {}).get("command", ""))):
                    pending.add(c.get("id"))
        elif t == "user":
            for c in content:
                if (isinstance(c, dict) and c.get("type") == "tool_result"
                        and c.get("tool_use_id") in pending):
                    ts = d.get("timestamp") or (
                        datetime.datetime.utcnow().isoformat() + "Z")
                    for u in PR_RE.findall(flatten(c.get("content"))):
                        found.setdefault(u, ts)
    return found


def main():
    hdir, proj = sys.argv[1], sys.argv[2]
    total = 0
    for f in glob.glob(os.path.join(hdir, "*.json")):
        if os.path.basename(f) in SKIP_FILES | {"pr-cache.json"}:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        sid = d.get("session_id") or ""
        if not sid:
            continue
        tp = tpath(proj, sid, d.get("cwd") or "")
        if not tp or not os.path.exists(tp):
            continue
        found = scan(tp)
        if not found:
            continue
        fd = os.path.join(hdir, "facts")
        os.makedirs(fd, exist_ok=True)
        fp = os.path.join(fd, sid + ".json")
        try:
            cur = json.load(open(fp))
        except Exception:
            cur = {}
        prs = cur.get("prs") or {}
        added = 0
        for u, ts in found.items():
            if u not in prs:
                prs[u] = ts
                added += 1
        if added:
            cur["prs"] = prs
            tmp = fp + ".tmp"
            json.dump(cur, open(tmp, "w"))
            os.replace(tmp, fp)
            total += added
            print("  %s: +%d PR(s)" % (sid[:8], added))
    print("backfilled %d PR fact(s)" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
