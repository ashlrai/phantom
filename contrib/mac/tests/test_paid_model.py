import json
import pathlib
import subprocess
import tempfile
import unittest


LAUNCHER = pathlib.Path(__file__).resolve().parents[1] / 'host-integration/launch.candidate.sh'


class PaidModelTest(unittest.TestCase):
    def resolve(self, models, pool, tier):
        source = LAUNCHER.read_text()
        start = source.index('case $POOL in codex-local)')
        end = source.index('# RQ-SEC-RUNLOG-SCRUB:', start)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'models.json').write_text(json.dumps(models))
            script = 'R=$1; POOL=$2; TIER=$3; J=job-1\n' + source[start:end] + '\nprintf "%s\\n" "$M"\ncat "$R/$J.base.meta"\n'
            return subprocess.run(['bash', '-c', script, 'test', directory, pool, tier], check=True, text=True, capture_output=True).stdout

    def test_lightning_fixture_falls_back_and_logs(self):
        models = {'devin.work': 'swe-2-max-lightning', 'devin.frontier': 'swe-2-high-lightning'}
        for tier in ('work', 'frontier'):
            with self.subTest(tier=tier):
                output = self.resolve(models, 'devin', tier)
                self.assertIn('PAID_MODEL_BLOCKED job-1 ' + models['devin.' + tier] + ' -> swe-2-max', output)
                self.assertIn('MODEL devin ' + tier + ' swe-2-max ', output)
                self.assertTrue(output.startswith('swe-2-max\n'))

    def test_allowed_model_passes_through(self):
        output = self.resolve({'devin.work': 'swe-2-flash'}, 'devin', 'work')
        self.assertTrue(output.startswith('swe-2-flash\n'))
        self.assertNotIn('PAID_MODEL_BLOCKED', output)

    def test_other_lanes_are_not_rewritten(self):
        self.assertTrue(self.resolve({'claude.work': 'example-lightning'}, 'claude', 'work').startswith('example-lightning\n'))

    def test_devin_defaults_to_max_at_every_tier(self):
        for tier in ('frontier', 'work', 'mid', 'fast'):
            with self.subTest(tier=tier):
                self.assertTrue(self.resolve({}, 'devin', tier).startswith('swe-2-max\n'))

    def test_devin_keeps_existing_free_tier_hints(self):
        models = {'devin': 'swe-2-max', 'devin.mid': 'swe-2-high', 'devin.fast': 'swe-2-medium'}
        for tier, model in (('mid', 'swe-2-high'), ('fast', 'swe-2-medium')):
            with self.subTest(tier=tier):
                self.assertTrue(self.resolve(models, 'devin', tier).startswith(model + '\n'))

    def test_flash_max_at_every_tier_overrides_all_model_hints(self):
        hints = ('', 'swe-2-flash-medium', 'swe-2-flash-high', 'swe-2-flash-max',
                 'swe-2-max', 'swe-2-high', 'swe-2-medium',
                 'swe-2-max-lightning', 'swe-2-high-LiGhTnInG',
                 'swe-2-flash-max-lightning', 'agoragentic', 'fusion', 'sidekick', 'invalid hint')
        for tier in ('frontier', 'work', 'mid', 'fast'):
            for key in ('devin-flash', 'devin-flash.' + tier):
                for hint in hints:
                    with self.subTest(tier=tier, key=key, hint=hint):
                        output = self.resolve({key: hint}, 'devin-flash', tier)
                        self.assertTrue(output.startswith('swe-2-flash-max\n'))
                        self.assertIn('MODEL devin-flash ' + tier + ' swe-2-flash-max ', output)
                        if hint.lower().endswith('-lightning'):
                            self.assertIn('PAID_MODEL_BLOCKED job-1 ' + hint + ' -> swe-2-flash-max', output)

    def test_flash_default_is_independent_of_devin_family_hints(self):
        for tier in ('frontier', 'work', 'mid', 'fast'):
            with self.subTest(tier=tier):
                output = self.resolve({'devin': 'swe-2-medium', 'devin.' + tier: 'swe-2-high'}, 'devin-flash', tier)
                self.assertTrue(output.startswith('swe-2-flash-max\n'))


if __name__ == '__main__':
    unittest.main()
