#!/usr/bin/env python3
"""Seed artifacts/<sid>.json from session transcripts: claude.ai artifact URLs
taken ONLY from the tool_result of an Artifact tool call (same precision as
facts-hook.sh — a pasted or mentioned artifact link never lands), plus the
published file's local path from the tool_use input. Idempotent; rerunnable.

usage: backfill_artifacts.py <hdir> <projects_dir>
"""
import datetime
import glob
import json
import os
import re
import sys

from wheelstate import SKIP_FILES, tpath

ART_RE = re.compile(r"https://claude\.ai/(?:code/artifact|public/artifacts)/[\w-]+")


def flatten(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            (c.get("text", "") if isinstance(c, dict) else str(c))
            for c in content)
    return json.dumps(content) if content else ""


def scan(tp):
    pending = {}   # tool_use_id -> file_path
    found = {}     # url -> (path, ts)
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
                        and c.get("name") == "Artifact"):
                    pending[c.get("id")] = (c.get("input") or {}).get("file_path", "") or ""
        elif t == "user":
            for c in content:
                if (isinstance(c, dict) and c.get("type") == "tool_result"
                        and c.get("tool_use_id") in pending):
                    ts = d.get("timestamp") or (
                        datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z")
                    for u in ART_RE.findall(flatten(c.get("content"))):
                        found.setdefault(u, (pending[c["tool_use_id"]], ts))
    return found


def main():
    hdir, proj = sys.argv[1], sys.argv[2]
    total = 0
    for f in glob.glob(os.path.join(hdir, "*.json")):
        if os.path.basename(f) in SKIP_FILES | {"pr-cache.json", "pins.json"}:
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
        fd = os.path.join(hdir, "artifacts")
        os.makedirs(fd, exist_ok=True)
        fp = os.path.join(fd, sid + ".json")
        try:
            cur = json.load(open(fp))
        except Exception:
            cur = {}
        arts = cur.get("artifacts") or []
        known = {a.get("url") for a in arts if a.get("url")}
        added = 0
        for u, (path, ts) in found.items():
            if u not in known:
                arts.append({"url": u, "path": path, "label": "", "at": ts})
                added += 1
        if added:
            cur["artifacts"] = arts
            tmp = fp + ".tmp"
            json.dump(cur, open(tmp, "w"))
            os.replace(tmp, fp)
            total += added
            print("  %s: +%d artifact(s)" % (sid[:8], added))
    print("backfilled %d artifact(s)" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
