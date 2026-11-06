import fcntl
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import state_snapshot  # noqa: E402
import snapshot_publish  # noqa: E402
import snapshot_publish_guarded as guarded  # noqa: E402

SCRIPT = HERE / 'snapshot_publish_guarded.py'


class FakeClock:
    def __init__(self, start=1000.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class Waits:
    """Fake interruptible wait: advances the fake clock, fires hooks in order."""

    def __init__(self, clock, hooks=()):
        self.clock, self.hooks = clock, list(hooks)

    def __call__(self, seconds):
        self.clock.advance(seconds)
        if self.hooks:
            self.hooks.pop(0)()
        return True


class GuardedPublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'fleet-state'
        self.dest = self.base / 'snapshots'
        self.dest.mkdir()
        for rel, text in {
            'queue/router-queue.md': 'FAKE router queue row\n',
            'queue/ready.tsv': 'job\tlane\njob-fake-1\tlane-fake\n',
            'queue/slots.json': '{"lane-fake": {"open": 1}}\n',
            'leader/VISION.md': 'FAKE vision\n',
            'leader/ORCHESTRATION.md': 'FAKE orchestration\n',
            'metrics/jobs.jsonl': '{"job": "job-fake-1"}\n',
        }.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.pause = self.base / 'pressure.pause'
        self.clock = FakeClock()

    def args(self, *extra):
        return ['--root', str(self.root), '--destination', str(self.dest),
                '--pause-file', str(self.pause), '--interval', '1',
                '--retain', '3', *extra]

    def publisher(self, interval=1.0):
        return snapshot_publish.Publisher(self.root, self.dest, interval, 3)

    def guard(self, deadline=10.0, waits=None):
        return guarded.Guarded(self.publisher(), self.pause, deadline,
                               clock=self.clock,
                               wait=waits or Waits(self.clock))

    def pointer(self):
        target = self.dest / 'latest.json'
        return json.loads(target.read_bytes()) if target.exists() else None

    def gens(self):
        return [p.name for p in snapshot_publish.generations(self.dest)]

    def current(self):
        point = self.pointer()
        self.assertIsNotNone(point)
        gen = self.dest / point['generation']
        check = state_snapshot.verify_snapshot(gen)
        self.assertTrue(check['ok'], check['errors'])
        self.assertEqual(point['manifestSha256'],
                         state_snapshot.sha256_file(gen / 'manifest.json'))
        return point, gen

    def test_pressure_at_start_leaves_pointer_and_generations(self):
        self.pause.write_text('{"owner": "phantom.pressure-watch.v1"}\n')
        g = self.guard(deadline=5.0)
        self.assertEqual(g.run(), 0)
        summary = g.summary()
        self.assertEqual(summary['stop'], 'deadline')
        self.assertEqual(summary['paused'], 5)
        self.assertTrue(summary['endedPaused'])
        self.assertEqual(summary['attempted'], 0)
        self.assertEqual(summary['published'], 0)
        self.assertIsNone(self.pointer())
        self.assertEqual(self.gens(), [])
        self.assertEqual(  # sentinel never read, unlinked or altered
            self.pause.read_text(), '{"owner": "phantom.pressure-watch.v1"}\n')
        self.assertNotIn('job-fake-1', json.dumps(summary))  # metadata only

    def test_sentinel_removal_resumes_verified_publication(self):
        self.pause.write_text('pause\n')
        g = self.guard(deadline=10.0, waits=Waits(self.clock,
                                                  hooks=[self.pause.unlink]))
        self.assertEqual(g.run(max_cycles=1), 1)
        self.assertEqual(g.reason, 'max-cycles')
        self.assertEqual(g.paused, 1)
        self.assertEqual(g.publisher.count, 1)
        self.current()

    def test_returning_pressure_skips_subsequent_copies(self):
        raise_pause = lambda: self.pause.write_text('pause\n')  # noqa: E731
        g = self.guard(deadline=6.0, waits=Waits(self.clock,
                                                 hooks=[raise_pause]))
        self.assertEqual(g.run(max_cycles=5), 1)
        self.assertEqual(g.publisher.count, 1)   # only the first cycle ran
        self.assertEqual(g.paused, 5)
        self.assertEqual(g.reason, 'deadline')
        point, gen = self.current()
        self.assertEqual(self.gens(), [gen.name])  # last verified snapshot kept

    def test_symlink_and_unreadable_sentinels_fail_closed(self):
        self.pause.symlink_to(self.root / 'leader/VISION.md')
        g = self.guard(deadline=3.0)
        self.assertEqual(g.run(), 0)
        self.assertEqual(g.paused, 3)
        self.assertEqual(g.publisher.count, 0)
        self.assertTrue(self.pause.is_symlink())  # never followed or unlinked
        blocker = self.base / 'blocker'
        blocker.write_text('not a directory\n')
        g = guarded.Guarded(self.publisher(), blocker / 'pause', 3.0,
                            clock=self.clock, wait=Waits(self.clock))
        self.assertEqual(g.run(), 0)             # ENOTDIR lstat -> paused
        self.assertEqual(g.publisher.count, 0)
        self.assertIsNone(self.pointer())
        self.assertEqual(self.gens(), [])
        self.assertTrue(blocker.is_file() and not blocker.is_symlink())

    def test_max_cycles_bounds_attempts_not_pause_polls(self):
        self.pause.write_text('pause\n')
        hooks = [lambda: None, lambda: None, self.pause.unlink]
        g = self.guard(deadline=50.0, waits=Waits(self.clock, hooks=hooks))
        self.assertEqual(g.run(max_cycles=2), 2)
        self.assertEqual(g.reason, 'max-cycles')
        self.assertEqual(g.paused, 3)            # polls never consumed attempts
        self.assertEqual(g.publisher.count, 2)
        point, _gen = self.current()

    def test_second_publisher_cannot_overlap(self):
        fd = os.open(self.dest / 'publisher.lock',
                     os.O_RDWR | os.O_CREAT | state_snapshot.NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(
                guarded.main(self.args('--deadline', '5', '--max-cycles', '1')),
                1)
            self.assertIsNone(self.pointer())
            self.assertEqual(self.gens(), [])
        finally:
            os.close(fd)
        self.assertEqual(
            guarded.main(self.args('--deadline', '60', '--max-cycles', '1')), 0)
        self.current()

    def test_main_rejects_unbounded_values(self):
        cases = (['--deadline', '0'], ['--deadline', 'nan'],
                 ['--deadline', '999999'],
                 ['--deadline', '5', '--max-cycles', '0'],
                 ['--deadline', '5', '--interval', '0.5'],
                 ['--deadline', '5', '--retain', '0'])
        for extra in cases:
            with self.assertRaises(SystemExit) as ctx:
                guarded.main(self.args(*extra))
            self.assertEqual(ctx.exception.code, 2, extra)

    def test_sigterm_wakes_paused_wait_and_releases_lock(self):
        self.pause.write_text('pause\n')
        proc = subprocess.Popen(
            [sys.executable, str(SCRIPT), *self.args('--interval', '30',
                                                    '--deadline', '300')],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            # Wait for the pause-episode line: handlers are installed and the
            # wrapper is inside its interruptible wait once it is emitted.
            ready, _, _ = select.select([proc.stdout], [], [], 15)
            first = proc.stdout.readline() if ready else ''
            proc.send_signal(signal.SIGTERM)
            out, err = proc.communicate(timeout=15)
            out = first + out
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        self.assertEqual(proc.returncode, 1, err)
        summary = json.loads(out.strip().splitlines()[-1])
        self.assertEqual(summary['stop'], 'signal-15')
        self.assertEqual(summary['published'], 0)
        self.assertGreaterEqual(summary['paused'], 1)
        self.assertTrue(summary['endedPaused'])
        self.assertNotIn('job-fake-1', out + err)  # never file contents
        self.assertIsNone(self.pointer())
        self.assertEqual(self.gens(), [])
        fd = os.open(self.dest / 'publisher.lock', os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # lock released
        finally:
            os.close(fd)


if __name__ == '__main__':
    unittest.main()
