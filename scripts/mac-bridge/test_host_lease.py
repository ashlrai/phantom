import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import host_lease  # noqa: E402

SCRIPT = Path(__file__).with_name('host_lease.py')


class FakeClock:
    def __init__(self, now=1_000_000.0):
        self.now = float(now)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.db = self.root / 'lease.sqlite'
        self.clock = FakeClock()
        self.clock_file = self.root / 'clock'
        self.publish_clock()

    def publish_clock(self):
        self.clock_file.write_text(str(self.clock.now))

    def call(self, *argv, ok=True):
        args = host_lease.parser().parse_args(['--db', str(self.db), *argv])
        result = host_lease.run(args, clock=self.clock)
        self.assertEqual(result['ok'], ok, result)
        return result

    def process(self, *argv):
        env = dict(os.environ)
        env['HOST_LEASE_CLOCK_FILE'] = str(self.clock_file)
        return subprocess.run([sys.executable, str(SCRIPT), '--db', str(self.db), *argv],
                              capture_output=True, text=True, timeout=40, env=env)

    def cli(self, *argv, ok=True):
        proc = self.process(*argv)
        self.assertEqual(proc.returncode, 0 if ok else 1, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result['ok'], ok)
        return result

    def race(self, *hosts):
        children = [self.spawn('acquire', 'leader', '--host', host) for host in hosts]
        results = []
        for child in children:
            stdout, stderr = child.communicate(timeout=40)
            result = json.loads(stdout)
            self.assertEqual(child.returncode, 0 if result['ok'] else 1, stderr)
            results.append(result)
        return results

    def spawn(self, *argv):
        env = dict(os.environ)
        env['HOST_LEASE_CLOCK_FILE'] = str(self.clock_file)
        return subprocess.Popen([sys.executable, str(SCRIPT), '--db', str(self.db), *argv],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=env)

    def stored(self, role='leader'):
        db = sqlite3.connect(self.db)
        try:
            return db.execute('SELECT holder, fencing, expires, primary_host FROM leases'
                              ' WHERE role=?', (role,)).fetchone()
        finally:
            db.close()

    def test_contending_processes_hold_one_at_a_time(self):
        results = self.race('macbook', 'macmini')
        winners = [r for r in results if r['ok']]
        self.assertEqual(len(winners), 1)
        self.assertEqual(winners[0]['fencing'], 1)
        loser = next(r for r in results if not r['ok'])
        self.assertEqual(loser['error'], 'lease held')
        self.assertNotIn('fencing', loser)
        self.assertEqual(self.call('status', 'leader')['holder'], winners[0]['holder'])
        # Expiry under the shared fake clock frees the lease; racing again still
        # leaves exactly one holder, and the fencing number has risen.
        self.clock.advance(60)
        self.publish_clock()
        results = self.race('macbook', 'macmini')
        winners = [r for r in results if r['ok']]
        self.assertEqual(len(winners), 1)
        self.assertEqual(winners[0]['fencing'], 2)
        self.assertEqual(self.stored()[0], winners[0]['holder'])

    def test_failover_after_expiry_plus_grace(self):
        first = self.call('acquire', 'leader', '--host', 'macbook', '--ttl', '30',
                          '--primary', 'macbook', '--grace', '10')
        self.assertEqual(first['fencing'], 1)
        # Non-primary is refused inside the grace window, even past expiry.
        self.clock.now = first['expires'] + 9
        denied = self.call('acquire', 'leader', '--host', 'macmini',
                           '--primary', 'macbook', '--grace', '10', ok=False)
        self.assertEqual(denied['error'], 'within primary grace')
        self.assertEqual(denied['acquire_after'], first['expires'] + 10)
        # The restarting primary re-acquires immediately; the leader never flipped.
        back = self.call('acquire', 'leader', '--host', 'macbook',
                         '--primary', 'macbook', '--grace', '10')
        self.assertEqual(back['fencing'], 2)
        # Once the lease has been expired for the full grace period the standby
        # takes over and the fencing number rises again.
        self.clock.now = back['expires'] + 9
        self.call('acquire', 'leader', '--host', 'macmini',
                  '--primary', 'macbook', '--grace', '10', ok=False)
        self.clock.now = back['expires'] + 10
        flip = self.call('acquire', 'leader', '--host', 'macmini',
                         '--primary', 'macbook', '--grace', '10')
        self.assertEqual(flip['fencing'], 3)
        status = self.call('status', 'leader')
        self.assertEqual(status['holder'], 'macmini')
        self.assertEqual(status['state'], 'held')

    def test_stale_holder_rejected_after_failover(self):
        first = self.call('acquire', 'leader', '--host', 'macbook', '--ttl', '30',
                          '--primary', 'macbook', '--grace', '5')
        self.clock.now = first['expires'] + 5
        second = self.call('acquire', 'leader', '--host', 'macmini',
                           '--primary', 'macbook', '--grace', '5')
        self.assertEqual(second['fencing'], 2)
        for action in ('renew', 'release'):
            self.call(action, 'leader', '--host', 'macbook', '--fencing', '1', ok=False)
        # Even the current fencing number does not help a stale holder.
        for action in ('renew', 'release'):
            self.call(action, 'leader', '--host', 'macbook', '--fencing', '2', ok=False)
        renewed = self.call('renew', 'leader', '--host', 'macmini', '--fencing', '2')
        self.assertEqual(renewed['expires'], self.clock.now + 30)
        self.assertEqual(self.stored()[:2], ('macmini', 2))

    def test_primary_regains_only_by_normal_expiry(self):
        first = self.call('acquire', 'leader', '--host', 'macbook', '--ttl', '30',
                          '--primary', 'macbook', '--grace', '5')
        self.clock.now = first['expires'] + 5
        second = self.call('acquire', 'leader', '--host', 'macmini', '--ttl', '40',
                           '--primary', 'macbook', '--grace', '5')
        # The named primary cannot preempt a live lease, even just before expiry.
        denied = self.call('acquire', 'leader', '--host', 'macbook',
                           '--primary', 'macbook', '--grace', '5', ok=False)
        self.assertEqual(denied['error'], 'lease held')
        self.clock.now = second['expires'] - 1
        self.call('acquire', 'leader', '--host', 'macbook',
                  '--primary', 'macbook', '--grace', '5', ok=False)
        # At normal expiry the primary takes it back with no grace delay.
        self.clock.now = second['expires']
        back = self.call('acquire', 'leader', '--host', 'macbook',
                         '--primary', 'macbook', '--grace', '5')
        self.assertEqual(back['fencing'], 3)
        self.assertEqual(self.stored()[:2], ('macbook', 3))

    def test_fencing_rises_on_every_holder_change(self):
        first = self.call('acquire', 'leader', '--host', 'macbook')
        self.assertEqual(first['fencing'], 1)
        released = self.call('release', 'leader', '--host', 'macbook', '--fencing', '1')
        self.assertEqual(released['fencing'], 2)
        second = self.call('acquire', 'leader', '--host', 'macmini')
        self.assertEqual(second['fencing'], 3)
        self.clock.now = second['expires'] + 1
        third = self.call('acquire', 'leader', '--host', 'macbook')
        self.assertEqual(third['fencing'], 4)
        # Renew is not a holder change and must not move the fencing number.
        self.call('renew', 'leader', '--host', 'macbook', '--fencing', '4')
        self.assertEqual(self.stored()[1], 4)

    def test_renew_requires_live_lease_and_exact_credentials(self):
        got = self.call('acquire', 'leader', '--host', 'macbook', '--ttl', '30')
        self.call('renew', 'leader', '--host', 'macmini', '--fencing', '1', ok=False)
        self.call('renew', 'leader', '--host', 'macbook', '--fencing', '9', ok=False)
        self.clock.advance(10)
        renewed = self.call('renew', 'leader', '--host', 'macbook',
                            '--fencing', '1', '--ttl', '60')
        self.assertEqual(renewed['expires'], self.clock.now + 60)
        self.assertEqual(self.stored()[2], renewed['expires'])
        self.clock.now = renewed['expires']
        denied = self.call('renew', 'leader', '--host', 'macbook', '--fencing', '1', ok=False)
        self.assertEqual(denied['error'], 'lease expired')

    def test_release_frees_lease_for_anyone_immediately(self):
        got = self.call('acquire', 'leader', '--host', 'macbook', '--ttl', '30',
                        '--primary', 'macbook', '--grace', '600')
        # A voluntary release skips the grace protection: the holder stepped down.
        self.call('release', 'leader', '--host', 'macbook', '--fencing', str(got['fencing']))
        second = self.call('acquire', 'leader', '--host', 'macmini', '--primary', 'macbook')
        self.assertEqual(second['holder'], 'macmini')
        self.assertEqual(second['fencing'], 3)
        # An expired but still-recorded holder may also release; that too frees
        # the lease without grace because release is deliberate.
        self.clock.now = second['expires'] + 1
        self.call('release', 'leader', '--host', 'macmini', '--fencing', '3')
        self.assertEqual(self.call('status', 'leader')['state'], 'free')
        self.call('release', 'leader', '--host', 'macmini', '--fencing', '2', ok=False)
        third = self.call('acquire', 'leader', '--host', 'macmini')
        self.assertEqual(third['holder'], 'macmini')

    def test_primary_preference_is_stored_and_conflicts_rejected(self):
        self.call('acquire', 'leader', '--host', 'macbook', '--ttl', '30',
                  '--primary', 'macbook', '--grace', '10')
        # A host naming itself primary is refused outright, not merely delayed.
        conflict = self.call('acquire', 'leader', '--host', 'macmini', '--primary', 'macmini',
                             ok=False)
        self.assertEqual(conflict['error'], 'primary mismatch')
        self.assertEqual(conflict['primary'], 'macbook')
        # A standby that recorded the primary keeps honouring it after failover.
        self.call('acquire', 'standby', '--host', 'macmini', '--ttl', '30',
                  '--primary', 'macbook', '--grace', '10')
        held = self.stored('standby')
        self.assertEqual(held[3], 'macbook')
        self.clock.now = held[2] + 5
        self.call('acquire', 'standby', '--host', 'macmini', '--grace', '10', ok=False)
        self.clock.now = held[2] + 10
        flip = self.call('acquire', 'standby', '--host', 'macmini', '--grace', '10')
        self.assertEqual(flip['holder'], 'macmini')
        # With no named primary an expired lease is simply first come.
        self.call('acquire', 'open', '--host', 'macbook', '--ttl', '30')
        self.clock.advance(31)
        grab = self.call('acquire', 'open', '--host', 'macmini', '--grace', '600')
        self.assertEqual(grab['holder'], 'macmini')

    def test_status_reports_state_without_disclosing_fencing(self):
        missing = self.call('status', 'leader')
        self.assertEqual((missing['state'], missing['holder'], missing['primary']),
                         ('free', None, None))
        self.assertNotIn('fencing', missing)
        got = self.call('acquire', 'leader', '--host', 'macbook', '--ttl', '30',
                        '--primary', 'macbook')
        held = self.call('status', 'leader')
        self.assertEqual((held['state'], held['holder'], held['primary']),
                         ('held', 'macbook', 'macbook'))
        self.assertNotIn('fencing', held)
        self.clock.now = got['expires'] + 1
        self.assertEqual(self.call('status', 'leader')['state'], 'expired')
        self.call('release', 'leader', '--host', 'macbook', '--fencing', '1')
        self.assertEqual(self.call('status', 'leader')['state'], 'free')

    def test_cli_end_to_end_and_invalid_inputs(self):
        got = self.cli('acquire', 'leader', '--host', 'macbook', '--ttl', '30')
        self.assertEqual(got['fencing'], 1)
        self.cli('renew', 'leader', '--host', 'macbook', '--fencing', '1')
        self.cli('release', 'leader', '--host', 'macbook', '--fencing', '1')
        self.assertEqual(self.cli('status', 'leader')['state'], 'free')
        for argv in [('acquire', 'leader', '--host', 'bad host'),
                     ('acquire', 'leader', '--host', 'bad/host'),
                     ('acquire', 'leader', '--host', '-leading'),
                     ('acquire', 'leader', '--host', 'a' * 129),
                     ('acquire', 'bad/role', '--host', 'macbook'),
                     ('renew', 'leader', '--host', 'macbook', '--fencing', '0'),
                     ('renew', 'leader', '--host', 'macbook', '--fencing', 'abc')]:
            proc = self.process(*argv)
            self.assertNotEqual(proc.returncode, 0, argv)
            self.assertNotIn('macbook', proc.stdout + proc.stderr)
        proc = subprocess.run([sys.executable, str(SCRIPT), '--db',
                               str(self.root / 'missing' / 'x.sqlite'), 'status', 'leader'],
                              capture_output=True, text=True, timeout=40)
        self.assertEqual(proc.returncode, 1)
        self.assertFalse(json.loads(proc.stdout)['ok'])
        self.assertEqual(os.stat(self.db).st_mode & 0o777, 0o600)

    def test_valid_identity_boundaries(self):
        host = 'a' * 128
        got = self.call('acquire', 'leader', '--host', host)
        self.assertEqual(got['holder'], host)
        dotted = self.call('acquire', 'other-role_1.2', '--host', 'host-name_1.2')
        self.assertEqual(dotted['fencing'], 1)


if __name__ == '__main__':
    unittest.main()
