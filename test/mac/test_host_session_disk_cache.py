import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('disk_cache', Path(__file__).parents[2] / 'contrib/mac/host_session_disk_cache.py')
disk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disk)


class DiskCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'tree'
        self.root.mkdir(mode=0o700)
        (self.root / 'file').write_bytes(b'x' * 4096)
        self.roots = [{'job': 'job', 'path': str(self.root)}]

    def test_cadence_history_and_stale_failed_refresh(self):
        first = disk.refresh(self.roots, now=1000)
        self.assertEqual(first[0]['state'], 'historical')
        self.assertGreater(first[0]['allocatedBytes'], 0)
        with patch.object(disk, '_scan', side_effect=AssertionError('must not scan')):
            self.assertEqual(disk.refresh(self.roots, first, now=1100), first)
        with patch.object(disk, '_scan', side_effect=disk.Unsafe()):
            stale = disk.refresh(self.roots, first, now=2000)[0]
        self.assertEqual(stale['state'], 'stale')
        self.assertEqual(stale['allocatedBytes'], first[0]['allocatedBytes'])

    def test_future_and_replaced_identity_are_not_reused(self):
        first = disk.refresh(self.roots, now=1000)
        future = disk.refresh(self.roots, first, now=999)[0]
        self.assertEqual(future['state'], 'future')
        self.assertIsNone(future['allocatedBytes'])
        self.root.rename(self.root.with_name('old'))
        self.root.mkdir(mode=0o700)
        with patch.object(disk, '_scan', side_effect=disk.Unsafe()):
            result = disk.refresh(self.roots, first, now=1001)[0]
        self.assertEqual(result['state'], 'unknown')
        self.assertIsNone(result['allocatedBytes'])

    def test_nofollow_and_unsafe_and_bounds(self):
        outside = Path(self.temp.name).resolve() / 'outside'
        outside.mkdir(mode=0o700)
        (outside / 'large').write_bytes(b'x' * 100000)
        (self.root / 'link').symlink_to(outside)
        (self.root / 'node_modules').mkdir()
        (self.root / 'node_modules' / 'shared').write_bytes(b'x' * 100000)
        result = disk.refresh(self.roots, now=1000)[0]
        self.assertEqual(result['state'], 'historical')
        self.assertLess(result['allocatedBytes'], 100000)
        self.assertTrue(result['excludesNodeModules'])
        self.assertEqual(disk.refresh(self.roots, now=1000, max_entries=1)[0]['state'], 'unknown')
        os.chmod(self.root, 0o777)
        self.assertEqual(disk.refresh(self.roots, now=1000)[0]['state'], 'unknown')
        self.root.rename(self.root.with_name('saved'))
        self.root.symlink_to(outside)
        self.assertEqual(disk.refresh(self.roots, now=1000)[0]['state'], 'unknown')

    def test_name_swap_during_scan_refused(self):
        original = disk._scan
        def swap(*args):
            result = original(*args)
            self.root.rename(self.root.with_name('saved'))
            self.root.mkdir(mode=0o700)
            return result
        with patch.object(disk, '_scan', side_effect=swap):
            row = disk.refresh(self.roots, now=1000)[0]
        self.assertEqual(row['state'], 'unknown')
        self.assertIsNone(row['allocatedBytes'])

    def test_persisted_cache_cadence_and_unsafe_cache(self):
        import sys
        sys.path.insert(0, str(Path(__file__).parents[2] / 'contrib/mac'))
        import host_session_runtime as runtime
        runs = Path(self.temp.name).resolve() / 'runs'
        runs.mkdir(mode=0o700)
        with runtime.runs_directory(str(runs)) as directory:
            first = disk.refresh_persisted(directory, self.roots, runtime.read_json_at, runtime.write_json_at, now=1000)
            with patch.object(disk, '_scan', side_effect=AssertionError('scanned inside cadence')):
                second = disk.refresh_persisted(directory, self.roots, runtime.read_json_at, runtime.write_json_at, now=1100)
            self.assertEqual(first, second)
            with patch.object(disk, '_scan', side_effect=disk.Unsafe()):
                failed = disk.refresh_persisted(directory, self.roots, runtime.read_json_at, runtime.write_json_at, now=1400)
            self.assertEqual(failed[0]['state'], 'stale')
            with patch.object(disk, '_scan', side_effect=AssertionError('failed scans must respect cadence')):
                retried = disk.refresh_persisted(directory, self.roots, runtime.read_json_at, runtime.write_json_at, now=1401)
            self.assertEqual(retried, failed)
        cache = runs / 'resource-session-disk-cache.json'
        cache.unlink()
        cache.symlink_to(self.root / 'file')
        with runtime.runs_directory(str(runs)) as directory:
            with self.assertRaises((OSError, ValueError)):
                disk.refresh_persisted(directory, self.roots, runtime.read_json_at, runtime.write_json_at, now=1500)
        self.assertTrue(cache.is_symlink())

    def test_unsafe_ancestor_rejected(self):
        parent = self.root.parent / 'unsafe'
        parent.mkdir(mode=0o700)
        inner = parent / 'tree'
        inner.mkdir(mode=0o700)
        os.chmod(parent, 0o777)
        self.assertEqual(disk.refresh([{'job': 'job', 'path': str(inner)}], now=1000)[0]['state'], 'unknown')

    def test_hardlinks_are_counted_once_and_other_job_cannot_borrow_history(self):
        # Retained unique coverage from the superseded standalone footprint seed.
        os.link(self.root/'file',self.root/'same-inode')
        row=disk.refresh(self.roots,now=1000)[0]
        expected=self.root.stat().st_blocks*512+(self.root/'file').stat().st_blocks*512
        self.assertEqual(row['allocatedBytes'],expected)
        other=[{'job':'another-claim','path':str(self.root)}]
        borrowed=disk.refresh(other,[row],now=1001,max_entries=0)[0]
        self.assertEqual(borrowed['state'],'unknown');self.assertIsNone(borrowed['allocatedBytes'])
    def test_missing_and_zero_budget_never_report_zero_footprint(self):
        # Retains the old missing-record/budget negatives against the real cache.
        for roots,options in [([{'job':'job','path':str(self.root/'missing')}],{}),(self.roots,{'max_entries':0})]:
            row=disk.refresh(roots,now=1000,**options)[0]
            self.assertEqual(row['state'],'unknown');self.assertIsNone(row['allocatedBytes'])


if __name__ == '__main__':
    unittest.main()
