"""Tests for contrib/mac/install-gate.py (RQ-LOADGATE-1 install semaphore): one npm ci / pnpm install / bun install at a
time fleet-wide through flock on queue/install.lock. Fake package managers log start/end so overlap is observable."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

GATE = Path(__file__).resolve().parents[1] / 'install-gate.py'
spec = importlib.util.spec_from_file_location('install_gate', GATE)
ig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ig)


def fake_tool(d, name, secs):
    p = Path(d) / name
    p.write_text('#!/bin/bash\necho "start $$ $*" >> "$FAKE_LOG"\n'
                 'cat "$LOCK" >> "$FAKE_HOLDER" 2>/dev/null\n'
                 f'sleep {secs}\necho "end $$" >> "$FAKE_LOG"\n')
    p.chmod(0o755)
    return p


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = Path(self.tmp.name)
        self.lock = self.d / 'queue' / 'install.lock'
        self.log = self.d / 'fake.log'
        self.holder = self.d / 'holder.log'
        self.env = {**os.environ, 'FAKE_LOG': str(self.log), 'LOCK': str(self.lock), 'FAKE_HOLDER': str(self.holder), 'HOME': str(self.d)}

    def gate(self, *args, **kw):
        return subprocess.Popen([sys.executable, '-B', str(GATE), '--lock', str(self.lock), *args], env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kw)

    def lines(self):
        return self.log.read_text().splitlines() if self.log.exists() else []


class MatcherTests(unittest.TestCase):
    def test_guarded_installs(self):
        for argv in (['npm', 'ci'], ['/usr/local/bin/npm', 'ci', '--ignore-scripts'], ['pnpm', 'install'], ['pnpm', 'i'],
                     ['bun', 'install'], ['npm', '--prefix=x', 'install'], ['npm', 'install', 'left-pad']):
            self.assertTrue(ig.is_install(argv), argv)

    def test_other_commands_not_guarded(self):
        for argv in (['npm', 'run', 'build'], ['npm', 'test'], ['pnpm', 'run', 'install'], ['bun', 'run', 'x'], ['git', 'ci'],
                     ['yarn', 'install'], ['npm'], []):
            self.assertFalse(ig.is_install(argv), argv)


class MutualExclusionTests(Base):
    def test_two_installs_never_overlap(self):
        tool = fake_tool(self.d, 'npm', 0.6)
        a = self.gate('--job', 'A', '--', str(tool), 'ci')
        time.sleep(0.2)
        b = self.gate('--job', 'B', '--', str(tool), 'ci')
        for p in (a, b):
            p.communicate(timeout=30)
            self.assertEqual(p.returncode, 0)
        kinds = [ln.split()[0] for ln in self.lines()]
        self.assertEqual(kinds, ['start', 'end', 'start', 'end'], self.lines())

    def test_holder_recorded_while_running_and_cleared_after(self):
        tool = fake_tool(self.d, 'pnpm', 0.3)
        p = self.gate('--job', 'RQ-H', '--', str(tool), 'install')
        p.communicate(timeout=30)
        held = json.loads(self.holder.read_text().splitlines()[0])
        self.assertEqual((held['job'], held['command'].split()[-1]), ('RQ-H', 'install'))
        self.assertEqual(self.lock.read_text(), '')

    def test_waiter_times_out_with_75(self):
        tool = fake_tool(self.d, 'bun', 2.5)
        a = self.gate('--', str(tool), 'install')
        time.sleep(0.4)
        b = self.gate('--timeout', '1', '--', str(tool), 'install')
        out, err = b.communicate(timeout=30)
        self.assertEqual(b.returncode, 75)
        self.assertIn('timed out', err)
        a.communicate(timeout=30)
        self.assertEqual(sum(1 for ln in self.lines() if ln.startswith('start')), 1)

    def test_crashed_holder_does_not_wedge_the_lock(self):
        tool = fake_tool(self.d, 'npm', 30)
        a = self.gate('--', str(tool), 'ci')
        time.sleep(0.5)
        a.kill()   # SIGKILL: no cleanup runs, the kernel drops the flock
        a.communicate()
        subprocess.run(['pkill', '-f', str(tool)], check=False)
        b = self.gate('--timeout', '5', '--', str(fake_tool(self.d, 'npm2', 0.1).rename(self.d / 'npm')), 'ci')
        b.communicate(timeout=30)
        self.assertEqual(b.returncode, 0)

    def test_non_install_runs_unlocked_and_concurrently(self):
        tool = fake_tool(self.d, 'npm', 0.8)
        a = self.gate('--', str(tool), 'run', 'build')
        b = self.gate('--', str(tool), 'run', 'test')
        time.sleep(0.4)
        self.assertEqual([ln.split()[0] for ln in self.lines()], ['start', 'start'])
        for p in (a, b):
            p.communicate(timeout=30)

    def test_exit_code_passthrough(self):
        tool = self.d / 'npm'
        tool.write_text('#!/bin/bash\nexit 7\n')
        tool.chmod(0o755)
        p = self.gate('--', str(tool), 'ci')
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 7)
        self.assertEqual(self.lock.read_text(), '')

    def test_missing_command_and_bad_usage(self):
        p = self.gate('--', str(self.d / 'nope' / 'npm'), 'ci')
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 127)
        p = self.gate('--bogus')
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 2)
        p = self.gate('--timeout', 'x', '--', 'npm', 'ci')
        p.communicate(timeout=30)
        self.assertEqual(p.returncode, 2)


class ShimTests(Base):
    def test_shims_route_installs_through_the_lock(self):
        shims = self.d / 'shims'
        real = self.d / 'real'
        real.mkdir()
        fake_tool(real, 'npm', 0.2)
        r = subprocess.run([sys.executable, str(GATE), '--shims', str(shims)], env=self.env)
        self.assertEqual(r.returncode, 0)
        self.assertTrue(all(os.access(shims / t, os.X_OK) for t in ('npm', 'pnpm', 'bun')))
        env = {**self.env, 'PATH': f'{shims}:{real}:/usr/bin:/bin', 'ASHLR_RUNS_DIR': str(self.d)}
        env['LOCK'] = str(self.d / 'queue' / 'install.lock')
        r = subprocess.run([str(shims / 'npm'), 'ci'], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(self.holder.exists(), 'the real npm ran while the shim held queue/install.lock')
        r = subprocess.run([str(shims / 'pnpm'), 'install'], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 127)   # no real pnpm on PATH
        self.assertIn('not found', r.stderr)


if __name__ == '__main__':
    unittest.main()
