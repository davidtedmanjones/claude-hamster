#!/usr/bin/env python3
"""Wheel roster as JSON for external UIs (VS Code sidebar). READ-ONLY —
statusline owns reconciliation and every write; this mirrors its derivation
so the two views never disagree for more than one statusline tick.

usage: wheelstate.py <hdir> <projects_dir> [tmux_session]
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import time

SKIP_FILES = {"wheel-snapshot.json", "heal-deferred.json", "pr-cache.json",
              "pins.json", "worktrees.json", "folders.json"}


def tmux_cmd():
    s = os.environ.get("HAMSTER_SOCKET")
    return ["tmux", "-L", s] if s else ["tmux"]


def parse_ts(t):
    try:
        return datetime.datetime.fromisoformat((t or "").replace("Z", ""))
    except Exception:
        return None


def enc(p):
    return re.sub(r"[/.]", "-", p)


def tpath(proj, sid, cwd):
    if not sid:
        return ""
    p = os.path.join(proj, enc(cwd or ""), sid + ".jsonl")
    if os.path.exists(p):
        return p
    g = glob.glob(os.path.join(proj, "*", sid + ".jsonl"))
    return g[0] if g else ""


def probe(proj, sid, cwd, nowts):
    """One tail read -> (active, midturn, last_text, mtime, last_file).
    active/midturn logic identical to hamster statusline; last_text = most
    recent assistant prose in the tail window, for row previews."""
    tp = tpath(proj, sid, cwd)
    if not tp:
        return (False, False, "", 0.0, [], 0)
    try:
        mtime = os.path.getmtime(tp)
        tsize = os.path.getsize(tp)
        fresh = nowts - mtime <= 30
        with open(tp, "rb") as f:
            f.seek(0, 2)
            sz = f.tell()
            f.seek(max(0, sz - 65536))
            data = f.read().decode("utf-8", "ignore")
    except Exception:
        return (False, False, "", 0.0, [], 0)
    # every file any tool touched in the tail, most recent first (deduped) —
    # the caller picks the first repo-relevant one, so end-of-turn memory
    # writes and /tmp scratch can't shadow the real operating worktree
    last_files = []
    ts_re = re.compile(r'"timestamp":\s*"([^"]+)"')
    fp_re = re.compile(r'"file_path":\s*"((?:[^"\\]|\\.)*)"')
    for line in data.split("\n"):
        fps = fp_re.findall(line)
        if not fps:
            continue
        lts = 0.0
        tm = ts_re.search(line)
        if tm:
            try:
                lts = datetime.datetime.fromisoformat(
                    tm.group(1).replace("Z", "+00:00")).timestamp()
            except Exception:
                lts = 0.0
        for v in fps:
            if v:
                last_files.append((v, lts))
    seen_f = set()
    ordered = []
    for v, lts in reversed(last_files):
        if v not in seen_f:
            seen_f.add(v)
            ordered.append((v, lts))
    last_files = ordered[:20]
    act = mid = None
    last_text = ""
    for line in reversed(data.splitlines()):
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = d.get("type")
        if t == "assistant":
            c = d.get("message", {}).get("content")
            if not last_text and isinstance(c, list):
                tx = " ".join(
                    x.get("text", "") for x in c
                    if isinstance(x, dict) and x.get("type") == "text"
                ).strip()
                if tx:
                    last_text = " ".join(tx.split())[:240]
            if act is None:
                m = bool(isinstance(c, list) and any(
                    isinstance(x, dict) and x.get("type") == "tool_use"
                    for x in c))
                act, mid = (fresh and m), m
            if last_text:
                break
        elif t == "user" and act is None:
            m = d.get("message", {})
            c = m.get("content")
            if isinstance(c, list):
                c = " ".join((x.get("text", "") or "") for x in c
                             if isinstance(x, dict))
            txt = (c or "").strip()
            if txt.startswith("<"):
                continue
            if "interrupted by user" in txt.lower():
                act, mid = False, False
            else:
                act, mid = fresh, True
    return (bool(act), bool(mid), last_text, mtime, last_files, tsize)


_branch_cache = {}
_wt_cache = {}


def repo_root(cwd):
    d = cwd
    for _ in range(10):
        if os.path.exists(os.path.join(d, ".git")):
            return d
        nd = os.path.dirname(d)
        if nd == d:
            return ""
        d = nd
    return ""


def worktrees_of(root):
    """branch -> checkout path for a repo, via git worktree list."""
    if not root or root in _wt_cache:
        return _wt_cache.get(root, {})
    m = {}
    try:
        o = subprocess.run(["git", "-C", root, "worktree", "list", "--porcelain"],
                           capture_output=True, text=True, timeout=5).stdout
        path = None
        for ln in o.splitlines():
            if ln.startswith("worktree "):
                path = ln[len("worktree "):]
            elif ln.startswith("branch refs/heads/") and path:
                m[ln[len("branch refs/heads/"):]] = path
    except Exception:
        pass
    _wt_cache[root] = m
    return m


def branch_of(cwd):
    """Current branch of the session's cwd via .git/HEAD file reads — no
    subprocess, safe at poll frequency. Worktrees resolve their gitdir file."""
    if not cwd or cwd in _branch_cache:
        return _branch_cache.get(cwd, "")
    b = ""
    try:
        d = cwd
        g = ""
        for _ in range(10):   # session cwd may be a repo subdir — walk up to .git
            cand = os.path.join(d, ".git")
            if os.path.exists(cand):
                g = cand
                break
            nd = os.path.dirname(d)
            if nd == d:
                break
            d = nd
        if os.path.isfile(g):
            gd = open(g).read().split("gitdir:", 1)[1].strip()
            if not os.path.isabs(gd):
                gd = os.path.normpath(os.path.join(d, gd))
            head = os.path.join(gd, "HEAD")
        elif os.path.isdir(g):
            head = os.path.join(g, "HEAD")
        else:
            head = ""
        if head and os.path.exists(head):
            h = open(head).read().strip()
            b = h.split("refs/heads/", 1)[1] if "refs/heads/" in h else h[:8]
    except Exception:
        b = ""
    _branch_cache[cwd] = b
    return b


def agents_live(proj, sid, cwd, nowts):
    if not sid:
        return 0
    dp = os.path.join(proj, enc(cwd or ""), sid, "subagents")
    if not os.path.isdir(dp):
        g = glob.glob(os.path.join(proj, "*", sid, "subagents"))
        dp = g[0] if g else ""
    if not dp:
        return 0
    n = 0
    for fp in glob.glob(os.path.join(dp, "agent-*.jsonl")):
        try:
            if nowts - os.path.getmtime(fp) <= 60:
                n += 1
        except Exception:
            pass
    return n


def load_prcache(hdir):
    """{'branches': {...}, 'urls': {...}}; a legacy flat file reads as branches."""
    try:
        prcache = json.load(open(os.path.join(hdir, "pr-cache.json")))
    except Exception:
        prcache = {}
    branches = prcache.get("branches",
                           prcache if "urls" not in prcache else {})
    return branches, prcache.get("urls", {})


def prs_for(hdir, sid, branch, root, branch_prs, url_prs):
    """All of this session's PRs: current branch's PR (enrich cache, keyed
    repo::branch so same-named branches in different repos never cross)
    first, then every PR the session itself created (facts hook — gh pr
    create output only, so passing mentions never land here), oldest first."""
    out = []
    seen = set()

    def add(number, url, state, title, head):
        if not number or url in seen:
            return
        seen.add(url)
        out.append({"number": number, "url": url, "state": state,
                    "title": title, "branch": head})

    c = branch_prs.get(root + "::" + branch) or branch_prs.get(branch)
    if c and c.get("number"):
        add(c["number"], c.get("url", ""), c.get("state", ""),
            c.get("title", ""), c.get("branch", branch))
    if sid:
        try:
            fx = json.load(open(os.path.join(hdir, "facts", sid + ".json")))
        except Exception:
            fx = {}
        for u, _ts in sorted((fx.get("prs") or {}).items(),
                             key=lambda kv: kv[1]):
            try:
                e = url_prs.get(u) or {}
                add(e.get("number") or int(u.rsplit("/", 1)[1]), u,
                    e.get("state", ""), e.get("title", ""),
                    e.get("branch", ""))
            except Exception:
                continue   # one malformed URL never drops the rest
    return out


def tickets_of(branch, prs):
    """Ordered by relevance: current branch's ticket, then tickets of open
    PRs, then the rest most-recent-first."""
    ordered = []

    def add_from(s):
        # two+ letter project key, two+ digits: matches JIRA-style keys
        # without eating things like utf-8 or x-1
        for m in re.findall(r"(?i)\b([a-z][a-z0-9]{1,9})-(\d{2,6})\b",
                            s or ""):
            t = "%s-%d" % (m[0].upper(), int(m[1]))
            if t not in ordered:
                ordered.append(t)

    add_from(branch)
    for p in prs:
        if not p.get("state") or p["state"] == "open":
            add_from(p.get("title", ""))
    for p in reversed(prs):
        add_from(p.get("title", ""))
    return ordered


def artifacts_of(hdir, sid):
    if not sid:
        return []
    try:
        a = json.load(open(os.path.join(hdir, "artifacts", sid + ".json")))
        return a.get("artifacts") or []
    except Exception:
        return []


def primary_of(primaries, sid, cwd, root, last_files):
    """A badge click pins (manual); the agent working in a DIFFERENT
    worktree after the pin un-pins it (activity supersedes an older
    manual). Precedence: newest of {pin, activity} > cwd. Stale tail
    files can't override a fresh pin — the deciding file's own entry
    timestamp must postdate the pin, not merely sit in the tail."""
    manual = primaries.get(sid)
    m_path, m_at = "", 0.0
    if isinstance(manual, dict):
        m_path = manual.get("path") or ""
        m_at = manual.get("at") or 0.0
    elif manual:
        m_path = manual   # pre-timestamp pin: any newer activity wins
    guess = None
    if root:
        cands = list(worktrees_of(root).values()) + [root]
        for lf, lts in last_files:  # most recent repo-relevant file decides
            best = ""
            for c in cands:
                if lf.startswith(c.rstrip("/") + "/") and len(c) > len(best):
                    best = c
            if not best:
                continue
            if os.path.realpath(best) == os.path.realpath(cwd or "") \
                    and not m_path:
                break   # recent work genuinely in the cwd checkout
            guess = {"path": best, "branch": branch_of(best),
                     "source": "active", "at": lts}
            break
    if m_path:
        if guess and guess["at"] > m_at and \
                os.path.realpath(guess["path"]) != os.path.realpath(m_path):
            return {k: guess[k] for k in ("path", "branch", "source")}
        return {"path": m_path, "branch": branch_of(m_path),
                "source": "manual"}
    if guess and os.path.realpath(guess["path"]) != \
            os.path.realpath(cwd or ""):
        return {k: guess[k] for k in ("path", "branch", "source")}
    return {"path": cwd, "branch": branch_of(cwd), "source": "cwd"}


def main():
    hdir = sys.argv[1]
    proj = sys.argv[2]
    ts = sys.argv[3] if len(sys.argv) > 3 else "hamster"
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    nowts = time.time()

    live = []
    active_tgt = ""
    panes = {}   # target -> (pane_pid, pane_dead)
    try:
        out = subprocess.run(
            tmux_cmd() + ["list-windows", "-t", ts, "-F",
             "#{session_name}:#{window_index}\t#{window_name}\t#{window_active}"
             "\t#{pane_pid}\t#{pane_dead}"],
            capture_output=True, text=True, timeout=5).stdout
        for ln in out.splitlines():
            a = ln.split("\t")
            if len(a) >= 5:
                live.append((a[0], a[1]))
                if a[2] == "1":
                    active_tgt = a[0]
                panes[a[0]] = (a[3], a[4] == "1")
    except Exception:
        pass

    # one ps snapshot -> per-pane process-tree memory/cpu (claude + children)
    ps_info, ps_kids = {}, {}
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,pcpu="],
                             capture_output=True, text=True, timeout=5).stdout
        for ln in out.splitlines():
            f = ln.split()
            if len(f) >= 4:
                ps_info[f[0]] = (int(f[2]), float(f[3]))
                ps_kids.setdefault(f[1], []).append(f[0])
    except Exception:
        pass

    def proc_of(tgt):
        pid, dead = panes.get(tgt, ("", True))
        alive = bool(pid) and not dead and pid in ps_info
        rss = 0
        cpu = 0.0
        if alive:
            stack = [pid]
            while stack:
                q = stack.pop()
                r, c = ps_info.get(q, (0, 0.0))
                rss += r
                cpu += c
                stack.extend(ps_kids.get(q, []))
        return {"pid": int(pid) if pid.isdigit() else None,
                "alive": alive, "rss_kb": rss, "cpu": round(cpu, 1)}
    if not live:
        print(json.dumps({"ok": False, "error": "no tmux session '%s'" % ts,
                          "session": ts, "windows": []}))
        return 0

    branch_prs, url_prs = load_prcache(hdir)

    state = {}
    for f in glob.glob(os.path.join(hdir, "*.json")):
        if os.path.basename(f) in SKIP_FILES:
            continue
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("target"):
            state[d["target"]] = d

    try:
        pins = json.load(open(os.path.join(hdir, "pins.json")))
    except Exception:
        pins = {}
    try:
        _fol = json.load(open(os.path.join(hdir, "folders.json")))
    except Exception:
        _fol = {}
    folder_names = _fol.get("names", {})
    folder_sids = _fol.get("sids", {})
    try:
        primaries = json.load(open(os.path.join(hdir, "worktrees.json")))
    except Exception:
        primaries = {}

    hidesnooze = False
    try:
        o = subprocess.run(tmux_cmd() + ["show-option", "-gv", "@hamster_hidesnooze"],
                           capture_output=True, text=True, timeout=5).stdout
        hidesnooze = o.strip() == "1"
    except Exception:
        pass

    windows = []
    counts = {"ready": 0, "working": 0, "attention": 0, "snoozed": 0,
              "shell": 0, "unseen": 0, "off": 0}
    for tgt, wname in live:
        d = state.get(tgt)
        row = {"target": tgt,
               "index": int(tgt.rsplit(":", 1)[1]) if ":" in tgt else 0,
               "name": wname, "active": tgt == active_tgt,
               "proc": proc_of(tgt)}
        if not d:
            row.update({"state": "shell", "subagents": 0,
                        "sid": "", "cwd": "", "base": "", "last_text": "",
                        "waiting_s": None, "snooze_left_s": None})
            counts["shell"] += 1
            windows.append(row)
            continue
        sid = d.get("session_id", "") or ""
        cwd = d.get("cwd", "") or ""
        act, mid, last_text, mtime, last_files, tsize = probe(proj, sid, cwd, nowts)
        agents = agents_live(proj, sid, cwd, nowts)
        sub = max(int(d.get("subagents", 0) or 0), agents)
        if sub > 0 and (mid or agents > 0):
            act = True
        if not act and sub > 0:
            sub = 0
        su = parse_ts(d.get("snooze_until", ""))
        ra = parse_ts(d.get("returned_at", ""))
        if act:
            st = "working"
        elif d.get("attention"):
            st = "attention"
        elif su and su > now:
            st = "snoozed"
        else:
            st = "ready"
        counts[st] += 1
        if not row["proc"]["alive"]:
            counts["off"] += 1
        unseen = bool(d.get("unseen")) and st != "working"
        if unseen:
            counts["unseen"] += 1
        snooze_left = None
        if su and su > now:
            snooze_left = -1 if su.year >= 9000 else int((su - now).total_seconds())
        waiting = None
        if st in ("ready", "attention") and ra:
            waiting = max(int((now - ra).total_seconds()), 0)
        br = branch_of(cwd)
        root = repo_root(cwd)
        prs = prs_for(hdir, sid, br, root, branch_prs, url_prs)
        primary = primary_of(primaries, sid, cwd, root, last_files)
        wt = worktrees_of(root)
        for p_ in prs:
            hb = p_.get("branch") or ""
            if hb and hb in wt:
                p_["worktree"] = wt[hb]
        row.update({"state": st, "unseen": unseen, "root": root,
                    "turns": int(d.get("turns", 0) or 0), "tsize": tsize,
                    "subagents": sub, "sid": sid, "cwd": cwd,
                    "base": os.path.basename(cwd.rstrip("/")) if cwd else "",
                    "branch": br, "prs": prs,
                    "primary": primary,
                    "tickets": tickets_of(br, prs),
                    "artifacts": artifacts_of(hdir, sid),
                    "pin": sid in pins,
                    "folder": folder_sids.get(sid, ""),
                    "pinned": bool(d.get("pinned_name")),
                    "last_text": last_text, "last_mtime": mtime,
                    "waiting_s": waiting, "snooze_left_s": snooze_left})
        windows.append(row)

    print(json.dumps({
        "ok": True, "session": ts, "active": active_tgt,
        "hidesnooze": hidesnooze,
        "folders": folder_names,
        "counts": counts, "windows": windows,
        "generated_at": now.isoformat() + "Z",
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
