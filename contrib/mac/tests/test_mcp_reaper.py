import os
from pathlib import Path
import signal
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mcp_reaper as reaper

NPM = 'npm exec -y phantom-secrets-mcp@0.7.9'
SH = 'sh -c phantom-secrets-mcp'
NODE = 'node /x/.npm/_npx/1/node_modules/.bin/phantom-secrets-mcp'
STACK = 'npm exec -y -p @ashlr/stack@0.3.6 ashlr-stack-mcp'


def ps(*rows):
    return '\n'.join(f'{p} {pp} {pg} {et} {rss} {cmd}' for p, pp, pg, et, rss, cmd in rows)


class ParseTests(unittest.TestCase):
    def test_etime_forms(self):
        self.assertEqual(reaper.parse_etime('00:59'), 59)
        self.assertEqual(reaper.parse_etime('01:02:03'), 3723)
        self.assertEqual(reaper.parse_etime('2-00:00:01'), 172801)
        self.assertIsNone(reaper.parse_etime('soon'))

    def test_malformed_rows_are_skipped(self):
        rows = reaper.parse_rows(ps((5, 1, 5, '10:00', 100, NPM)) + '\ngarbage\n6 1 6 bad 1 npm exec x')
        self.assertEqual(list(rows), [5])

    def test_names_do_not_overmatch(self):
        rows = reaper.parse_rows(ps(
            (1, 0, 1, '99:00', 1, 'node /app/ashlr-mcp-server-extras'),
            (2, 0, 2, '99:00', 1, 'vim ashlr-mcp'),
            (3, 0, 3, '99:00', 1, STACK)))
        self.assertEqual([p for p, r in rows.items() if reaper.is_mcp(r)], [3])


class AnalyseTests(unittest.TestCase):
    def rows(self, *entries):
        return reaper.parse_rows(ps(*entries))

    def test_live_job_servers_are_never_killed(self):
        rows = self.rows((10, 1, 10, '30:00', 500, 'codex exec -C /wt/RQ-A'),
                         (11, 10, 11, '05:00', 80000, NPM), (12, 11, 11, '05:00', 60000, SH),
                         (13, 12, 11, '05:00', 90000, NODE))
        r = reaper.analyse(rows)
        self.assertEqual(r['kill'], [])
        self.assertEqual((r['mcp_processes'], r['npm_exec_processes'], r['orphan_roots']), (3, 1, 0))
        self.assertEqual(r['rss_kb'], 230000)

    def test_young_orphan_is_inside_grace(self):
        rows = self.rows((11, 1, 11, '00:59', 1, NPM), (12, 11, 11, '00:59', 1, NODE))
        r = reaper.analyse(rows, 60)
        self.assertEqual((r['orphan_roots'], r['orphan_roots_over_grace'], r['kill']), (1, 0, []))

    def test_old_orphan_tree_dies_including_unmatched_descendant(self):
        rows = self.rows((11, 1, 11, '01:01', 1, NPM), (12, 11, 11, '01:01', 1, SH),
                         (13, 12, 11, '01:01', 1, 'node /opt/other/server.js'))
        r = reaper.analyse(rows, 60)
        self.assertEqual(r['kill'], [11, 12, 13])
        self.assertEqual(r['oldest_orphan_age'], 61)

    def test_group_kill_only_when_every_member_is_in_kill_set(self):
        rows = self.rows((11, 1, 11, '05:00', 1, NPM), (12, 11, 11, '05:00', 1, NODE),
                         (20, 1, 11, '05:00', 1, 'zsh -l'))
        groups, loose = reaper.plan_signals(rows, [11, 12])
        self.assertEqual((groups, loose), ([], [11, 12]))
        rows = self.rows((11, 1, 11, '05:00', 1, NPM), (12, 11, 11, '05:00', 1, NODE))
        self.assertEqual(reaper.plan_signals(rows, [11, 12]), ([11], []))

    def test_own_group_is_never_signalled(self):
        own = os.getpgrp()
        rows = self.rows((11, 1, own, '05:00', 1, NPM))
        self.assertEqual(reaper.plan_signals(rows, [11]), ([], [11]))


class ReapTests(unittest.TestCase):
    def reader(self, text):
        return lambda: reaper.parse_rows(text)

    def test_unknown_inventory_kills_nothing(self):
        with patch.object(os, 'killpg') as kg, patch.object(os, 'kill') as k:
            self.assertEqual(reaper.reap(read=lambda: None), {'known': False, 'killed': 0})
        kg.assert_not_called(); k.assert_not_called()

    def test_blocked_ps_is_unknown(self):
        with patch.object(reaper.process_snapshot, '_bounded', side_effect=PermissionError):
            self.assertIsNone(reaper.snapshot())

    def test_reap_terms_then_kills_group(self):
        text = ps((11, 1, 11, '05:00', 1, NPM), (12, 11, 11, '05:00', 1, NODE))
        with patch.object(os, 'killpg') as kg:
            r = reaper.reap(read=self.reader(text), sleep=lambda s: None)
        self.assertEqual(r['killed'], 2)
        self.assertEqual([c.args for c in kg.call_args_list],
                         [(11, signal.SIGTERM), (11, signal.SIGKILL)])

    def test_dry_run_signals_nothing(self):
        text = ps((11, 1, 11, '05:00', 1, NPM))
        with patch.object(os, 'killpg') as kg, patch.object(os, 'kill') as k:
            r = reaper.reap(dry_run=True, read=self.reader(text))
        self.assertEqual((r['killed'], r['would_kill']), (0, 1))
        kg.assert_not_called(); k.assert_not_called()

    def test_census_reports_without_kill_key(self):
        r = reaper.census(read=self.reader(ps((11, 1, 11, '05:00', 7, NPM))))
        self.assertNotIn('kill', r)
        self.assertEqual((r['known'], r['rss_kb'], r['orphan_roots_over_grace']), (True, 7, 1))


if __name__ == '__main__':
    unittest.main()
