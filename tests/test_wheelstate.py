#!/usr/bin/env python3
"""Unit tests for wheelstate's decision functions (pure data in, rows out).
stdlib only — `python3 -m unittest discover -s tests` from the repo root."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "core"))
import wheelstate as W  # noqa: E402


def write(p, content):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(content)


class TestBranchOf(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()

    def test_plain_repo(self):
        write(os.path.join(self.d, "repo/.git/HEAD"), "ref: refs/heads/main\n")
        self.assertEqual(W.branch_of(os.path.join(self.d, "repo")), "main")

    def test_worktree_gitdir_file(self):
        gd = os.path.join(self.d, "main/.git/worktrees/wt1")
        write(os.path.join(gd, "HEAD"), "ref: refs/heads/apg-1-feat\n")
        write(os.path.join(self.d, "wt/.git"), "gitdir: %s\n" % gd)
        self.assertEqual(W.branch_of(os.path.join(self.d, "wt")), "apg-1-feat")

    def test_subdir_walks_up(self):
        write(os.path.join(self.d, "r/.git/HEAD"), "ref: refs/heads/dev\n")
        sub = os.path.join(self.d, "r/a/b")
        os.makedirs(sub)
        self.assertEqual(W.branch_of(sub), "dev")

    def test_detached_head(self):
        write(os.path.join(self.d, "det/.git/HEAD"), "abcdef0123456789\n")
        self.assertEqual(W.branch_of(os.path.join(self.d, "det")), "abcdef01")

    def test_not_a_repo(self):
        os.makedirs(os.path.join(self.d, "plain"))
        self.assertEqual(W.branch_of(os.path.join(self.d, "plain")), "")


class TestTicketsOf(unittest.TestCase):
    def test_ordering_branch_then_open_then_recent(self):
        prs = [
            {"title": "APG-100: old merged", "state": "merged"},
            {"title": "APG-200: open work", "state": "open"},
            {"title": "APG-300: newest merged", "state": "merged"},
        ]
        self.assertEqual(W.tickets_of("apg-999-branch", prs),
                         ["APG-999", "APG-200", "APG-300", "APG-100"])

    def test_rejects_lookalikes(self):
        self.assertEqual(W.tickets_of("", [{"title": "utf-8 fix and x-1", "state": "open"}]), [])

    def test_case_normalised(self):
        self.assertEqual(W.tickets_of("proj-42-thing", []), ["PROJ-42"])


class TestPrsFor(unittest.TestCase):
    def setUp(self):
        self.hdir = tempfile.mkdtemp()

    def test_repo_scoped_branch_key_beats_legacy(self):
        branches = {"/r1::dev": {"number": 1, "url": "u1", "state": "open",
                                 "title": "t", "branch": "dev"},
                    "dev": {"number": 2, "url": "u2", "state": "open",
                            "title": "t", "branch": "dev"}}
        out = W.prs_for(self.hdir, "", "dev", "/r1", branches, {})
        self.assertEqual(out[0]["number"], 1)

    def test_facts_merge_dedupe_and_malformed_isolation(self):
        write(os.path.join(self.hdir, "facts/s1.json"), json.dumps({
            "prs": {"https://github.com/o/r/pull/7": "2026-01-01",
                    "https://github.com/o/r/pull/notanumber": "2026-01-02",
                    "https://github.com/o/r/pull/9": "2026-01-03"}}))
        out = W.prs_for(self.hdir, "s1", "", "", {}, {})
        self.assertEqual([p["number"] for p in out], [7, 9])

    def test_url_cache_enriches_facts(self):
        write(os.path.join(self.hdir, "facts/s2.json"), json.dumps({
            "prs": {"https://github.com/o/r/pull/5": "2026-01-01"}}))
        urls = {"https://github.com/o/r/pull/5":
                {"number": 5, "state": "merged", "title": "APG-1: x",
                 "branch": "apg-1-x"}}
        out = W.prs_for(self.hdir, "s2", "", "", {}, urls)
        self.assertEqual(out[0]["state"], "merged")
        self.assertEqual(out[0]["branch"], "apg-1-x")


# NOTE: primary_of tests intentionally absent — its semantics (timestamped
# manual pins, newer activity superseding an older pin) are being evolved in
# a parallel working session; add tests once that lands.


class TestProbe(unittest.TestCase):
    def setUp(self):
        self.proj = tempfile.mkdtemp()

    def _transcript(self, lines, sid="sid1", cwd="/w"):
        tp = os.path.join(self.proj, W.enc(cwd), sid + ".jsonl")
        write(tp, "\n".join(json.dumps(l) for l in lines) + "\n")
        return sid, cwd

    def test_midturn_and_files_and_text(self):
        sid, cwd = self._transcript([
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "working on it"},
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "/w/a.py"}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "content": "ok"}]}},
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Write", "input": {"file_path": "/w/b.py"}}]}},
        ])
        act, mid, text, mtime, files = W.probe(self.proj, sid, cwd, time.time())
        self.assertTrue(act)          # fresh mtime + trailing tool_use
        self.assertTrue(mid)
        self.assertEqual(text, "working on it")
        # (path, entry-timestamp) tuples, most recent first
        self.assertEqual([f for f, _ in files], ["/w/b.py", "/w/a.py"])

    def test_interrupted_is_idle(self):
        sid, cwd = self._transcript([
            {"type": "user", "message": {"content": [
                {"type": "text", "text": "[Request interrupted by user]"}]}},
        ])
        act, mid, *_ = W.probe(self.proj, sid, cwd, time.time())
        self.assertFalse(act)

    def test_stale_transcript_not_active(self):
        sid, cwd = self._transcript([
            {"type": "user", "message": {"content": [{"type": "text", "text": "go"}]}},
        ])
        tp = os.path.join(self.proj, W.enc(cwd), sid + ".jsonl")
        os.utime(tp, (time.time() - 300, time.time() - 300))
        act, mid, *_ = W.probe(self.proj, sid, cwd, time.time())
        self.assertFalse(act)
        self.assertTrue(mid)


class TestLoadPrcache(unittest.TestCase):
    def test_legacy_flat_shape(self):
        d = tempfile.mkdtemp()
        write(os.path.join(d, "pr-cache.json"),
              json.dumps({"dev": {"number": 3}}))
        branches, urls = W.load_prcache(d)
        self.assertEqual(branches["dev"]["number"], 3)
        self.assertEqual(urls, {})

    def test_new_shape(self):
        d = tempfile.mkdtemp()
        write(os.path.join(d, "pr-cache.json"),
              json.dumps({"branches": {"/r::b": {"number": 1}},
                          "urls": {"u": {"number": 2}}}))
        branches, urls = W.load_prcache(d)
        self.assertEqual(branches["/r::b"]["number"], 1)
        self.assertEqual(urls["u"]["number"], 2)


class TestFactsHook(unittest.TestCase):
    """End-to-end through the real hook script — stdin in, sid-keyed files out."""
    HOOK = os.path.join(os.path.dirname(__file__), "..", "core", "facts-hook.sh")

    def run_hook(self, payload, home):
        subprocess.run([self.HOOK], input=json.dumps(payload).encode(),
                       env={**os.environ, "HOME": home}, timeout=15)

    def test_pr_create_captured_pr_list_ignored(self):
        home = tempfile.mkdtemp()
        self.run_hook({"session_id": "s1", "tool_name": "Bash",
                       "tool_input": {"command": "gh pr create -t x"},
                       "tool_response": {"stdout": "https://github.com/o/r/pull/11\n"}}, home)
        self.run_hook({"session_id": "s1", "tool_name": "Bash",
                       "tool_input": {"command": "gh pr list"},
                       "tool_response": {"stdout": "https://github.com/o/r/pull/99\n"}}, home)
        facts = json.load(open(os.path.join(home, ".claude/hamster/facts/s1.json")))
        self.assertIn("https://github.com/o/r/pull/11", facts["prs"])
        self.assertNotIn("https://github.com/o/r/pull/99", facts["prs"])

    def test_artifact_capture(self):
        home = tempfile.mkdtemp()
        self.run_hook({"session_id": "s2", "tool_name": "Artifact",
                       "tool_input": {"file_path": "/tmp/demo.html"},
                       "tool_response": "Published at https://claude.ai/code/artifact/ab-cd"}, home)
        arts = json.load(open(os.path.join(home, ".claude/hamster/artifacts/s2.json")))
        self.assertEqual(arts["artifacts"][0]["url"], "https://claude.ai/code/artifact/ab-cd")
        self.assertEqual(arts["artifacts"][0]["path"], "/tmp/demo.html")


if __name__ == "__main__":
    unittest.main()
