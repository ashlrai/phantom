import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import state_snapshot  # noqa: E402

SCRIPT = HERE / 'state_snapshot.py'
ALLOW = tuple(state_snapshot.ALLOW_LIST)
LIMIT = state_snapshot.MAX_FILE_BYTES
EXPECTED_ENTRIES = set(ALLOW) | {'manifest.json'} | {
    str(parent) for rel in ALLOW for parent in Path(rel).parents
    if str(parent) != '.'}


class StateSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'fleet-state'
        self.out = self.base / 'snapshot'
        self.target = self.base / 'standby-root'
        # Plainly fake fixture text, one record per allow-listed file.
        self.contents = {
            'queue/router-queue.md': 'FAKE router queue row one\n',
            'queue/ready.tsv': 'job\tlane\njob-fake-1\tlane-fake\n',
            'queue/slots.json': '{"lane-fake": {"open": 1}}\n',
            'leader/VISION.md': 'FAKE vision note\n',
            'leader/ORCHESTRATION.md': 'FAKE orchestration note\n',
            'metrics/jobs.jsonl': '{"job": "job-fake-1", "ok": true}\n',
        }
        for rel, text in self.contents.items():
            self.put_root(rel, text)

    def put_root(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_cmd(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args],
                              capture_output=True, text=True, timeout=60)

    def create(self):
        proc = self.run_cmd('create', '--root', str(self.root), '--out', str(self.out))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def recreate(self):
        shutil.rmtree(self.out, ignore_errors=True)
        return self.create()

    def verify(self, directory=None, ok=True):
        proc = self.run_cmd('verify', str(directory or self.out))
        self.assertEqual(proc.returncode, 0 if ok else 1, proc.stderr)
        return json.loads(proc.stdout)

    def restore(self, *extra):
        proc = self.run_cmd('restore', str(self.out), '--root', str(self.target), *extra)
        return proc

    def entries(self, directory):
        return {p.relative_to(directory).as_posix() for p in directory.rglob('*')}

    def manifest(self):
        return json.loads((self.out / 'manifest.json').read_bytes())

    def test_create_copies_only_allow_list_and_verifies(self):
        self.put_root('queue/extra.md', 'FAKE extra file never copied\n')
        self.put_root('leader/SECRET.md', 'FAKE secret file never copied\n')
        self.put_root('stray.bin', 'FAKE stray\n')
        result = self.create()
        self.assertEqual(result['files'], len(ALLOW))
        self.assertEqual(result['skipped'], [])
        self.assertEqual(self.entries(self.out), EXPECTED_ENTRIES)
        manifest = self.manifest()
        self.assertEqual(manifest['version'], 1)
        for entry in manifest['files']:
            self.assertIn(entry['path'], ALLOW)
            data = (self.root / entry['path']).read_bytes()
            self.assertEqual(entry['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(entry['size'], len(data))
            self.assertEqual((self.out / entry['path']).read_bytes(), data)
        self.assertEqual(self.verify()['files'], len(ALLOW))

    def test_extra_arguments_are_refused(self):
        self.create()
        for args in [('create', '--root', str(self.root), '--out', str(self.out), 'leader/X.md'),
                     ('create', '--root', str(self.root), '--out', str(self.out / 'two'),
                      '--paths', 'queue/extra.md'),
                     ('verify', str(self.out), 'queue/extra.md'),
                     ('restore', str(self.out), '--root', str(self.target), 'queue/extra.md'),
                     ('restore', str(self.out), '--root', str(self.target), '--path', 'x')]:
            proc = self.run_cmd(*args)
            self.assertNotEqual(proc.returncode, 0, args)
            self.assertEqual(proc.stdout, '')

    def test_create_refusals(self):
        proc = self.run_cmd('create', '--root', str(self.base / 'nope'),
                            '--out', str(self.out))
        self.assertEqual(proc.returncode, 1)
        self.create()
        proc = self.run_cmd('create', '--root', str(self.root), '--out', str(self.out))
        self.assertEqual(proc.returncode, 1)  # existing snapshot is never clobbered
        proc = self.run_cmd('create', '--root', str(self.root),
                            '--out', str(self.root / 'inside'))
        self.assertEqual(proc.returncode, 1)  # output may not live inside root

    def test_symlinked_file_and_escaping_dir_refused(self):
        link = self.root / 'queue' / 'ready.tsv'
        link.unlink()
        link.symlink_to(self.root / 'leader' / 'VISION.md')
        proc = self.run_cmd('create', '--root', str(self.root), '--out', str(self.out))
        self.assertEqual(proc.returncode, 1)
        self.assertIn('symlink', proc.stdout)
        self.assertFalse(self.out.exists())

    def test_symlinked_dir_resolving_outside_root_refused(self):
        outside = self.base / 'outside-leader'
        outside.mkdir()
        for name in ('VISION.md', 'ORCHESTRATION.md'):
            (outside / name).write_text('FAKE outside leader file\n')
        shutil.rmtree(self.root / 'leader')
        (self.root / 'leader').symlink_to(outside)
        proc = self.run_cmd('create', '--root', str(self.root), '--out', str(self.out))
        self.assertEqual(proc.returncode, 1)
        self.assertIn('outside root', proc.stdout)
        self.assertFalse(self.out.exists())
        # A refused create publishes nothing and sweeps its staging directory.
        self.assertEqual([p for p in self.base.iterdir() if '.staging-' in p.name], [])

    def test_oversize_and_missing_files_are_recorded_skips(self):
        with (self.root / 'metrics' / 'jobs.jsonl').open('wb') as handle:
            handle.truncate(LIMIT + 1)
        (self.root / 'leader' / 'VISION.md').unlink()
        result = self.create()
        self.assertEqual(result['files'], len(ALLOW) - 2)
        reasons = {s['path']: s['reason'] for s in result['skipped']}
        self.assertEqual(reasons['metrics/jobs.jsonl'], 'over-size-limit')
        self.assertEqual(reasons['leader/VISION.md'], 'missing')
        manifest = self.manifest()
        self.assertEqual([e['path'] for e in manifest['files']],
                         [p for p in ALLOW if p not in reasons])
        self.verify()
        proc = self.restore()
        plan = json.loads(proc.stdout)
        self.assertTrue(plan['ok'])
        self.assertEqual(len(plan['planned']), len(ALLOW) - 2)

    def test_verify_detects_tamper(self):
        self.create()
        victim = self.out / 'queue' / 'ready.tsv'
        data = bytearray(victim.read_bytes())
        data[0] ^= 0xFF
        victim.write_bytes(bytes(data))
        result = self.verify(ok=False)
        self.assertIn('hash mismatch: queue/ready.tsv', result['errors'])

        self.recreate()
        (self.out / 'metrics' / 'jobs.jsonl').unlink()
        result = self.verify(ok=False)
        self.assertIn('missing file: metrics/jobs.jsonl', result['errors'])

        self.recreate()
        (self.out / 'unexpected.txt').write_text('FAKE planted file\n')
        (self.out / 'planted-dir').mkdir()
        (self.out / 'queue' / 'link.md').symlink_to(self.root / 'queue' / 'ready.tsv')
        result = self.verify(ok=False)
        self.assertIn('unexpected file: unexpected.txt', result['errors'])
        self.assertIn('unexpected directory: planted-dir', result['errors'])
        self.assertIn('unexpected symlink: queue/link.md', result['errors'])

        self.recreate()
        manifest = self.manifest()
        manifest['files'][0]['path'] = 'etc/passwd'
        (self.out / 'manifest.json').write_text(json.dumps(manifest))
        self.verify(ok=False)

        self.recreate()
        (self.out / 'manifest.json').write_text('{not json')
        self.verify(ok=False)

    def test_crash_remnant_never_publishes_and_recreate_succeeds(self):
        remnant = self.base / (self.out.name + '.staging-deadbeef')
        (remnant / 'queue').mkdir(parents=True)
        (remnant / 'queue' / 'ready.tsv').write_text('FAKE partial copy\n')
        self.verify(directory=remnant, ok=False)  # no manifest: not a snapshot
        self.create()
        self.verify()
        self.assertTrue(remnant.is_dir())  # foreign staging left untouched
        self.assertEqual(self.entries(self.out), EXPECTED_ENTRIES)

    def test_restore_dry_run_writes_nothing(self):
        self.create()
        proc = self.restore()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result['applied'])
        self.assertEqual(len(result['planned']), len(ALLOW))
        self.assertTrue(all(p['action'] == 'write' for p in result['planned']))
        self.assertFalse(self.target.exists())

    def test_restore_apply_roundtrip_replace_and_symlink(self):
        self.create()
        (self.target / 'queue').mkdir(parents=True)
        (self.target / 'queue' / 'slots.json').write_text('FAKE stale content\n')
        (self.target / 'leader').mkdir()
        (self.target / 'leader' / 'VISION.md').symlink_to(self.root / 'stray-target')
        proc = self.restore('--apply')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertTrue(result['applied'])
        actions = {w['path']: w['action'] for w in result['written']}
        self.assertEqual(actions['queue/slots.json'], 'replaced')
        self.assertEqual(actions['leader/VISION.md'], 'replaced')
        self.assertEqual(actions['metrics/jobs.jsonl'], 'written')
        for rel, text in self.contents.items():
            restored = self.target / rel
            self.assertFalse(restored.is_symlink())
            self.assertEqual(restored.read_bytes(), (self.root / rel).read_bytes())
            source_mode = (self.root / rel).stat().st_mode & 0o777
            self.assertEqual(restored.stat().st_mode & 0o777, source_mode)

    def test_restore_refuses_tampered_snapshot(self):
        self.create()
        victim = self.out / 'leader' / 'VISION.md'
        data = bytearray(victim.read_bytes())
        data[0] ^= 0xFF
        victim.write_bytes(bytes(data))
        for extra in ((), ('--apply',)):
            proc = self.restore(*extra)
            self.assertEqual(proc.returncode, 1)
            self.assertIn('snapshot failed verification', proc.stdout)
        self.assertFalse(self.target.exists())

    def test_restore_refuses_root_inside_snapshot(self):
        self.create()
        proc = self.run_cmd('restore', str(self.out), '--root',
                            str(self.out / 'nested'), '--apply')
        self.assertEqual(proc.returncode, 1)
        self.assertIn('inside snapshot', proc.stdout)

    def test_output_never_contains_file_contents(self):
        sentinel = 'FAKE-SENTINEL-NOT-FOR-OUTPUT-9f8e7d'
        self.put_root('queue/ready.tsv', sentinel + '\n')
        self.create()
        procs = [self.run_cmd('verify', str(self.out)),
                 self.restore(),
                 self.restore('--apply')]
        for proc in procs:
            self.assertNotIn(sentinel, proc.stdout + proc.stderr)


if __name__ == '__main__':
    unittest.main()
