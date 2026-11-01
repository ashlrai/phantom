#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import memory_admission as admission
import pressure_watch as monitor

GIB = 1024 ** 3


class PressureWatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.pause = self.base / 'PAUSE'
        self.root = self.base / 'watch'
        self.now = 1000
        self.sample = dict(pressureLevel=1, totalBytes=32 * GIB, availableBytes=16 * GIB,
                           swapUsedBytes=GIB, compressorBytes=GIB)
        self.watch = self.new_watch()
        self.admit = admission.Admission(self.base / 'admission', self.pause, reserve_bytes=GIB)
        self.admit.enqueue()
        self.addCleanup(self.admit.close)
        self.snapshot = admission.Snapshot(32 * GIB, 16 * GIB, GIB)

    def new_watch(self):
        return monitor.Watch(self.pause, self.root, lambda: self.sample, lambda: self.now)

    def tick(self, seconds=0):
        self.now += seconds
        return self.watch.tick()

    def test_warning_recovery_and_admission(self):
        self.sample['pressureLevel'] = 2
        self.assertIn('pressure', self.tick())
        self.assertEqual(self.admit.attempt(self.snapshot), 'paused')
        self.sample['pressureLevel'] = 1
        self.tick(60)
        self.tick(60)
        self.assertEqual(self.admit.attempt(self.snapshot), 'paused')
        self.tick(60)
        self.assertFalse(self.pause.exists())
        self.assertIsNone(self.admit.attempt(self.snapshot))
        observation = json.loads((self.root / 'memguard.json').read_text())
        self.assertEqual(observation['timestamp'], self.now)
        self.assertEqual(observation['freeMemoryPercent'], 50)
        self.assertEqual(observation['compressorBytes'], GIB)

    def test_restart_keeps_pause_and_recovery_history(self):
        self.sample['pressureLevel'] = 2
        self.tick()
        payload = self.pause.read_bytes()
        self.sample['pressureLevel'] = 1
        self.tick(60)
        self.watch = self.new_watch()
        self.assertEqual(self.pause.read_bytes(), payload)
        self.tick(60)
        self.assertEqual(self.admit.attempt(self.snapshot), 'paused')
        self.watch = self.new_watch()
        self.tick(60)
        self.assertFalse(self.pause.exists())

    def test_external_sentinels_survive(self):
        self.pause.write_text('operator PAUSE')
        for i in range(4):
            self.tick(60 if i else 0)
        self.assertEqual(self.pause.read_text(), 'operator PAUSE')
        self.assertEqual(self.admit.attempt(self.snapshot), 'paused')
        self.pause.unlink()
        self.sample['pressureLevel'] = 2
        self.tick(60)
        self.pause.unlink()
        self.pause.write_text('another writer')
        self.sample['pressureLevel'] = 1
        for _ in range(3):
            self.tick(60)
        self.assertEqual(self.pause.read_text(), 'another writer')
        hold = self.base / 'HOLD'
        hold.write_text('operator HOLD')
        with self.assertRaises(ValueError):
            monitor.Watch(hold, self.root)
        self.assertEqual(hold.read_text(), 'operator HOLD')

    def test_missing_telemetry_and_malformed_state_hold(self):
        self.watch.sampler = lambda: (_ for _ in ()).throw(subprocess.TimeoutExpired('probe', 3))
        self.assertIn('telemetry-unavailable', self.tick())
        self.assertEqual(self.admit.attempt(self.snapshot), 'paused')
        observed = json.loads((self.root / 'memguard.json').read_text())
        self.assertIsNone(observed['swapUsedBytes'])
        self.assertIsNone(observed['availableBytes'])
        self.watch.sampler = lambda: self.sample
        (self.root / 'pressure-watch-state.json').write_text('{broken')
        for _ in range(4):
            self.assertIn('malformed-state', self.tick(60))
        self.assertEqual(self.admit.attempt(self.snapshot), 'paused')
        self.assertEqual((self.root / 'pressure-watch-state.json').read_text(), '{broken')

    def test_same_payload_replacement_is_not_owned(self):
        self.sample['pressureLevel'] = 2
        self.tick()
        replacement = self.base / 'replacement'
        replacement.write_bytes(self.pause.read_bytes())
        os.replace(replacement, self.pause)
        self.sample['pressureLevel'] = 1
        for _ in range(3):
            self.tick(60)
        self.assertTrue(self.pause.exists())
        self.assertEqual(self.admit.attempt(self.snapshot), 'paused')

    def test_growth_hysteresis_staleness_and_clock_reset(self):
        self.tick()
        self.sample['swapUsedBytes'] += 2_000_000_001
        self.assertIn('swap', self.tick(60))
        self.tick(60)
        self.assertTrue(self.pause.exists())
        self.sample['swapUsedBytes'] = GIB
        self.assertIn('stale-telemetry', self.tick(181))
        self.tick(60)
        self.tick(60)
        self.assertTrue(self.pause.exists())
        self.now -= 200
        self.assertIn('stale-telemetry', self.tick())
        self.assertTrue(self.pause.exists())

    def test_real_probe_parsing_and_timeout(self):
        vm = ('Mach Virtual Memory Statistics: (page size of 4096 bytes)\n'
              'Pages free: 100.\nPages speculative: 20.\nPages occupied by compressor: 30.\n')
        outputs = ['1\n', vm, str(1024 * 1024), 'total = 1G  used = 512M  free = 512M']
        with patch.object(monitor.subprocess, 'run') as run:
            run.side_effect = [subprocess.CompletedProcess([], 0, stdout=x) for x in outputs]
            sample = monitor.probe()
            self.assertEqual(sample['availableBytes'], 120 * 4096)
            self.assertEqual(sample['compressorBytes'], 30 * 4096)
            self.assertTrue(all(call.kwargs['timeout'] == 3 for call in run.call_args_list))
        with patch.object(monitor.subprocess, 'run', side_effect=subprocess.TimeoutExpired('x', 3)):
            with self.assertRaises(subprocess.TimeoutExpired):
                monitor.probe()

    def test_unsupported_platform_exits_clearly(self):
        with patch.object(monitor.sys, 'platform', 'linux'), patch.object(
                monitor.sys, 'argv', ['pressure_watch.py', '--once', '--pause-file', str(self.pause),
                                      '--state-dir', str(self.root)]):
            with self.assertRaises(SystemExit) as error:
                monitor.main()
        self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.pause.exists())


if __name__ == '__main__':
    unittest.main()
