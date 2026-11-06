"""Append-race regression tests for contrib/mac/restock.py (RQ-PHX-RESTOCKAPPENDRACE31).

restock.py reads router-queue.md once up front and rewrites the whole file at
the end via os.replace; a writer appending in between used to have its lines
erased (on Oct 31 one pass lost 9 of 9 leader lines). These tests block a real
restock subprocess inside its mid-run `ps` call — after the early read, before
the rewrite — by putting a fake `ps` first on PATH, append leader lines to the
live queue, then release it. The appended lines must survive the rewrite
verbatim and the lines restock claimed must still read CLAIMED.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'restock.py'
LANES = ['codex-cmp', 'codex-personal', 'devin', 'codex-local', 'claude-api']

# Fake `ps`: marks that restock reached its mid-run subprocess call, then waits
# for the release file before exiting with an empty listing. The 30s cap keeps
# a broken run from hanging the suite.
FAKE_PS = '''#!/bin/sh
printf x > "%s"
n=0
while [ ! -f "%s" ] && [ $n -lt 600 ]; do
  sleep 0.05
  n=$((n + 1))
done
exit 0
'''


def build(md):
    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name)
    q = home / '.ashlr-runs' / 'queue'
    (q / 'prompts').mkdir(parents=True)
    (q / 'run').mkdir()
    (home / '.ashlr-runs' / 'metrics').mkdir()
    (home / '.ashlr-runs' / 'metrics' / 'jobs.jsonl').write_text('')
    (home / 'Projects' / 'ashlrai' / 'phantom').mkdir(parents=True)
    (q / 'router-queue.md').write_text(md)
    (q / 'status.json').write_text(json.dumps(
        {'lanes': {'devin': {'running': 0, 'queued': 0}}}))
    slots = {l: {'held': True} for l in LANES}
    slots['claude-api'] = {'target': 0}
    slots['devin'] = {'target': 6}
    (q / 'slots.json').write_text(json.dumps(slots))
    (q / 'claimed.tsv').write_text('')
    (q / 'ready.tsv').write_text('')
    return tmp


def line(job, text='routine fix', **attrs):
    p = attrs.pop('P', None)
    toks = ([f'P{p}'] if p is not None else []) + [f'{k}={v}' for k, v in attrs.items()]
    return f'- READY {job} ({", ".join(toks)}): {text}'


def restock_with_append(home, appended):
    """Run restock.py while `appended` text lands on router-queue.md mid-run.

    Returns (returncode, stdout, stderr) of the finished restock subprocess.
    """
    q = home / '.ashlr-runs' / 'queue'
    started = home / 'ps_started'
    release = home / 'ps_release'
    fakebin = home / 'fakebin'
    fakebin.mkdir()
    fake = fakebin / 'ps'
    fake.write_text(FAKE_PS % (started, release))
    fake.chmod(0o755)
    env = {'HOME': str(home),
           'PATH': str(fakebin) + ':' + os.environ.get('PATH', '/usr/bin:/bin')}
    proc = subprocess.Popen([sys.executable, '-B', str(SCRIPT), '--per-lane', '4'],
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True)
    try:
        deadline = time.time() + 30
        while not started.exists():
            if proc.poll() is not None:
                raise AssertionError(
                    f'restock exited {proc.returncode} before the fake ps: '
                    f'{proc.stderr.read()}')
            if time.time() > deadline:
                raise AssertionError('restock never reached the fake ps')
            time.sleep(0.02)
        with open(q / 'router-queue.md', 'a') as f:
            f.write(appended)
        release.touch()
        out, err = proc.communicate(timeout=60)
    except BaseException:
        release.touch()
        proc.kill()
        proc.wait()
        raise
    return proc.returncode, out, err


class AppendRaceTests(unittest.TestCase):
    def test_appended_line_survives_and_claims_stay_claimed(self):
        picks = [line(f'RQ-AR-PICK-{k}', P=1, pool='devin', tier='mid',
                      repo='phantom', text=f'pick me {k}') for k in (1, 2)]
        rows = ['# fixture queue', ''] + picks + ['Freeform operator note survives.']
        leader = line('RQ-AR-LEAD-1', P=2, pool='devin', tier='mid',
                      repo='phantom', text='appended mid-run by the leader')
        tmp = build('\n'.join(rows) + '\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        rc, out, err = restock_with_append(home, leader + '\n')
        self.assertEqual(rc, 0, err)
        md_lines = (home / '.ashlr-runs' / 'queue' / 'router-queue.md').read_text().splitlines()
        # the leader line rode the rewrite through, verbatim, at the tail
        self.assertEqual(md_lines[-1], leader)
        for j in ('RQ-AR-PICK-1', 'RQ-AR-PICK-2'):
            row = [l for l in md_lines if j in l][0]
            self.assertTrue(row.startswith('- CLAIMED '), row)
            self.assertIn(j, out)
        # the appended line was never part of this pass: still READY, not claimed
        self.assertNotIn('CLAIMED RQ-AR-LEAD-1', '\n'.join(md_lines))
        claimed = (home / '.ashlr-runs' / 'queue' / 'claimed.tsv').read_text()
        self.assertIn('RQ-AR-PICK-1', claimed)
        self.assertIn('RQ-AR-PICK-2', claimed)
        self.assertNotIn('RQ-AR-LEAD-1', claimed)
        self.assertIn('Freeform operator note survives.', md_lines)

    def test_all_nine_leader_lines_survive(self):
        # the Oct 31 incident shape: nine leader lines appended mid-pass.
        picks = [line('RQ-AR9-PICK-1', P=1, pool='devin', tier='mid',
                      repo='phantom', text='pick me')]
        leader = [line(f'RQ-AR9-LEAD-{k}', P=2, pool='devin', tier='mid',
                       repo='phantom', text=f'leader line {k}')
                  for k in range(1, 10)]
        tmp = build('\n'.join(['# fixture queue', ''] + picks) + '\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        rc, out, err = restock_with_append(home, '\n'.join(leader) + '\n')
        self.assertEqual(rc, 0, err)
        md_lines = (home / '.ashlr-runs' / 'queue' / 'router-queue.md').read_text().splitlines()
        self.assertEqual(md_lines[-len(leader):], leader)
        pick_row = [l for l in md_lines if 'RQ-AR9-PICK-1' in l][0]
        self.assertTrue(pick_row.startswith('- CLAIMED '), pick_row)


if __name__ == '__main__':
    unittest.main()
