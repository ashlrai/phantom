import importlib.util
import pathlib
import os
import unittest
from unittest import mock

path = pathlib.Path(__file__).resolve().parents[2] / 'contrib/mac/host_session_observation.py'
spec = importlib.util.spec_from_file_location('host_session_observation', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def row(pid, parent, start, rss=1024, cpu=50):
    return dict(uid=os.getuid(), pid=pid, ppid=parent, start=start, rssBytes=rss, cpuPercent=cpu)


class ObservationTest(unittest.TestCase):
    def setUp(self):
        self.claim = dict(jobId='RQ-1', rootPid=10, start='s1', bootId='boot')
        self.rows = [row(10, 1, 's1'), row(11, 10, 's2', 2048, 250)]

    def sample(self, claims=None, first=None, second=None, boot='boot', verify=lambda _: True):
        return m.observe_sessions(claims or [self.claim], first if first is not None else self.rows,
                                  second if second is not None else self.rows, boot, 4, verify)

    def test_tree_and_multicore(self):
        item = self.sample()[0]
        self.assertEqual((item['state'], item['processCount'], item['rssBytes']), ('known', 2, 3072))
        self.assertEqual((item['cpuPercentOneCore'], item['cpuPercentHost']), (300, 75))
        self.assertIsNone(item['swapBytes'])

    def test_claim_identity_and_races(self):
        for kwargs in [dict(boot='other'), dict(verify=lambda _: False),
                       dict(second=[row(10, 1, 'new')]), dict(second=[row(10, 1, 's1')]),
                       dict(second=self.rows + [row(12, 10, 's3')]), dict(first=[]),
                       dict(second=[row(10, 1, 's1'), row(11, 10, 'reused')])]:
            with self.subTest(kwargs=kwargs): self.assertEqual(self.sample(**kwargs)[0]['state'], 'unknown')
        calls = iter([True, False])
        self.assertEqual(self.sample(verify=lambda _: next(calls))[0]['state'], 'unknown')

    def test_overlapping_claims_are_unknown(self):
        nested = dict(jobId='RQ-2', rootPid=11, start='s2', bootId='boot')
        self.assertEqual([x['state'] for x in self.sample(claims=[self.claim, nested])], ['unknown', 'unknown'])
        self.assertEqual([x['state'] for x in self.sample(claims=[self.claim, self.claim])], ['unknown', 'unknown'])

    def test_pressure_fail_closed(self):
        for value, expected in [('1', True), ('2', False), ('4', False), ('0', False), ('bad', False)]:
            self.assertEqual(m.admission_allowed(m.pressure_level('Darwin', lambda _: value)), expected)
        self.assertFalse(m.admission_allowed(m.pressure_level('Darwin', lambda _: (_ for _ in ()).throw(TimeoutError()))))
        self.assertTrue(m.admission_allowed(m.pressure_level('Linux')))

    def test_numeric_census_is_strict_and_bounded(self):
        rows = m.numeric_census(lambda _: '10 1 2 150.5\n11 10 4 0.0\n')
        self.assertEqual(rows[0], dict(pid=10, ppid=1, rssBytes=2048, cpuPercent=150.5))
        for text in ('', '10 1 2 command', '10 1 2 1\n10 1 2 1', '10 1 2 1 extra'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                m.numeric_census(lambda _: text)

    def test_start_census_is_source_labeled_and_numeric_only(self):
        rows = m.identity_census(lambda _: '10 1 2 150.5 501 Fri Nov  6 12:00:00 2026\n')
        self.assertEqual(rows[0]['startSource'], 'ps-lstart')
        self.assertRegex(rows[0]['start'], r'^[0-9a-f]{64}$')
        self.assertEqual(rows[0]['cpuPercent'], 150.5)
        for text in ('', '10 1 2 1 Fri Nov 6 12:00:00 2026 command',
                     '10 1 2 1 invalid Nov 6 12:00:00 2026',
                     '10 1 2 1 Fri Nov 6 12:00:00 2026\n' * 2):
            with self.subTest(text=text), self.assertRaises(ValueError):
                m.identity_census(lambda _: text)

    def test_observation_does_not_serialize_process_rows(self):
        def fake(argv):
            return '10 1 2 3.0\n' if argv[0] == '/bin/ps' else '1\n'
        with mock.patch.object(m.datetime, 'datetime', wraps=m.datetime.datetime) as clock:
            clock.now.return_value = m.datetime.datetime(2026, 1, 1, tzinfo=m.datetime.timezone.utc)
            value = m.host_observation('Darwin', fake)
        self.assertEqual(value['censusState'], 'known')
        self.assertEqual(value['sessions'], [])
        self.assertNotIn('10', str(value))

    def test_no_unverified_identity(self):
        self.assertEqual(self.sample(verify=None)[0]['state'], 'unknown')
        self.assertEqual(self.sample(second=self.rows + [self.rows[0]])[0]['state'], 'unknown')

if __name__ == '__main__': unittest.main()
