"""Live-parity pins for contrib/mac/dispatchd.py (RQ-DISPATCH-LIVEPARITY).

dispatchd.py runs a tick at import, so the pattern tables are exec'd from the
source slice between their markers instead of importing the module.
"""
import re
from pathlib import Path
import unittest

SRC = (Path(__file__).resolve().parents[1] / 'dispatchd.py').read_text()


def _slice(start, end):
    a = SRC.index(start)
    return SRC[a:SRC.index(end, a)]


NS = {'re': re}
exec(_slice('_Q = r"', 'AB_PROV ='), NS)
exec(_slice('_A_TOK = (', 'def ab_auth_scan'), NS)


def ids(table, prov, line):
    return [pid for pid, rx in table[prov] if rx.search(line)]


class LiveLogStrings(unittest.TestCase):
    def test_claude_oauth_expired(self):
        line = 'Failed to authenticate: OAuth session expired and could not be refreshed'
        self.assertEqual(ids(NS['AB_RX'], 'anthropic', line), ['claude_oauth_expired'])

    def test_devin_weekly_quota(self):
        line = 'Error: Agent error: Your weekly usage quota has been exhausted'
        self.assertEqual(ids(NS['AB_RX'], 'devin', line), ['devin_weekly_quota'])

    def test_live_lines_must_stand_alone(self):
        rx = NS['AB_RX']
        self.assertFalse(ids(rx, 'anthropic', 'the log says: Failed to authenticate: OAuth session expired and could not be refreshed'))
        self.assertFalse(ids(rx, 'devin', 'echo Error: Agent error: Your weekly usage quota has been exhausted soon'))


class NotLoggedInNarrowed(unittest.TestCase):
    def test_cli_line_matches(self):
        for line in ('Not logged in', 'Not logged in · Please run /login'):
            self.assertIn('claude_not_logged_in', ids(NS['AB_AUTH_RX'], 'anthropic', line))

    def test_unrelated_line_does_not_match(self):
        for line in ('the user was not logged in to the staging dashboard',
                     'test: asserts we are not logged in after logout',
                     '> Not logged in is the message a CLI prints'):
            self.assertEqual(ids(NS['AB_AUTH_RX'], 'anthropic', line), [], line)

    def test_other_auth_lines_still_match(self):
        self.assertTrue(ids(NS['AB_AUTH_RX'], 'anthropic', 'API Error: 401 {"type":"error"}'))


class Defaults(unittest.TestCase):
    def test_live_values(self):
        for pat in (r'MAX_LAUNCH_PER_TICK = 8;', r'MAX_REAPS = 12;', r'PH_DRIP_MAX = 400;',
                    r'GITSAFE_SHA = "234fb12a57a51fdfed81da8702a0b452c183f2726582608b81b7e811a65ce1a2"'):
            self.assertIsNotNone(re.search(pat, SRC), pat)


if __name__ == '__main__':
    unittest.main()
