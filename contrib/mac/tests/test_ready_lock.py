"""ready.lock scope tests (RQ-READYLOCK-SCOPE).

dispatchd.py used to hold an exclusive flock on queue/ready.lock for its whole
tick (4+ min on the 00:31 tick), so restock.py and sync-router-queue.py appends
blocked with no timeout. The lock now guards only the ready.tsv read and the
ready.tsv rewrite; every taker polls with a timeout and logs waits/timeouts.
"""
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_dispatchd as td  # noqa: E402

SLOW_PACE = ('#!/usr/bin/python3\n'
             'import json, sys, time\n'
             'open(sys.argv[0] + ".started", "w").write("x")\n'
             'time.sleep(3)\n'
             'json.dump({"target": 0, "held": True, "reason": "slow fixture"}, sys.stdout)\n')


def slow_tick_fixture(ready):
    slots = td.held_lanes()
    slots['claude-api'] = {'target': 1, 'floor': 0, 'ceiling': 8, 'last_change': 0}
    tmp = td.build(slots=slots, ready=ready)
    home = Path(tmp.name)
    (home / '.ashlr-runs' / 'bin' / 'autopilot.py').write_text(td.AP_GREEN)
    (home / '.ashlr-runs' / 'bin' / 'claude-api.py').write_text(SLOW_PACE)
    return tmp, home


def append_ready(home, text, timeout):
    """restock.py's append step: take ready.lock with a timeout, then append."""
    q = home / '.ashlr-runs' / 'queue'
    deadline = time.monotonic() + timeout
    with open(q / 'ready.lock', 'a') as lk:
        while True:
            try:
                fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() > deadline:
                    return False
                time.sleep(0.02)
        with open(q / 'ready.tsv', 'a') as f:
            f.write(text)
    return True


class SlowTickTests(unittest.TestCase):
    def test_writer_completes_while_slow_tick_runs_and_line_survives(self):
        # a ready line the tick will keep (lane held), so the rewrite must carry the appended one too
        q_line = 'RQ-RL-KEEP\tphantom\tdevin\twork\t/nonexistent/p.md'
        tmp, home = slow_tick_fixture([q_line])
        self.addCleanup(tmp.cleanup)
        env = {'HOME': str(home), 'LANG': 'C',
               'PATH': str(home / 'stubbin') + ':' + os.environ.get('PATH', '/usr/bin:/bin')}
        proc = subprocess.Popen([sys.executable, '-B', str(td.SCRIPT)], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            started = home / '.ashlr-runs' / 'bin' / 'claude-api.py.started'
            deadline = time.time() + 30
            while not started.exists():
                if proc.poll() is not None:   # message built lazily: stderr.read() would block until exit
                    self.fail('tick exited before the slow step: ' + proc.stderr.read())
                self.assertLess(time.time(), deadline, 'tick never reached the slow step')
                time.sleep(0.02)
            t0 = time.monotonic()
            late = 'RQ-RL-LATE\tphantom\tdevin\twork\t/nonexistent/late.md\n'
            self.assertTrue(append_ready(home, late, timeout=1.5))
            self.assertLess(time.monotonic() - t0, 1.5)
            self.assertIsNone(proc.poll(), 'writer should finish while the tick is still running')
            out, err = proc.communicate(timeout=60)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        self.assertEqual(proc.returncode, 0, err)
        ready = (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text()
        self.assertIn('RQ-RL-KEEP', ready)
        self.assertIn('RQ-RL-LATE', ready, 'line appended mid-tick was erased by the rewrite')

    def test_tick_skips_and_logs_when_lock_stays_held(self):
        tmp, home = slow_tick_fixture([])
        self.addCleanup(tmp.cleanup)
        q = home / '.ashlr-runs' / 'queue'
        with open(q / 'ready.lock', 'a') as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            r = td.tick(home, {'ASHLR_READY_LOCK_TIMEOUT': '0.3'})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('READY_LOCK_TIMEOUT dispatchd-read', td.events(home))

    def test_wait_is_logged_when_lock_frees_late(self):
        tmp, home = slow_tick_fixture([])
        self.addCleanup(tmp.cleanup)
        q = home / '.ashlr-runs' / 'queue'
        lk = open(q / 'ready.lock', 'a')
        fcntl.flock(lk, fcntl.LOCK_EX)
        env = {'HOME': str(home), 'LANG': 'C', 'ASHLR_READY_LOCK_TIMEOUT': '30',
               'PATH': str(home / 'stubbin') + ':' + os.environ.get('PATH', '/usr/bin:/bin')}
        proc = subprocess.Popen([sys.executable, '-B', str(td.SCRIPT)], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(9)   # outlasts the tick's slow preamble so it reaches the lock while it is held
        lk.close()
        out, err = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 0, err)
        self.assertIn('READY_LOCK_WAIT dispatchd-read', td.events(home))


if __name__ == '__main__':
    unittest.main()
