#!/usr/bin/env python3
"""Adopt candidates as JSON: registered Claude sessions NOT already tracked
on the board, resumable on this machine, most recent first. Consumed by the
VS Code extension's adopt quick-pick.

usage: pick.py adopt <hdir> <projects> <out-unused> <registry> <window_hours>
(argv shape kept stable for callers; output is always the JSON dump.)
"""
import datetime
import glob
import json
import os
import re
import sys

_now = datetime.datetime.utcnow


def _parse(t):
    try:
        dt = datetime.datetime.fromisoformat((t or "").replace("Z", ""))
        return dt.replace(tzinfo=None)   # naive-UTC arithmetic downstream
    except Exception:
        return None


def _short(td):  # compact duration: 5m / 2h03m / 1d02h
    s = max(int(td.total_seconds()), 0)
    if s < 3600:
        return "%dm" % (s // 60)
    if s < 86400:
        return "%dh%02dm" % (s // 3600, (s % 3600) // 60)
    return "%dd%02dh" % (s // 86400, (s % 86400) // 3600)


def _enc(p):
    return re.sub(r"[/.]", "-", p)


def _tpath(proj, sid, cwd):  # recorded cwd can differ from the project dir -> glob fallback by sid
    if not sid:
        return ""
    p = os.path.join(proj, _enc(cwd), sid + ".jsonl")
    if os.path.exists(p):
        return p
    g = glob.glob(os.path.join(proj, "*", sid + ".jsonl"))
    return g[0] if g else p


def _title(proj, sid, cwd):  # user alias > latest ai-title > first user msg > short id
    if not sid:
        return ""
    try:  # resurrect-names.json = the shared user-given name store
        a = json.load(open(os.path.expanduser("~/.claude/resurrect-names.json")))
        if isinstance(a, dict) and a.get(sid):
            return " ".join(str(a[sid]).split())[:44]
    except Exception:
        pass
    tp = _tpath(proj, sid, cwd)
    t = fst = None
    if os.path.exists(tp):
        for line in open(tp):
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("type") == "ai-title" and d.get("aiTitle"):
                t = d["aiTitle"]
            elif fst is None and d.get("type") == "user":
                m = d.get("message", {}); c = m.get("content")
                if isinstance(c, list):
                    c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                c = (c or "").strip().replace("\n", " ")
                if c and not c.startswith("<") and not c.startswith("["):  # skip command/interrupt markers
                    fst = c
    return " ".join((t or fst or ("session " + sid[:8])).split())[:44]


def _tracked_sids(hdir):
    out = set()
    for f in glob.glob(os.path.join(hdir, "*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("session_id"):
            out.add(d["session_id"])
    return out


def build_adopt(reg, hdir, proj, win_hours):
    now = _now()
    tracked = _tracked_sids(hdir)
    last = {}
    # resurrect's catalog is the richer source (durable, machine-wide); the
    # legacy active-sessions registry fills gaps / wins when its entry is newer
    snap = os.path.join(os.path.dirname(reg), "resurrect-snapshot.json")
    try:
        s = json.load(open(snap)).get("sessions", {})
        if isinstance(s, dict):
            for sid, e in s.items():
                if isinstance(e, dict) and e.get("cwd"):
                    last[sid] = {"session_id": sid, "cwd": e["cwd"],
                                 "at": e.get("last_seen", "")}
    except Exception:
        pass
    if os.path.exists(reg):
        for line in open(reg):
            try:
                d = json.loads(line)
            except Exception:
                continue
            sid = d.get("session_id")
            if sid and (sid not in last or (d.get("at") or "") > (last[sid].get("at") or "")):
                last[sid] = d
    rows = []
    for sid, d in last.items():
        if sid in tracked:
            continue
        cwd = d.get("cwd", ""); at = d.get("at", "")
        pat = _parse(at)
        if pat and (now - pat).total_seconds() > win_hours * 3600:
            continue
        if not os.path.exists(_tpath(proj, sid, cwd)):
            continue  # only offer resumable sessions
        base = os.path.basename(cwd.rstrip("/")) or cwd
        age = _short(now - pat) if pat else "?"
        rows.append({"out": sid + "\t" + cwd, "target": "",
                     "label": "%s  ·  %s  ·  %s  ·  %s ago" % (sid[:8], _title(proj, sid, cwd), base, age),
                     "_sort": pat or now})
    rows.sort(key=lambda r: r["_sort"], reverse=True)
    for r in rows:
        r.pop("_sort", None)
    return rows


def main():
    if (sys.argv[1] if len(sys.argv) > 1 else "") != "adopt":
        sys.stderr.write("usage: pick.py adopt <hdir> <projects> <out> <registry> <window_hours>\n")
        return 1
    hdir, proj, _out, reg, win = sys.argv[2:7]
    print(json.dumps(build_adopt(reg, hdir, proj, float(win)), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
