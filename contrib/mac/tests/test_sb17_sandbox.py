"""Hermetic checks for the SB-17 SANDBOX-DENY-OSA draft (RQ-SBDENYLSDQ7).

The lane profiles live under ~/.ashlr-runs/bin and are never committed; these
tests verify the deliverable is self-consistent, sha-pinned and tightening-only.
"""
import hashlib
from pathlib import Path
import re
import unittest

SANDBOX = Path(__file__).resolve().parents[1] / 'sandbox'
BLOCK = (SANDBOX / 'sb17-block.sb').read_text()
DIFF = (SANDBOX / 'sandbox-deny-osa.diff').read_text()
APPLY = (SANDBOX / 'apply-sb17.sh').read_text()
TEST = (SANDBOX / 'test-sb17-osa.sh').read_text()
SUMS = (SANDBOX / 'SHA256SUMS').read_text()

LANES = ['agent.sb', 'claude.sb', 'codex-cmp.sb', 'codex-local.sb', 'codex-personal.sb']
MACH = '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))'
AES = '(deny appleevent-send)'
SHA = re.compile(r'\b[0-9a-f]{64}\b')


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Sb17Tests(unittest.TestCase):
    def test_block_is_exactly_the_two_denies_plus_comment(self):
        lines = BLOCK.splitlines()
        self.assertTrue(lines[0].startswith('; SB-17'))
        self.assertEqual(lines[1:], [MACH, AES])
        self.assertNotIn('(allow', BLOCK)

    def test_diff_covers_all_five_profiles_and_launch_sh(self):
        self.assertEqual(DIFF.count('+++ b/bin/'), 6)
        for lane in LANES:
            self.assertIn(f'+++ b/bin/{lane}', DIFF)
        self.assertIn('+++ b/bin/launch.sh', DIFF)

    def test_diff_is_tightening_only(self):
        for lane in LANES:
            section = DIFF.split(f'+++ b/bin/{lane}')[1].split('--- a/bin/')[0]
            adds = [l for l in section.splitlines() if l.startswith('+')]
            self.assertEqual(len(adds), 3, lane)
            self.assertIn('+' + MACH, adds)
            self.assertIn('+' + AES, adds)
            self.assertFalse([l for l in section.splitlines()
                              if l.startswith('-') and not l.startswith('---')], lane)

    def test_launch_sh_hunk_moves_only_the_pin(self):
        section = DIFF.split('+++ b/bin/launch.sh')[1]
        removed = [l for l in section.splitlines() if l.startswith('-') and not l.startswith('---')]
        added = [l for l in section.splitlines() if l.startswith('+')]
        self.assertEqual(len(removed), 1)
        self.assertEqual(len(added), 1)
        self.assertIn('LSB=$R/bin/codex-local.sb; LSB_SHA=', removed[0])
        self.assertIn('LSB_SHA=SB17_POST_SHA_CODEX_LOCAL', added[0])

    def test_sha_pins_are_consistent_across_artifacts(self):
        block_sha = sha256(SANDBOX / 'sb17-block.sb')
        self.assertIn(block_sha, APPLY, 'apply-sb17.sh must pin the block it appends')
        self.assertIn(block_sha, SUMS)
        for row in SUMS.strip().splitlines():
            digest, name = row.split('  ')
            self.assertEqual(digest, sha256(SANDBOX / name), name)

    def test_apply_pins_every_pre_and_post_sha(self):
        for expected in ('002278b0c55fee50', 'ed8fc729c73bbcfa', '56fe451c11a8ec28',
                         'a007a4074c797653', 'd3f5658f1c24d1e4', 'e085cf77b53eebb9',
                         'fdb051cdf1a379f9', '32adc419ce5fe36e', '422ea9b69bcaecd0',
                         '994cada9889adecc'):
            self.assertIn(expected, APPLY)

    def test_test_script_probes_every_lane(self):
        for lane in LANES:
            self.assertIn(lane, TEST)
        for probe in ('NSWorkspace', 'osascript', 'git --version', 'bun test',
                      'cargo test', 'codex --version', 'devin'):
            self.assertIn(probe, TEST)

    def test_apply_refuses_to_touch_live_tree_by_default(self):
        self.assertIn('ASHLR_RUNS_BIN', APPLY)
        self.assertIn('.ashlr-runs', APPLY)


if __name__ == '__main__':
    unittest.main()
