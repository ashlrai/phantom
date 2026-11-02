import base64
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import host_queue
import host_queue_ingress as ingress

SCRIPT = Path(__file__).with_name('host_queue_ingress.py')
HEADER = b'#job repo=phantom lane=codex-personal tier=work\n\n'


class IngressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.drop = self.root / 'drop'
        self.drop.mkdir()
        self.db = self.root / 'queue.sqlite'

    def file(self, name='RQ-PHX-ABC.md', data=HEADER + b'Harmless prompt\n'):
        path = self.drop / name
        path.write_bytes(data)
        return path

    def command(self, *extra, db=None, drop=None):
        return [sys.executable, str(SCRIPT), '--drop-dir', str(drop or self.drop),
                '--db', str(db or self.db), '--once', *extra]

    def call(self, *extra, ok=True, db=None, drop=None):
        proc = subprocess.run(self.command(*extra, db=db, drop=drop), capture_output=True,
                              text=True, timeout=40)
        self.assertEqual(proc.returncode, 0 if ok else 1, proc.stderr + proc.stdout)
        return json.loads(proc.stdout)

    def rows(self):
        with sqlite3.connect(self.db) as db:
            return db.execute('SELECT job, payload FROM jobs ORDER BY job').fetchall()

    def test_preview_leaves_no_database_or_work_mutations(self):
        source = self.file()
        before = source.stat()
        result = self.call()
        self.assertEqual(result['eligible'], ['RQ-PHX-ABC'])
        self.assertFalse(self.db.exists())
        self.assertEqual(source.read_bytes(), HEADER + b'Harmless prompt\n')
        self.assertEqual(source.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['drop'])

    def test_claim_exact_bytes_and_restart_dedupe_then_conflict(self):
        data = HEADER + b'Harmless prompt\n\x00opaque\xff'
        source = self.file(data=data)
        self.assertEqual(self.call('--apply')['inserted'], ['RQ-PHX-ABC'])
        self.assertEqual(self.call('--apply')['duplicate'], ['RQ-PHX-ABC'])
        claim = host_queue.run(SimpleNamespace(db=str(self.db), action='claim', host='fake-host', ttl=60))['claim']
        self.assertEqual(claim['job'], 'RQ-PHX-ABC')
        self.assertEqual(base64.b64decode(claim['payload_base64']), data)
        source.write_bytes(HEADER + b'Changed harmless prompt\n')
        self.assertEqual(self.call('--apply', ok=False)['conflict'], ['RQ-PHX-ABC'])
        self.assertEqual(self.rows(), [('RQ-PHX-ABC', data)])
        self.assertTrue(source.exists())

    def test_excludes_bad_names_headers_sizes_and_symlinks(self):
        self.file('RQ-PHX-AB.md')
        self.file('RQ-PHX-' + 'A' * 41 + '.md')
        self.file('RQ-PHX-abc.md')
        self.file('RQ-PHX-BAD.md', b'#job repo=other lane=claude tier=work\nhello')
        self.file('RQ-PHX-LAN.md', b'#job repo=phantom lane=unknown tier=work\nhello')
        self.file('RQ-PHX-TIE.md', b'#job repo=phantom lane=devin tier=unknown\nhello')
        self.file('RQ-PHX-EXT.md', b'#job repo=phantom lane=devin tier=work extra=yes\nhello')
        self.file('RQ-PHX-BIG.md', HEADER + b'x' * host_queue.MAX_PAYLOAD)
        self.file('RQ-PHX-ZER.md', b'')
        (self.drop / 'RQ-PHX-LNK.md').symlink_to(self.root / 'outside')
        (self.root / 'outside').write_bytes(HEADER + b'outside')
        self.file('RQ-PHX-OK1.md', HEADER + b'ok')
        result = self.call('--apply')
        self.assertEqual(result['inserted'], ['RQ-PHX-OK1'])
        self.assertEqual(result['excluded'], 10)
        self.assertEqual(len(self.rows()), 1)

    def test_all_known_headers_and_crlf(self):
        for index, lane in enumerate(('claude', 'codex-personal', 'devin', 'codex-local')):
            for tier in ('frontier', 'work', 'mid', 'fast'):
                self.file(f'RQ-PHX-{index}{tier.upper()}.md',
                          f'#job repo=phantom lane={lane} tier={tier}\r\nhello'.encode())
        self.assertEqual(len(self.call('--apply')['inserted']), 16)

    def test_private_snapshot_used_when_source_changes_before_enqueue(self):
        source = self.file()
        original = source.read_bytes()
        real_run = host_queue.run
        def replace(args):
            source.write_bytes(HEADER + b'different')
            self.assertNotEqual(Path(args.payload), source)
            self.assertEqual(os.stat(args.payload).st_mode & 0o777, 0o600)
            return real_run(args)
        args = SimpleNamespace(drop_dir=str(self.drop), db=str(self.db), apply=True)
        with mock.patch.object(host_queue, 'run', side_effect=replace):
            self.assertEqual(ingress.cycle(args)['inserted'], ['RQ-PHX-ABC'])
        self.assertEqual(self.rows(), [('RQ-PHX-ABC', original)])

    def test_file_changed_while_read_is_excluded(self):
        self.file()
        original = ingress.os.fstat
        calls = 0
        def changed(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.file(data=HEADER + b'modified')
            return original(fd)
        with mock.patch.object(ingress.os, 'fstat', side_effect=changed):
            result = ingress.cycle(SimpleNamespace(drop_dir=str(self.drop), db=str(self.db), apply=False))
        self.assertEqual(result['eligible'], [])
        self.assertEqual(result['excluded'], 1)

    def test_concurrent_producers_do_not_overwrite(self):
        other = self.root / 'other'
        other.mkdir()
        first = HEADER + b'first harmless prompt'
        second = HEADER + b'second harmless prompt'
        self.file(data=first)
        (other / 'RQ-PHX-ABC.md').write_bytes(second)
        children = [subprocess.Popen(self.command('--apply', drop=path), stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True) for path in (self.drop, other)]
        results = []
        for child in children:
            stdout, stderr = child.communicate(timeout=40)
            self.assertIn(child.returncode, (0, 1), stderr)
            results.append((child.returncode, json.loads(stdout)))
        self.assertEqual(sorted(code for code, _ in results), [0, 1])
        self.assertEqual(sum(len(r['inserted']) for _, r in results), 1)
        self.assertEqual(sum(len(r['conflict']) for _, r in results), 1)
        self.assertIn(self.rows()[0][1], (first, second))
        self.assertEqual(len(self.rows()), 1)

    def test_batch_progresses_across_restarts_in_filename_order(self):
        for number in range(101):
            self.file(f'RQ-PHX-{number:03}.md')
        first = self.call('--apply')
        self.assertEqual(len(first['inserted']), ingress.BATCH)
        self.assertEqual(first['deferred'], ['RQ-PHX-100'])
        second = self.call('--apply')
        self.assertEqual(len(second['duplicate']), ingress.BATCH)
        self.assertEqual(second['inserted'], ['RQ-PHX-100'])
        self.assertEqual(len(self.rows()), 101)

    def test_scan_bound_and_unavailable_coordinator_fail_without_submission(self):
        self.file()
        with mock.patch.object(ingress, 'MAX_SCAN', 0):
            with self.assertRaises(ValueError):
                ingress.cycle(SimpleNamespace(drop_dir=str(self.drop), db=str(self.db), apply=True))
        self.assertFalse(self.db.exists())
        result = self.call('--apply', db=self.root / 'missing' / 'queue', ok=False)
        self.assertIn('error', result)
        self.assertTrue((self.drop / 'RQ-PHX-ABC.md').exists())
        link = self.root / 'link'
        link.symlink_to(self.drop, target_is_directory=True)
        self.assertIn('error', self.call('--apply', drop=link, ok=False))

    def test_no_payload_in_output_and_size_limit_boundary(self):
        data = HEADER + b'PRIVATE-PROMPT-' + b'x' * (host_queue.MAX_PAYLOAD - len(HEADER) - 15)
        self.assertEqual(len(data), host_queue.MAX_PAYLOAD)
        self.file(data=data)
        for args in ((), ('--apply',), ('--apply',)):
            proc = subprocess.run(self.command(*args), capture_output=True, text=True, timeout=40)
            self.assertEqual(proc.returncode, 0)
            self.assertNotIn('PRIVATE-PROMPT', proc.stdout + proc.stderr)
        self.assertEqual(self.rows()[0][1], data)


if __name__ == '__main__':
    unittest.main()
