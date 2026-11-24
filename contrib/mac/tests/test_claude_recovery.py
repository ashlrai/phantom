"""Offline tick recovery: preserve failed attempts, route once, stop on any result."""
import json
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launch_precheck import claude_recoveries, repair_target
from test_dispatchd import build, tick, queue_job, launch_stubs, held_lanes, lane_slot, dispatched

JOB = 'RQ-CLAUDE-RECOVER'
CHILD = JOB + '-CR1'


def attempts():
    rows = []
    for age in (240, 120):
        ts = time.strftime('%Y-%m-%dT%H:%M:%S%z', time.localtime(time.time() - age))
        rows.extend([dict(event='launch', job=JOB, repo='phantom', lane='claude', ts=ts),
                     dict(event='finish', job=JOB, lane='claude', empty=True, exit_code=1, ts=ts)])
    return rows


class ClaudeRecovery(unittest.TestCase):
    def test_classifier_requires_two_distinct_measured_retryable_attempts(self):
        rows = attempts(); now = time.time()
        self.assertEqual(list(claude_recoveries(rows, now)), [JOB])
        self.assertEqual(claude_recoveries(rows[:2] + [rows[1]], now), {})
        self.assertEqual(claude_recoveries(rows[:2] * 2, now), {})
        self.assertEqual(claude_recoveries(rows + [dict(rows[2], ts=rows[3]['ts']), rows[3]], now), {})
        for change in (dict(empty=False), dict(empty=None), dict(exit_code=0), dict(exit_code=True),
                       dict(exit_code=None), dict(pool_error='authentication'), dict(lane='codex-cmp'),
                       dict(ts='bad'), dict(ts='2000-01-01T00:00:00Z')):
            with self.subTest(change=change):
                self.assertEqual(claude_recoveries(rows[:-1] + [dict(rows[-1], **change)], now), {})
        for end in (dict(event='claim'), dict(event='publish'), dict(event='outcome', state='MERGED')):
            self.assertEqual(claude_recoveries(rows + [dict(end, job=JOB)], now), {})
        self.assertEqual(repair_target('RQ-FIXUP-phantom-42-abcdef0-CR1', 'phantom').groups(),
                         ('FIXUP', '42', 'abcdef0'))

    def fixture(self, slot=None, needs=None):
        slots = held_lanes(); slots.update(claude=lane_slot(), **{'codex-cmp': slot or lane_slot()})
        tmp = build(slots=slots); self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve(); q = home / '.ashlr-runs/queue'
        queue_job(home, JOB, 'claude')
        prompt = q / f'prompts/{JOB}.md'
        prompt.write_text(f'{JOB} (P1, pool=claude, size<=200): Fix bounded worker retry handling.')
        fields = (q / 'ready.tsv').read_text().strip().split('\t')
        fields.append(json.dumps(dict(needs=needs or [], data_class='internal', max_cost_class='metered')))
        (q / f'run/{JOB}.line').write_text('\t'.join(fields))
        (q / 'ready.tsv').write_text('')
        ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
        ledger.write_text(''.join(json.dumps(r) + '\n' for r in attempts()))
        (home / f'.ashlr-runs/{JOB}.log').write_text('original failure evidence\n')
        return home, q, ledger, launch_stubs(home)

    def test_routes_once_and_preserves_evidence_on_success_and_repeated_failure(self):
        for empty, code in ((False, 0), (True, 1)):
            with self.subTest(empty=empty):
                home, q, ledger, env = self.fixture()
                before = ledger.read_text()
                result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(dispatched(home, CHILD))
                self.assertEqual((q / f'run/{CHILD}.line').read_text().split('\t')[2], 'codex-cmp')
                self.assertTrue(ledger.read_text().startswith(before))
                self.assertEqual((home / f'.ashlr-runs/{JOB}.log').read_text(), 'original failure evidence\n')
                self.assertIn(CHILD + ' (', (q / f'prompts/{CHILD}.md').read_text())
                with ledger.open('a') as out:
                    out.write(json.dumps(dict(event='finish', job=CHILD, lane='codex-cmp', empty=empty, exit_code=code)) + '\n')
                for _ in range(2):
                    result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                rows = list(map(json.loads, ledger.read_text().splitlines()))
                self.assertEqual(len([r for r in rows if r.get('event') == 'claim' and r.get('job') == CHILD]), 1)
                self.assertTrue(json.loads((q / 'claude-recoveries.json').read_text())[JOB]['done'])
                self.assertEqual(len([r for r in rows if r.get('event') == 'claude_recovery']), 1)

    def test_unavailable_or_unauthorized_destinations_defer_until_healthy(self):
        for slot, needs in ((lane_slot(held=True), None), (lane_slot(auth_failed=True), None),
                            (lane_slot(cost_class='metered'), None), (lane_slot(), ['unadvertised'])):
            with self.subTest(slot=slot, needs=needs):
                home, q, ledger, env = self.fixture(slot, needs)
                result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(dispatched(home, CHILD))
                self.assertIn(CHILD, (q / 'ready.tsv').read_text())
                if needs is None:
                    slots = json.loads((q / 'slots.json').read_text())
                    slots['codex-cmp'] = lane_slot()
                    (q / 'slots.json').write_text(json.dumps(slots))
                    (q / f'prompts/{CHILD}.md').unlink()  # interrupted prompt preparation repairs itself
                    result = tick(home, env); self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue(dispatched(home, CHILD))


if __name__ == '__main__': unittest.main()
