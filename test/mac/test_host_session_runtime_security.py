"""Synthetic custody regression tests for the private runtime candidate."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'contrib/mac'))
import host_session_runtime as runtime


class RuntimeCustodyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self.tmp.name))
        self.run = self.root / 'queue' / 'run'
        self.run.mkdir(parents=True)
        owner = self.run / 'RQ-1.root-owner'
        owner.mkdir()
        (owner / 'owner.json').write_text(json.dumps({'owner': 'test'}))
        self.boot = lambda: 'test-boot'
        self.rows = [dict(uid=os.getuid(), pid=10, ppid=1, start='first', rssBytes=1, cpuPercent=0),
                     dict(uid=os.getuid(), pid=11, ppid=1, start='second', rssBytes=1, cpuPercent=0)]
        self.census = lambda: self.rows

    def tearDown(self):
        self.tmp.cleanup()

    def ordinary(self):
        import shutil
        shutil.rmtree(self.run / 'RQ-1.root-owner')
        self.wt = self.root / 'worktrees'
        (self.wt / 'RQ-1').mkdir(parents=True)
        (self.root / 'RQ-1.base').write_text('a' * 40 + ' codex-bridge/RQ-1 ' + str(self.wt / 'RQ-1') + ' codex\n')
        (self.run / 'RQ-1.line').write_text('RQ-1\tphantom\tcodex\twork\tprompt\n')
        (self.run / 'RQ-1.dispatched').write_text('1234567890')

    def ordinary_register(self, **kwargs):
        return runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot,
                                      census=self.census, worktree_root=str(self.wt), **kwargs)

    def test_ordinary_protected_records_positive_and_mutations(self):
        self.ordinary()
        claim = self.ordinary_register()
        self.assertTrue(runtime.verify_current_claim(str(self.root), claim, worktree_root=str(self.wt)))
        self.assertEqual(runtime.verified_worktrees(str(self.root), str(self.wt)),
                         [{'job': 'RQ-1', 'path': str(self.wt / 'RQ-1')}])
        (self.run / 'RQ-1.line').write_text('RQ-2\tphantom\tcodex\twork\tprompt\n')
        self.assertFalse(runtime.verify_current_claim(str(self.root), claim, worktree_root=str(self.wt)))

    def test_ordinary_closed_optional_pin_and_control_characters(self):
        self.ordinary()
        path=self.run/'RQ-1.line';base=path.read_text().rstrip('\n')
        for suffix in ['\tunsupported\n','\x00\n']:
            path.write_text(base+suffix)
            with self.assertRaises(ValueError):self.ordinary_register()
        path.write_text(base+'\tpin\n')
        self.assertTrue(self.ordinary_register())

    def test_ordinary_unsafe_files_and_worktree_swap_fail(self):
        self.ordinary()
        p = self.run / 'RQ-1.line'
        p.chmod(0o666)
        with self.assertRaises(ValueError): self.ordinary_register()
        p.chmod(0o600)
        p.unlink()
        p.symlink_to(self.run / 'RQ-1.dispatched')
        with self.assertRaises(OSError): self.ordinary_register()
        p.unlink()
        p.write_text('RQ-1\tphantom\tcodex\twork\tprompt\n')
        claim = self.ordinary_register()
        (self.wt / 'RQ-1').rename(self.wt / 'old')
        (self.wt / 'RQ-1').mkdir()
        self.assertFalse(runtime.verify_current_claim(str(self.root), claim, worktree_root=str(self.wt)))

    def test_ordinary_pid_reuse_boot_change_and_sibling_rejected(self):
        self.ordinary()
        old = self.rows
        snapshots = iter([old, [dict(old[0], start='reused'), old[1]]])
        with self.assertRaises(ValueError):
            runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot,
                                   census=lambda: next(snapshots), worktree_root=str(self.wt))
        boots = iter(['one', 'two'])
        with self.assertRaises(ValueError):
            runtime.register_claim(str(self.root), 'RQ-1', 10, boot=lambda: next(boots),
                                   census=self.census, worktree_root=str(self.wt))
        (self.root / 'RQ-1.base').write_text('a' * 40 + ' codex-bridge/RQ-1 ' + str(self.wt / 'sibling') + ' codex')
        with self.assertRaises(ValueError): self.ordinary_register()

    def test_filename_must_match_job(self):
        runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot, census=self.census)
        claim = self.run / 'resource-sessions' / 'RQ-1.json'
        claim.rename(claim.with_name('RQ-2.json'))
        with self.assertRaises(ValueError):
            runtime.read_claims(str(self.root))

    def test_active_other_attempt_cannot_be_replaced(self):
        first = runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot, census=self.census)
        with self.assertRaises(ValueError):
            runtime.register_claim(str(self.root), 'RQ-1', 11, boot=self.boot, census=self.census)
        self.assertTrue(runtime.verify_current_claim(str(self.root), first))

    def test_same_attempt_registration_is_idempotent(self):
        first = runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot, census=self.census)
        again = runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot, census=self.census)
        self.assertEqual(first, again)

    def test_retired_attempt_is_archived_without_relabeling(self):
        first = runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot, census=self.census)
        self.rows = [self.rows[1]]
        second = runtime.register_claim(str(self.root), 'RQ-1', 11, boot=self.boot, census=self.census)
        self.assertNotEqual(first['ownerNonce'], second['ownerNonce'])
        archived = self.run / 'resource-sessions' / 'history' / ('RQ-1.' + first['ownerNonce'] + '.json')
        self.assertEqual(json.loads(archived.read_text()), first)
        self.assertFalse(runtime.verify_current_claim(str(self.root), first))
        self.assertTrue(runtime.verify_current_claim(str(self.root), second))

    def test_concurrent_registration_cannot_overwrite(self):
        entered, release = threading.Event(), threading.Event()
        result = []
        def waiting_census():
            entered.set()
            if not release.wait(2):
                raise ValueError('fixture rendezvous timed out')
            return self.rows
        def first_registration():
            result.append(runtime.register_claim(str(self.root), 'RQ-1', 10,
                                                 boot=self.boot, census=waiting_census))
        thread = threading.Thread(target=first_registration)
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ValueError, 'registration busy'):
                runtime.register_claim(str(self.root), 'RQ-1', 11, boot=self.boot, census=self.census)
        finally:
            release.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(result), 1)
        self.assertTrue(runtime.verify_current_claim(str(self.root), result[0]))

    def test_malformed_prior_identity_refuses_without_replacement(self):
        first = runtime.register_claim(str(self.root), 'RQ-1', 10, boot=self.boot, census=self.census)
        path = self.run / 'resource-sessions' / 'RQ-1.json'
        damaged = dict(first, rootPid=[])
        path.write_text(json.dumps(damaged))
        with self.assertRaisesRegex(ValueError, 'prior session claim unavailable'):
            runtime.register_claim(str(self.root), 'RQ-1', 11, boot=self.boot, census=self.census)
        self.assertEqual(json.loads(path.read_text()), damaged)


if __name__ == '__main__':
    unittest.main()
