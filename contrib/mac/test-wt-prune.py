#!/usr/bin/env python3
"""Real filesystem/Git fixtures, with a clock advanced past the quiet window."""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('wt_prune', HERE / 'wt-prune.py')
prune = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prune)


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wt-prune-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.root = self.home / '.ashlr-runs'
        self.root.mkdir()
        self.now = time.time() + 1800
        for patcher in [patch.object(prune.time, 'time', return_value=self.now),
                        patch.object(prune, 'process_cwds', return_value=[])]:
            patcher.start()
            self.addCleanup(patcher.stop)

    def git(self, wt, *args):
        return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(wt), *args],
                              env={**os.environ, 'HOME': str(self.home), 'GIT_CONFIG_NOSYSTEM': '1'},
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def tree(self, name='finished'):
        wt = self.root / name
        wt.mkdir(parents=True)
        self.git(wt, 'init', '-q')
        (wt / '.gitignore').write_text('target/\nnode_modules/\n.turbo/\ndist/\n')
        (wt / 'source.txt').write_text('keep me')
        return wt

    def artifact(self, wt, name='target'):
        path = wt / name
        path.mkdir(parents=True)
        (path / 'payload').write_bytes(b'x' * 8192)
        return path

    def sweep(self, **kwargs):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            rc = prune.sweep(self.home, **kwargs)
        return rc, output.getvalue()

    def cli(self, *args):
        return subprocess.run(['bash', str(HERE / 'wt-prune.sh'), *args],
                              env={**os.environ, 'HOME': str(self.home)},
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=40)

    def owner(self, wt, **changes):
        return dict({'pid': 999999999, 'worktree': str(wt), 'created_at': self.now - 1800,
                     'process_start': 'old process'}, **changes)

    def test_deletes_all_four_artifacts_and_nested_cargo_target(self):
        wt = self.tree('kept idle')
        names = ['target', 'node_modules/.cache', '.turbo', 'dist', 'desktop/src-tauri/target']
        paths = [self.artifact(wt, name) for name in names]
        dependency = wt / 'node_modules/library/dist/index.js'
        dependency.parent.mkdir(parents=True)
        dependency.write_text('keep dependency')
        allocated = sum((path / 'payload').stat().st_blocks * 512 for path in paths)
        rc, log = self.sweep()
        self.assertEqual(rc, 0)
        self.assertTrue(all(not path.exists() for path in paths))
        self.assertTrue(dependency.exists())
        self.assertTrue((wt / 'source.txt').exists())
        self.assertIn(f'freed_bytes={allocated} ', log)
        self.assertIn('removed=5 held=0', log)
        self.assertIn('freed_bytes=0 ', self.sweep()[1])

    def test_dry_run_reports_estimate_and_preserves_bytes(self):
        path = self.artifact(self.tree())
        size = (path / 'payload').stat().st_blocks * 512
        before = (path / 'payload').read_bytes()
        rc, log = self.sweep(dry_run=True)
        self.assertEqual(rc, 0)
        self.assertIn(f'freed_bytes=0 would_free_bytes={size} removed=0', log)
        self.assertEqual((path / 'payload').read_bytes(), before)

    def test_gitfile_worktree_with_external_metadata_is_pruned(self):
        wt = self.tree()
        path = self.artifact(wt)
        metadata = self.home / 'shared-git-metadata'
        self.git(wt, 'init', '-q', '--separate-git-dir=' + str(metadata))
        self.assertTrue((wt / '.git').is_file())
        before = {p.relative_to(metadata): p.read_bytes() for p in metadata.rglob('*') if p.is_file()}
        self.sweep()
        self.assertFalse(path.exists())
        self.assertEqual(before, {p.relative_to(metadata): p.read_bytes()
                                  for p in metadata.rglob('*') if p.is_file()})

    def test_recent_nested_source_preserves_entire_worktree(self):
        wt = self.tree()
        path = self.artifact(wt)
        source = wt / 'src/deep/code.rs'
        source.parent.mkdir(parents=True)
        source.write_text('recent')
        os.utime(source, (self.now - 60, self.now - 60))
        self.sweep()
        self.assertTrue(path.exists())

    def test_ctime_also_holds_backdated_worktree(self):
        path = self.artifact(self.tree())
        with patch.object(prune.time, 'time', return_value=self.now - 1800):
            self.sweep()
        self.assertTrue(path.exists())

    def test_live_cwd_in_nested_directory_holds(self):
        wt = self.tree()
        path = self.artifact(wt)
        with patch.object(prune, 'process_cwds', return_value=[path]):
            self.sweep()
        self.assertTrue(path.exists())

    def test_cwd_prefix_sibling_is_not_inside(self):
        wt = self.tree()
        path = self.artifact(wt)
        with patch.object(prune, 'process_cwds', return_value=[Path(str(wt) + '-other')]):
            self.sweep()
        self.assertFalse(path.exists())

    def test_real_sleeping_process_cwd_blocks(self):
        wt = self.tree()
        path = self.artifact(wt)
        child = subprocess.Popen(['sleep', '300'], cwd=path)
        try:
            # The production inspector, rather than the fixture's mock.
            with patch.object(prune, 'process_cwds', REAL_PROCESS_CWDS):
                self.assertIn(path, prune.process_cwds())
                self.sweep()
            self.assertTrue(path.exists())
        finally:
            child.terminate()
            child.wait(timeout=5)

    def test_failed_cwd_inventory_fails_closed(self):
        path = self.artifact(self.tree())
        with patch.object(prune, 'process_cwds', side_effect=prune.Hold('unavailable')):
            rc, log = self.sweep()
        self.assertEqual(rc, 1)
        self.assertIn('inspection_failed=1', log)
        self.assertTrue(path.exists())

    def test_macos_cwd_parser_preserves_newlines_and_rejects_incomplete_records(self):
        with patch.object(prune.sys, 'platform', 'darwin'):
            with patch.object(prune, 'run', return_value=b'p123\0\nn/tmp/line\nbreak\0\n'):
                self.assertEqual(REAL_PROCESS_CWDS(), [Path('/tmp/line\nbreak').resolve()])
            for data in [b'', b'p123\0\n', b'n/tmp/no-pid\0', b'p123\0nrelative\0',
                         b'p123\0p456\0n/tmp/missing-first\0']:
                with patch.object(prune, 'run', return_value=data), self.assertRaises(prune.Hold):
                    REAL_PROCESS_CWDS()

    def test_linux_deleted_cwd_retains_lexical_worktree_boundary(self):
        with patch.object(prune.sys, 'platform', 'linux'), \
                patch.object(prune.Path, 'iterdir', return_value=iter([Path('/proc/123')])), \
                patch.object(prune.os, 'readlink', return_value='/tmp/worktree (deleted)'):
            self.assertEqual(REAL_PROCESS_CWDS(), [Path('/tmp/worktree').resolve()])

    def test_rechecks_cwd_immediately_before_removal(self):
        wt = self.tree()
        path = self.artifact(wt)
        with patch.object(prune, 'process_cwds', side_effect=[[], [path]]):
            self.sweep()
        self.assertTrue(path.exists())

    def test_queue_codex_and_external_paths_are_never_discovered(self):
        paths = [self.artifact(self.tree(name)) for name in
                 ['queue/finished', '.codex', '.codex-backup', 'nested/.codex-other']]
        outside = self.home / '.codex-outside'
        outside.mkdir()
        (outside / 'target').mkdir()
        (self.root / 'escape').symlink_to(outside, target_is_directory=True)
        self.sweep()
        self.assertTrue(all(path.exists() for path in paths))
        self.assertTrue((outside / 'target').exists())

    def test_symlinked_run_root_is_refused(self):
        wt = self.tree()
        path = self.artifact(wt)
        actual = self.home / 'real-runs'
        self.root.rename(actual)
        self.root.symlink_to(actual, target_is_directory=True)
        rc, _ = self.sweep()
        self.assertEqual(rc, 1)
        self.assertTrue((actual / wt.name / path.name).exists())

    def test_symlinked_artifact_and_node_modules_are_preserved(self):
        wt = self.tree()
        external = self.home / '.codex-cache'
        external.mkdir()
        payload = self.artifact(external, '.cache')
        (wt / 'node_modules').symlink_to(external, target_is_directory=True)
        (wt / 'target').symlink_to(payload, target_is_directory=True)
        self.sweep()
        self.assertTrue(payload.exists())
        self.assertTrue((wt / 'target').is_symlink())

    def test_symlink_inside_artifact_holds_whole_plan(self):
        wt = self.tree()
        path = self.artifact(wt)
        other = self.artifact(wt, 'dist')
        (path / 'link').symlink_to(self.home)
        self.sweep()
        self.assertTrue(path.exists())
        self.assertTrue(other.exists())

    def test_hardlinked_artifact_is_preserved(self):
        path = self.artifact(self.tree())
        os.link(path / 'payload', self.home / 'shared')
        self.sweep()
        self.assertTrue(path.exists())

    def test_nonignored_and_tracked_artifacts_are_preserved(self):
        for name, tracked in [('nonignored', False), ('tracked', True)]:
            wt = self.tree(name)
            path = self.artifact(wt)
            if tracked:
                self.git(wt, 'add', '-f', 'target/payload')
            else:
                (wt / '.gitignore').write_text('')
            self.sweep()
            self.assertTrue(path.exists())

    def test_nested_repository_and_protected_descendant_hold(self):
        for name in ['.git', '.codex-state']:
            wt = self.tree('protected-' + name)
            path = self.artifact(wt)
            (path / name).mkdir()
            self.sweep()
            self.assertTrue(path.exists())

    def test_application_queue_module_does_not_block_qualified_artifacts(self):
        wt = self.tree()
        path = self.artifact(wt, 'src/queue/target')
        source = wt / 'src/queue/module.rs'
        source.write_text('queue implementation')
        self.sweep()
        self.assertFalse(path.exists())
        self.assertTrue(source.exists())

    def test_live_claim_or_supervisor_and_malformed_claim_hold(self):
        for i, claim in enumerate([
                {'pid': os.getpid()}, {'pid': 999999999, 'supervisor_pid': os.getpid()},
                {'pid': 'bad'}, {'pid': 10 ** 100}, {}, 'broken']):
            wt = self.tree('claim-' + str(i))
            path = self.artifact(wt)
            if isinstance(claim, dict) and claim:
                claim = self.owner(wt, **claim)
            (self.root / (wt.name + '.claim')).write_text(json.dumps(claim))
            self.sweep()
            self.assertTrue(path.exists())

    def test_stale_claim_allows_pruning(self):
        wt = self.tree()
        path = self.artifact(wt)
        (self.root / (wt.name + '.claim')).write_text(json.dumps(self.owner(wt)))
        self.sweep()
        self.assertFalse(path.exists())

    def test_busy_bridge_lock_preserves_worktree_and_lock_metadata(self):
        wt = self.tree()
        path = self.artifact(wt)
        locks = self.root / 'locks'
        locks.mkdir()
        lock = locks / (hashlib.sha256(str(wt).encode()).hexdigest() + '.lock')
        with lock.open('w+') as stream:
            stream.write('ownership metadata')
            stream.flush()
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.sweep()
            self.assertTrue(path.exists())
            self.assertEqual(lock.read_text(), 'ownership metadata')

    def test_git_failure_holds(self):
        path = self.artifact(self.tree())
        with patch.object(prune, 'run', side_effect=prune.Hold('git-failed')):
            self.sweep()
        self.assertTrue(path.exists())

    def test_unlocked_live_owner_and_malformed_lock_hold(self):
        for i, owner in enumerate(['broken', {'active': True, 'pid': os.getpid()},
                                   {'active': 'bad'}, {'active': False, 'created_at': float('nan')} ]):
            wt = self.tree('lock-owner-' + str(i))
            path = self.artifact(wt)
            locks = self.root / 'locks'
            locks.mkdir(exist_ok=True)
            lock = locks / (hashlib.sha256(str(wt).encode()).hexdigest() + '.lock')
            data = json.dumps(self.owner(wt, **owner) if isinstance(owner, dict) else owner)
            lock.write_text(data)
            self.sweep()
            self.assertTrue(path.exists())
            self.assertEqual(lock.read_text(), data)

    def test_valid_inactive_lock_allows_pruning_without_rewriting_metadata(self):
        wt = self.tree()
        path = self.artifact(wt)
        locks = self.root / 'locks'
        locks.mkdir()
        lock = locks / (hashlib.sha256(str(wt).encode()).hexdigest() + '.lock')
        data = json.dumps(self.owner(wt, active=False, pid=os.getpid()))
        lock.write_text(data)
        self.sweep()
        self.assertFalse(path.exists())
        self.assertEqual(lock.read_text(), data)

    def test_recent_or_invalid_claim_metadata_holds(self):
        for i, changes in enumerate([{'created_at': self.now}, {'created_at': float('inf')},
                                    {'created_at': 10 ** 1000},
                                    {'process_start': None}, {'created_at': -1}]):
            wt = self.tree('bad-claim-' + str(i))
            path = self.artifact(wt)
            (self.root / (wt.name + '.claim')).write_text(json.dumps(self.owner(wt, **changes)))
            self.sweep()
            self.assertTrue(path.exists())

    def test_file_changed_after_planning_is_preserved(self):
        wt = self.tree()
        path = self.artifact(wt)
        original = prune.remove_contents

        def changed(fd, device, cutoff):
            os.utime(path / 'payload', (self.now, self.now))
            return original(fd, device, cutoff)

        with patch.object(prune, 'remove_contents', side_effect=changed):
            self.sweep()
        self.assertTrue((path / 'payload').exists())

    def test_source_changed_during_git_inspection_vetoes_plan(self):
        wt = self.tree()
        path = self.artifact(wt)
        original = prune.ignored_only

        def changed(wt, candidate):
            original(wt, candidate)
            os.utime(wt / 'source.txt', (self.now, self.now))

        with patch.object(prune, 'ignored_only', side_effect=changed):
            self.sweep()
        self.assertTrue(path.exists())

    def test_unreadable_descendant_vetoes_cleanup(self):
        path = self.artifact(self.tree())

        def failed_walk(*args, **kwargs):
            kwargs['onerror'](PermissionError('unreadable descendant'))
            return iter(())

        with patch.object(prune.os, 'fwalk', side_effect=failed_walk):
            self.sweep()
        self.assertTrue(path.exists())

    def test_event_scope_cannot_expand_boundary_or_select_queue(self):
        for path in [str(self.home), str(self.root), str(self.root / 'queue/tree'),
                     str(self.root / '.codex-old/tree'), str(self.root / 'foo/../bar'), 'relative']:
            self.assertEqual(self.cli('--event', 'WT_REMOVED', path).returncode, 2)

    def test_event_selects_only_requested_tree_with_same_guards(self):
        wt = self.tree()
        chosen = self.artifact(wt)
        other = self.artifact(self.tree('other'))
        self.sweep(event_path=wt)
        self.assertFalse(chosen.exists())
        self.assertTrue(other.exists())

    def test_shell_entrypoint_and_removed_path_are_safe(self):
        path = self.artifact(self.tree())
        result = self.cli('--event', 'WT_REMOVED', str(self.root / 'already-removed'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('freed_bytes=0 ', result.stdout)
        self.assertTrue(path.exists())
        self.assertEqual(self.cli('--dry-run').returncode, 0)
        self.assertEqual(self.cli('--help').returncode, 0)
        self.assertEqual(self.cli('--force').returncode, 2)
        self.assertEqual(self.cli('--event', 'OTHER').returncode, 2)

    def test_watch_sweeps_every_thirty_minutes(self):
        with patch.object(prune.sys, 'argv', ['wt-prune', '--watch', '--dry-run']), \
                patch.object(prune.Path, 'home', return_value=self.home), \
                patch.object(prune, 'sweep', return_value=0) as sweep, \
                patch.object(prune.time, 'monotonic', side_effect=[0, 600, 1800, 2400]), \
                patch.object(prune.time, 'sleep', side_effect=[None, KeyboardInterrupt]) as sleep:
            self.assertEqual(prune.main(), 0)
        self.assertEqual(sweep.call_count, 2)
        self.assertEqual(sleep.call_args_list[0].args, (1200,))
        self.assertEqual(sleep.call_args_list[1].args, (1200,))
        self.assertTrue(sweep.call_args.args[1])

    def test_missing_root_is_clean_noop(self):
        self.root.rmdir()
        self.assertEqual(self.sweep(), (0, 'WT_PRUNE freed_bytes=0 would_free_bytes=0 removed=0 held=0\n'))

    def test_newline_and_shell_metacharacter_names_are_literal(self):
        wt = self.tree('job\n$(false); space')
        path = self.artifact(wt, 'pkg\n; echo/target')
        self.sweep()
        self.assertFalse(path.exists())


REAL_PROCESS_CWDS = prune.process_cwds

if __name__ == '__main__':
    unittest.main(verbosity=2)
