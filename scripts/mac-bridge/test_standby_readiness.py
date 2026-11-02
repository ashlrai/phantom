import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import host_lease  # noqa: E402
import snapshot_publish  # noqa: E402
import standby_readiness  # noqa: E402
import state_snapshot  # noqa: E402

FAKE_FILES = {'queue/router-queue.md': 'Q\n', 'queue/ready.tsv': 'F\n',
              'queue/slots.json': '{}\n', 'leader/VISION.md': 'FAKE vision\n',
              'leader/ORCHESTRATION.md': 'O\n', 'metrics/jobs.jsonl': '{}\n'}
REPORT_KEYS = {'version', 'tool', 'ready', 'blockers', 'leaseHolder',
               'leaseExpiresInSec', 'generation', 'snapshotAgeSec',
               'wouldLoseSec'}


class FakeClock:
    def __init__(self, now):
        self.now = float(now)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def tree_bytes(root):
    """relpath -> bytes for every file under root, plus the entry set."""
    root = Path(root)
    entries, files = set(), {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root).as_posix()
        entries.add(rel + ('/' if path.is_dir() else ''))
        if path.is_file():
            files[rel] = path.read_bytes()
    return entries, files


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'fleet-state'
        self.store = self.base / 'snapshots'
        self.store.mkdir()
        for rel, text in FAKE_FILES.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.db = self.base / 'leases.sqlite'
        self.clock = FakeClock(time.time())

    def lease(self, action, host='primary', primary='primary', ttl=30,
              fencing=1):
        argv = ['--db', str(self.db), action, 'leader']
        if action != 'status':
            argv += ['--host', host]
        if action == 'acquire':
            argv += ['--primary', primary, '--ttl', str(ttl), '--grace', '0']
        else:
            argv += ['--fencing', str(fencing)]
            if action == 'renew':
                argv += ['--ttl', str(ttl)]
        args = host_lease.parser().parse_args(argv)
        result = host_lease.run(args, clock=self.clock)
        self.assertTrue(result['ok'], result)
        return result

    def publish(self):
        self.assertEqual(snapshot_publish.main(
            ['--root', str(self.root), '--destination', str(self.store),
             '--once', '--reserve-bytes', '0']), 0)
        return json.loads((self.store / 'latest.json').read_bytes())

    def repoint(self, generation, digest):
        snapshot_publish.commit_pointer(self.store, json.dumps({
            'version': 1, 'tool': 'snapshot_publish', 'files': 6,
            'generation': generation, 'published': 0,
            'manifestSha256': digest}).encode())

    def verdict(self, *extra):
        argv = ['--db', str(self.db), '--snapshot-store', str(self.store),
                '--primary', 'primary', '--role', 'leader', '--host',
                'standby', *extra]
        out = io.StringIO()
        with redirect_stdout(out):
            code = standby_readiness.main(argv, clock=self.clock)
        self.assertEqual(code, 0)
        report = json.loads(out.getvalue())
        self.assertEqual(set(report), REPORT_KEYS)
        self.assertEqual((report['version'], report['tool']),
                         (1, 'standby_readiness'))
        self.assertEqual(report['ready'], report['blockers'] == [])
        return report

    def test_ready(self):
        self.lease('acquire')
        point = self.publish()
        report = self.verdict()
        self.assertTrue(report['ready'])
        self.assertEqual(report['blockers'], [])
        self.assertEqual(report['leaseHolder'], 'primary')
        self.assertEqual(report['leaseExpiresInSec'], 30)
        self.assertEqual(report['generation'], point['generation'])
        self.assertIsNotNone(report['snapshotAgeSec'])
        self.assertLess(report['snapshotAgeSec'], 60)
        self.assertEqual(report['wouldLoseSec'], report['snapshotAgeSec'])

    def test_lease_states(self):
        self.publish()
        # A schema with no row for the role is not a blocker.
        host_lease.database(self.db).close()
        report = self.verdict()
        self.assertTrue(report['ready'])
        self.assertIsNone(report['leaseHolder'])
        self.assertIsNone(report['leaseExpiresInSec'])
        # Released lease: holder null, expires null, still ready.
        self.lease('acquire')
        self.lease('release')
        self.assertTrue(self.verdict()['ready'])
        self.assertIsNone(self.verdict()['leaseHolder'])
        # Held by a third host: reported, not a blocker.
        self.lease('acquire', host='other', primary='primary')
        report = self.verdict()
        self.assertTrue(report['ready'])
        self.assertEqual(report['leaseHolder'], 'other')
        # Expired lease reports a negative expiry and is not a blocker.
        self.clock.advance(60)
        report = self.verdict()
        self.assertTrue(report['ready'])
        self.assertLess(report['leaseExpiresInSec'], 0)
        # A stored primary different from --primary blocks every acquire.
        # primary_host is sticky once a row exists, so use a fresh database.
        self.db = self.base / 'lease2.sqlite'
        self.lease('acquire', host='otherhost', primary='other', ttl=60)
        report = self.verdict()
        self.assertFalse(report['ready'])
        self.assertEqual(report['blockers'], ['primary-mismatch'])
        # --primary matching the stored value clears the blocker.
        report = self.verdict('--primary', 'other')
        self.assertTrue(report['ready'])

    def test_no_lease_db(self):
        self.publish()
        report = self.verdict()
        self.assertEqual(report['blockers'], ['no-lease-db'])
        self.assertFalse(report['ready'])
        self.assertIsNone(report['leaseHolder'])
        self.assertIsNone(report['leaseExpiresInSec'])
        # A directory, and non-database bytes all read the same.
        self.db = self.base / 'dirdb'
        self.db.mkdir()
        self.assertEqual(self.verdict()['blockers'], ['no-lease-db'])
        self.db = self.base / 'garbage.sqlite'
        self.db.write_bytes(b'not a sqlite database at all')
        self.assertEqual(self.verdict()['blockers'], ['no-lease-db'])
        self.db = self.base / 'empty.sqlite'
        self.db.write_bytes(b'')  # a valid empty db without the schema
        self.assertEqual(self.verdict()['blockers'], ['no-lease-db'])

    def test_no_snapshot(self):
        self.lease('acquire')
        self.assertEqual(self.verdict()['blockers'], ['no-snapshot'])
        # Missing store and a store path that is a plain file both fail safe.
        self.store = self.base / 'absent'
        self.assertEqual(self.verdict()['blockers'], ['no-snapshot'])
        self.store.write_text('x')
        self.assertEqual(self.verdict()['blockers'], ['no-snapshot'])
        self.store = self.base / 'snapshots'
        # An unreadable or malformed pointer is no usable snapshot.
        (self.store / 'latest.json').write_text('not json')
        self.assertEqual(self.verdict()['blockers'], ['no-snapshot'])
        (self.store / 'latest.json').write_text(json.dumps({
            'version': 1, 'tool': 'snapshot_publish', 'files': 6,
            'generation': 'snap-20000101T000000Z-0badf00d',
            'manifestSha256': '0' * 64}))
        # The pointer names a generation the store does not have.
        self.assertEqual(self.verdict()['blockers'], ['no-snapshot'])
        report = self.verdict()
        self.assertEqual(report['generation'],
                         'snap-20000101T000000Z-0badf00d')
        self.assertIsNone(report['snapshotAgeSec'])
        self.assertIsNone(report['wouldLoseSec'])

    def test_snapshot_unverified(self):
        self.lease('acquire')
        point = self.publish()
        # Bytes inside the generation change after publication.
        target = self.store / point['generation'] / 'leader/VISION.md'
        target.write_text('tampered\n')
        self.assertEqual(self.verdict()['blockers'], ['snapshot-unverified'])
        # A rewritten manifest no longer matches the pointer digest.
        self.publish()
        point = json.loads((self.store / 'latest.json').read_bytes())
        manifest = self.store / point['generation'] / 'manifest.json'
        manifest.write_text(manifest.read_text() + ' ')
        self.assertEqual(self.verdict()['blockers'], ['snapshot-unverified'])
        # A pointer digest that does not match the real manifest.
        self.repoint(point['generation'], '0' * 64)
        self.assertEqual(self.verdict()['blockers'], ['snapshot-unverified'])
        # A generation symlink resolving outside the store is refused.
        self.repoint(point['generation'], point['manifestSha256'])
        outside = self.base / 'outside'
        Path(self.store / point['generation']).rename(outside)
        (self.store / point['generation']).symlink_to(outside)
        self.assertEqual(self.verdict()['blockers'], ['snapshot-unverified'])

    def test_snapshot_incomplete(self):
        self.lease('acquire')
        (self.root / 'leader/VISION.md').unlink()
        name = 'snap-20990101T000000Z-bad0bad0'
        state_snapshot.create(self.root, self.store / name)
        digest = state_snapshot.sha256_file(self.store / name / 'manifest.json')
        self.repoint(name, digest)
        report = self.verdict()
        self.assertEqual(report['blockers'], ['snapshot-incomplete'])
        self.assertEqual(report['generation'], name)
        self.assertIsNone(report['snapshotAgeSec'])

    def test_snapshot_stale(self):
        self.lease('acquire')
        self.publish()
        self.clock.advance(901)
        report = self.verdict()
        self.assertEqual(report['blockers'], ['snapshot-stale'])
        self.assertFalse(report['ready'])
        self.assertEqual(report['snapshotAgeSec'], report['wouldLoseSec'])
        self.assertGreater(report['snapshotAgeSec'], 899)
        # --max-age controls the bound: the same snapshot is fresh at 60s
        # when it is only 50 seconds old, stale once it passes 60.
        self.clock.advance(-851)  # age about 50s
        self.assertTrue(self.verdict('--max-age', '60')['ready'])
        self.clock.advance(11)  # age about 61s
        report = self.verdict('--max-age', '60')
        self.assertEqual(report['blockers'], ['snapshot-stale'])

    def test_byte_identical_inputs(self):
        self.lease('acquire')
        self.publish()
        db_bytes = self.db.read_bytes()
        store_before = tree_bytes(self.store)
        report = self.verdict()
        self.assertTrue(report['ready'])
        self.assertEqual(self.db.read_bytes(), db_bytes)
        self.assertEqual(tree_bytes(self.store), store_before)
        # A fully blocked run creates nothing and writes nothing either.
        self.db = self.base / 'missing.sqlite'
        self.store = self.base / 'empty-store'
        self.store.mkdir()
        self.assertFalse(self.verdict()['ready'])
        self.assertEqual(list(self.store.iterdir()), [])
        self.assertFalse(self.db.exists())

    def test_argument_errors_exit_2(self):
        for extra in (['--max-age', '59'], ['--max-age', '86401'],
                      ['--max-age', 'x'], ['--primary', 'bad host'],
                      ['--db'], []):
            argv = ['--db', str(self.db), '--snapshot-store', str(self.store),
                    '--primary', 'primary', '--role', 'leader', '--host',
                    'standby', *extra]
            with self.assertRaises(SystemExit) as cm:
                with redirect_stdout(io.StringIO()):
                    standby_readiness.main(argv if extra else [])
            self.assertEqual(cm.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
