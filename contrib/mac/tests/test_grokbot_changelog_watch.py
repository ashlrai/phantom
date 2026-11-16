"""Fixture tests for contrib/mac/grokbot_changelog_watch.py
(RQ-GROKBOT-CHANGELOG-WATCH-1).

Every case runs the repo copy once per tick as a subprocess under a temp HOME
with GROKBOT_WATCH_* env overrides pointing at file:// fixtures; nothing
touches the network, the real ~/.ashlr-runs, or queue/ready.tsv. Covers:
baseline seeding, changelog RSS parsing, HTML fallback, docs .md heading
diffing, URL+heading dedupe, --max deferral, --dry-run non-mutation, total
source failure, and value-free summary output.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "grokbot_changelog_watch.py"

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Grok Bot Changelog</title>
<item><title>Release One</title>
<link>https://x.ai/changelog/bot#v1.0.0</link>
<pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate>
<description>&lt;p&gt;Adds &lt;b&gt;voice memos&lt;/b&gt; and fixes sync.&lt;/p&gt;</description>
</item>
<item><title>Release Two</title>
<link>https://x.ai/changelog/bot#v1.1.0</link>
<pubDate>Tue, 02 Sep 2026 00:00:00 GMT</pubDate>
<description>Team bots and shared connectors.</description>
</item>
</channel></rss>
"""

CHANGELOG_HTML = """<html><body>
<h1>Changelog</h1>
<h2 id="v9.9.9">Fallback Release</h2>
<p>notes</p>
<h3>No Id Heading</h3>
<p>more</p>
</body></html>
"""

DOCS_INDEX = """<html><body>
<a href="overview">Overview</a>
<a href="bots#what-a-bot-remembers">Bots</a>
<a href="bots">Bots dup</a>
<a href="overview.md">md link ignored</a>
<a href="/other/page">outside ignored</a>
<a href="https://docs.x.ai/grok-bot/deep-links">cross-host ignored</a>
<a href="deep-links">Deep links</a>
</body></html>
"""

OVERVIEW_MD = """# Grok Bot

Intro paragraph.

## Get started

Install the app.

## What a Bot remembers

Durable context.
"""

BOTS_MD = """# Bots

## Create a Bot

Steps here.
"""

DEEP_LINKS_MD = """# Deep links

## Open a chat

URL scheme notes.
"""


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def build():
    """temp HOME + file:// fixture tree; returns (home, env, fx dir)."""
    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name) / "home"
    fx = Path(tmp.name) / "fx"
    home.mkdir(parents=True)
    site = fx / "site" / "grok-bot"
    write(fx / "rss.xml", RSS)
    write(fx / "changelog.html", CHANGELOG_HTML)
    write(site / "index.html", DOCS_INDEX)
    write(site / "overview.md", OVERVIEW_MD)
    write(site / "bots.md", BOTS_MD)
    write(site / "deep-links.md", DEEP_LINKS_MD)
    state = home / ".ashlr-runs" / "staged" / "changelog-ideas"
    env = dict(os.environ)
    env.update({
        "HOME": str(home),
        "GROKBOT_WATCH_STATE_DIR": str(state),
        "GROKBOT_WATCH_CHANGELOG_RSS":
            "file://" + str(fx / "rss.xml"),
        "GROKBOT_WATCH_CHANGELOG_PAGE":
            "file://" + str(fx / "changelog.html"),
        "GROKBOT_WATCH_DOCS_INDEX":
            "file://" + str(site / "index.html"),
    })
    return tmp, home, env, fx, state, site


def run(env, *args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        env=env, capture_output=True, text=True, timeout=60)


class TestGrokbotChangelogWatch(unittest.TestCase):
    def setUp(self):
        self.tmp, self.home, self.env, self.fx, self.state, self.site = build()
        self.addCleanup(self.tmp.cleanup)

    def prompts(self):
        if not self.state.is_dir():
            return []
        return sorted(p for p in self.state.glob("RQ-GROKBOT-IDEA-*.md"))

    def test_baseline_seeds_and_files_nothing(self):
        r = run(self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("baseline-seeded", r.stdout)
        self.assertEqual(self.prompts(), [])
        seen = json.loads((self.state / "seen.json").read_text())
        self.assertTrue(seen["initialized"])
        # 2 RSS items + 3 docs pages x their headings (overview 3, bots 1,
        # deep-links 1 = wait: overview has 3 heads incl. title).
        self.assertGreater(len(seen["seen"]), 5)

    def test_second_run_files_new_items_and_dedupes(self):
        self.assertEqual(run(self.env).returncode, 0)
        # mutate fixtures: new RSS item + new docs heading
        write(self.fx / "rss.xml", RSS.replace(
            "</channel>",
            "<item><title>Release Three</title>"
            "<link>https://x.ai/changelog/bot#v1.2.0</link>"
            "<pubDate>Wed, 03 Sep 2026 00:00:00 GMT</pubDate>"
            "<description>Routines GA.</description></item></channel>"))
        write(self.site / "bots.md", BOTS_MD + "\n## Rename a Bot\n\nNew section.\n")
        r = run(self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("filed", r.stdout)
        prompts = self.prompts()
        self.assertEqual(len(prompts), 2)
        bodies = {p.read_text() for p in prompts}
        self.assertTrue(any("Release Three" in b and "v1.2.0" in b
                            for b in bodies))
        self.assertTrue(any("Rename a Bot" in b for b in bodies))
        # third run: same fixtures -> everything deduped
        r = run(self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("filed=0", r.stdout)
        self.assertEqual(len(self.prompts()), 2)

    def test_heading_change_same_key_is_deduped(self):
        self.assertEqual(run(self.env).returncode, 0)
        # same URL+heading, different body: must NOT refile
        write(self.site / "bots.md",
              BOTS_MD.replace("Steps here.", "Entirely new body text."))
        r = run(self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("filed=0", r.stdout)
        self.assertEqual(self.prompts(), [])

    def test_rss_failure_falls_back_to_html(self):
        env = dict(self.env)
        env["GROKBOT_WATCH_CHANGELOG_RSS"] = \
            "file://" + str(self.fx / "missing.xml")
        r = run(env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("falling back to html", r.stdout)
        self.assertIn("changelog html entries=2", r.stdout)
        seen = json.loads((self.state / "seen.json").read_text())
        # fallback contributes the h2 + h3 headings on top of the 7 docs heads
        self.assertEqual(len(seen["seen"]), 9)

    def test_all_sources_fail_exits_1(self):
        env = dict(self.env)
        env["GROKBOT_WATCH_CHANGELOG_RSS"] = "file:///nonexistent/rss.xml"
        env["GROKBOT_WATCH_CHANGELOG_PAGE"] = "file:///nonexistent/page.html"
        env["GROKBOT_WATCH_DOCS_INDEX"] = "file:///nonexistent/index.html"
        r = run(env)
        self.assertEqual(r.returncode, 1)
        self.assertIn("all sources failed", r.stdout)
        self.assertFalse(self.state.exists())

    def test_docs_index_failure_still_files_changelog(self):
        env = dict(self.env)
        env["GROKBOT_WATCH_DOCS_INDEX"] = "file:///nonexistent/index.html"
        self.assertEqual(run(env).returncode, 0)
        # baseline seeded with changelog-only candidates; a later docs
        # recovery files the docs headings as new
        env2 = dict(self.env)
        r = run(env2)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertGreater(len(self.prompts()), 0)

    def test_dry_run_writes_nothing(self):
        env = dict(self.env)
        r = run(env, "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dry-run", r.stdout)
        self.assertFalse(self.state.exists())
        # and after a real baseline, dry-run reports new=0 filed=0
        run(env)
        r = run(env, "--dry-run")
        self.assertIn("filed=0", r.stdout)

    def test_max_defers_overflow_to_next_run(self):
        self.assertEqual(run(self.env).returncode, 0)
        # add 3 new changelog items, cap at 1
        items = "".join(
            "<item><title>Extra %d</title>"
            "<link>https://x.ai/changelog/bot#v1.3.%d</link>"
            "<pubDate>Thu, 04 Sep 2026 00:00:00 GMT</pubDate>"
            "<description>d%d</description></item>" % (i, i, i)
            for i in range(3))
        write(self.fx / "rss.xml", RSS.replace("</channel>", items + "</channel>"))
        env = dict(self.env, GROKBOT_WATCH_MAX_IDEAS="1")
        r = run(env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("deferred=2", r.stdout)
        self.assertEqual(len(self.prompts()), 1)
        # next run (default cap) files the deferred two
        r = run(self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.prompts()), 3)

    def test_prompt_file_shape(self):
        self.assertEqual(run(self.env).returncode, 0)
        write(self.fx / "rss.xml", RSS.replace(
            "</channel>",
            "<item><title>Shape Check</title>"
            "<link>https://x.ai/changelog/bot#v2.0.0</link>"
            "<pubDate>Fri, 05 Sep 2026 00:00:00 GMT</pubDate>"
            "<description>Prose &amp; entities.</description></item></channel>"))
        run(self.env)
        prompts = self.prompts()
        self.assertEqual(len(prompts), 1)
        body = prompts[0].read_text()
        self.assertIn("RQ-GROKBOT-IDEA-", body.splitlines()[0])
        self.assertIn("Kind: changelog", body)
        self.assertIn("https://x.ai/changelog/bot#v2.0.0", body)
        self.assertIn("Shape Check", body)
        self.assertIn("Prose & entities.", body)
        ledger = (self.state / "index.jsonl").read_text().strip().splitlines()
        self.assertEqual(len(ledger), 1)
        self.assertEqual(json.loads(ledger[0])["kind"], "changelog")

    def test_json_summary(self):
        r = run(self.env, "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        summary = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertEqual(summary["mode"], "baseline-seeded")
        self.assertTrue(summary["dry_run"] is False)


if __name__ == "__main__":
    unittest.main()
