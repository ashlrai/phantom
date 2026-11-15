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


if __name__ == '__main__':
    unittest.main()
