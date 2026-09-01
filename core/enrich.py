#!/usr/bin/env python3
"""Refresh ~/.claude/hamster/pr-cache.json — for each wheel session's feature
branch, ask gh for its PR (number/url/state/title). This is the slow rail
(one gh call per branch): run in the background (`hamster enrich`; the VS Code
extension fires it every ~5 min). wheelstate.py only ever reads the cache.

usage: enrich.py <hdir>
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys

from wheelstate import SKIP_FILES, branch_of, repo_root


def main():
    hdir = sys.argv[1]
    pairs = {}
    fact_urls = set()
    any_root = ""
    for f in glob.glob(os.path.join(hdir, "*.json")):
        if os.path.basename(f) in SKIP_FILES | {"pr-cache.json"}:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        cwd = d.get("cwd") or ""
        sid = d.get("session_id") or ""
        if sid:   # PRs this session created (facts-hook) — need live state
            try:
                fx = json.load(open(os.path.join(hdir, "facts", sid + ".json")))
                fact_urls.update((fx.get("prs") or {}).keys())
            except Exception:
                pass
        if not cwd:
            continue
        root = repo_root(cwd)
        if root:
            any_root = root
        b = branch_of(cwd)
        if not b or b in ("main", "master"):
            continue
        if re.fullmatch(r"[0-9a-f]{8}", b):   # detached head
            continue
        if root:
            pairs[(root, b)] = root

    cp = os.path.join(hdir, "pr-cache.json")
    try:
        cache = json.load(open(cp))
    except Exception:
        cache = {}
    old_branches = cache.get("branches",
                             cache if "urls" not in cache else {})
    old_urls = cache.get("urls", {})
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z"

    branches = {}
    for (root, b), _ in sorted(pairs.items()):
        try:
            r = subprocess.run(
                ["gh", "pr", "list", "--head", b, "--state", "all",
                 "--json", "number,url,state,title,headRefName", "--limit", "1"],
                capture_output=True, text=True, cwd=root, timeout=20)
            rows = json.loads(r.stdout or "[]") if r.returncode == 0 else None
        except Exception:
            rows = None
        key = root + "::" + b
        if rows is None:   # gh unavailable/errored: keep the stale entry
            old = old_branches.get(key) or old_branches.get(b)
            if old:
                branches[key] = old
            continue
        if rows:
            p = rows[0]
            branches[key] = {"number": p.get("number"), "url": p.get("url"),
                           "state": (p.get("state") or "").lower(),
                           "title": p.get("title") or "",
                           "branch": p.get("headRefName") or b, "at": now}
        else:   # negative result recorded so wheelstate doesn't guess
            branches[key] = {"number": None, "at": now}

    urls = {}
    for u in sorted(fact_urls):
        old = old_urls.get(u)
        # terminal states never change — skip the gh call once the entry is
        # complete ("branch" missing = pre-headRefName cache, refetch once)
        if old and old.get("state") in ("merged", "closed") and "branch" in old:
            urls[u] = old
            continue
        try:
            r = subprocess.run(
                ["gh", "pr", "view", u,
                 "--json", "number,url,state,title,headRefName"],
                capture_output=True, text=True, cwd=any_root or None,
                timeout=20)
            p = json.loads(r.stdout) if r.returncode == 0 else None
        except Exception:
            p = None
        if p:
            urls[u] = {"number": p.get("number"), "url": u,
                       "state": (p.get("state") or "").lower(),
                       "title": p.get("title") or "",
                       "branch": p.get("headRefName") or "", "at": now}
        elif u in old_urls:   # keep stale over nothing
            urls[u] = old_urls[u]

    tmp = cp + ".tmp"
    json.dump({"branches": branches, "urls": urls}, open(tmp, "w"))
    os.replace(tmp, cp)
    n = sum(1 for v in branches.values() if v.get("number"))
    print("pr-cache: %d branch PRs / %d branches · %d fact PRs"
          % (n, len(branches), len(urls)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
