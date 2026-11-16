"""Fixture tests for contrib/mac/self-supply.py (RQ-SELFSUPPLYN9BQ8).

Every case builds a synthetic ~/.ashlr-runs/queue in a temp HOME, points
--feeds-dir at fixture feed scripts and invokes self-supply.py as a
subprocess; nothing touches the real ~/.ashlr-runs, the network or the live
router queue. Covers: idle lanes get lines stamped pool=<lane>, full lanes and
held lanes get none, dedupe against router-queue.md, ready.tsv and earlier
lanes, the 12-line run cap and the per-lane free bound, --apply appending under
ready.lock with SELF_SUPPLY events, feeds without --pool support, and dry-run
(the default) writing nothing.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'self-supply.py'

FEED = '''import argparse, json
p = argparse.ArgumentParser()
p.add_argument('--dry-run', action='store_true')
p.add_argument('--apply', action='store_true')
p.add_argument('--queue')
p.add_argument('--max', type=int, default=6)
p.add_argument('--pool')
a = p.parse_args()
pool = (a.pool or 'open').upper().replace('-', '')
print(json.dumps({'lines': ['- READY RQ-FS%s-%02d (P0, tier=work, repo=phantom): fixture %d'
                            % (pool, i, i) for i in range(1, a.max + 1)]}))
'''

# A feed written before --pool existed: argparse exits 2 on the unknown flag and
# self-supply must retry without it and stamp pool= itself.
STRICT_FEED = '''import argparse, json
p = argparse.ArgumentParser()
p.add_argument('--dry-run', action='store_true')
p.add_argument('--apply', action='store_true')
p.add_argument('--queue')
p.add_argument('--max', type=int, default=6)
a = p.parse_args()
print(json.dumps({'lines': ['- READY RQ-SALV-%02d (P0, tier=work, repo=phantom): fixture %d'
                            % (i, i) for i in range(1, a.max + 1)]}))
'''


class Fixture(tempfile.TemporaryDirectory):
    def __enter__(self):
        return Path(super().__enter__())


def build(lanes, queue_md='', ready='', hold='', feeds={'recut-feed.py': FEED}):
    tmp = Fixture()
    home = Path(tmp.name)
    queue = home / '.ashlr-runs' / 'queue'
    queue.mkdir(parents=True)
    (queue / 'status.json').write_text(json.dumps({'lanes': lanes}))
    (queue / 'router-queue.md').write_text(queue_md)
    (queue / 'ready.tsv').write_text(ready)
    if hold:
        (home / '.ashlr-runs' / 'HOLD').write_text(hold)
    fdir = home / 'feeds'
    fdir.mkdir()
    for name, src in feeds.items():
        (fdir / name).write_text(src)
    return tmp


def supply(home, *args):
    env = {'HOME': str(home), 'PATH': os.environ.get('PATH', '/usr/bin:/bin')}
    return subprocess.run([sys.executable, '-B', str(SCRIPT),
                           '--feeds-dir', str(home / 'feeds'), *args],
                          env=env, capture_output=True, text=True, timeout=90)


def report(home, *args):
    done = supply(home, *args)
    assert done.returncode == 0, done.stderr + done.stdout
    return json.loads(done.stdout)


def queue_text(home):
    return (home / '.ashlr-runs' / 'queue' / 'router-queue.md').read_text()


def events(home):
    path = home / '.ashlr-runs' / 'dispatch-events.log'
    return path.read_text() if path.exists() else ''


class SelfSupplyTests(unittest.TestCase):
    def test_idle_lane_gets_lines_dry_run_then_apply(self):
        with build({'codex-personal': {'target': 4, 'running': 1, 'queued': 1}},
                   queue_md='- READY RQ-LEADER-1 (P0): seeded\n') as home:
            plan = report(home)
            self.assertTrue(plan['dryRun'])
            self.assertEqual(plan['added'], 2)
            self.assertEqual(plan['lanes']['codex-personal'], {'free': 2, 'added': 2})
            self.assertTrue(all('pool=codex-personal' in line for line in plan['lines']))
            self.assertEqual(queue_text(home), '- READY RQ-LEADER-1 (P0): seeded\n')
            self.assertFalse((home / '.ashlr-runs/queue/ready.lock').exists())
            self.assertEqual(events(home), '')
            applied = report(home, '--apply')
            self.assertFalse(applied['dryRun'])
            self.assertEqual(applied['added'], 2)
            text = queue_text(home)
            self.assertRegex(text, r'- READY RQ-FSCODEXPERSONAL-01 \(P0, tier=work, repo=phantom, pool=codex-personal, enq=\d+\)')
            self.assertIn('SELF_SUPPLY codex-personal free=2 added=2', events(home))
            self.assertEqual(report(home, '--apply')['added'], 0)   # every id now present

    def test_full_lane_gets_none(self):
        with build({'claude': {'target': 3, 'running': 3, 'queued': 0},
                    'devin': {'target': 6, 'running': 5, 'queued': 1}}) as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 0)
            self.assertEqual(plan['lanes']['claude'], {'free': 0, 'added': 0})
            self.assertEqual(plan['feeds'], {'recut-feed.py': 'idle', 'salvage-feed.py': 'absent'})
            self.assertEqual(queue_text(home), '')
            self.assertEqual(events(home), '')   # nothing attempted -> nothing logged

    def test_held_lane_gets_none(self):
        with build({'devin': {'target': 6, 'running': 0, 'queued': 0, 'held': True},
                    'codex-local': {'target': 1, 'running': 0, 'queued': 0}},
                   hold='codex-local\n') as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 0)
            self.assertEqual(plan['lanes']['devin'], {'held': True, 'added': 0})
            self.assertEqual(plan['lanes']['codex-local'], {'held': True, 'added': 0})
            self.assertEqual(queue_text(home), '')

    def test_dedupe_queue_ready_and_second_run(self):
        existing = '- READY RQ-FSCODEXPERSONAL-01 (P0): taken\n'
        with build({'codex-personal': {'target': 5, 'running': 0, 'queued': 0}},
                   queue_md=existing, ready='RQ-FSCODEXPERSONAL-02\tphantom\tcodex-personal\twork\tp.md\n') as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 3)
            self.assertGreaterEqual(plan['skipped']['duplicate'], 2)
            text = queue_text(home)
            self.assertEqual(text.count('RQ-FSCODEXPERSONAL-01'), 1)
            self.assertNotIn('RQ-FSCODEXPERSONAL-02', text.splitlines()[-3:].__str__())

    def test_run_cap_and_per_lane_bound(self):
        with build({'codex-personal': {'target': 20, 'running': 0, 'queued': 0},
                    'devin': {'target': 20, 'running': 0, 'queued': 0}}) as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 12)
            self.assertEqual(plan['lanes']['codex-personal']['added'], 12)
            self.assertEqual(plan['lanes']['devin']['added'], 0)
            self.assertGreater(plan['skipped']['cap'], 0)
        with build({'devin': {'target': 2, 'running': 0, 'queued': 0}}) as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 2)   # free slots bound the lane even under the cap

    def test_salvage_feed_when_present_and_pool_fallback(self):
        with build({'devin': {'target': 4, 'running': 0, 'queued': 0}},
                   feeds={'salvage-feed.py': STRICT_FEED}) as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 4)
            self.assertEqual(plan['feeds'], {'recut-feed.py': 'absent', 'salvage-feed.py': 'ok'})
            self.assertTrue(all('pool=devin' in line for line in plan['lines']))

    def test_both_feeds_dedupe_across_sources(self):
        two = {'recut-feed.py': FEED, 'salvage-feed.py': STRICT_FEED}
        with build({'devin': {'target': 6, 'running': 0, 'queued': 0}}, feeds=two) as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 6)   # recut fills the lane; salvage stays idle
            self.assertEqual(plan['feeds']['salvage-feed.py'], 'idle')

    def test_lock_timeout_leaves_queue_unchanged(self):
        with build({'devin': {'target': 2, 'running': 0, 'queued': 0}},
                   queue_md='- READY RQ-LEADER-1 (P0): seeded\n') as home:
            lock_path = home / '.ashlr-runs/queue/ready.lock'
            with lock_path.open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                done = supply(home, '--apply', '--lock-timeout', '0.05')
            self.assertEqual(done.returncode, 1)
            self.assertIn('TimeoutError', done.stdout)
            self.assertEqual(queue_text(home), '- READY RQ-LEADER-1 (P0): seeded\n')

    def test_feed_error_never_fails_the_run(self):
        with build({'devin': {'target': 2, 'running': 0, 'queued': 0}},
                   feeds={'recut-feed.py': 'import sys\nsys.exit(3)\n'}) as home:
            plan = report(home, '--apply')
            self.assertEqual(plan['added'], 0)
            self.assertTrue(plan['feeds']['recut-feed.py'].startswith('error: exit 3'))


if __name__ == '__main__':
    unittest.main()
