"""Exercise the exact patched launcher with only unsafe external effects stubbed."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parents[1]
PACKET = HERE.parents[2]
REFERENCE = PACKET / 'reference/ACTUAL-READONLY-launch.sh'
PATCH = HERE / 'host-integration/launch.patch'

spec = importlib.util.spec_from_file_location('pressure', HERE / 'host_pressure_admission.py')
pressure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pressure)


class NativePressureBoundary(unittest.TestCase):
    def test_pressure_policy(self):
        for raw, expected in [('1\n', True), ('2\n', False), ('4\n', False), ('', False), ('garbage', False)]:
            self.assertEqual(pressure.allowed('Darwin', lambda _: raw), expected)
        self.assertFalse(pressure.allowed('Darwin', lambda _: (_ for _ in ()).throw(TimeoutError())))
        self.assertTrue(pressure.allowed('Linux', lambda _: self.fail('unexpected probe')))

    def launch(self, lane, fresh):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            run = home / '.ashlr-runs'
            (run / 'bin').mkdir(parents=True)
            (run / 'queue/run').mkdir(parents=True)
            (home / '.local/bin').mkdir(parents=True)
            wt = home / 'Projects/ashlrai/wt/JOB'
            wt.mkdir(parents=True)
            (wt / '.git').write_text('fixture')
            (run / 'queue/run/JOB.rc').write_text('old')
            (run / 'models.json').write_text('{}')
            (run / 'bin/scrub.pl').write_text('while (<STDIN>) { print; }\n')
            git = home / '.local/bin/git'
            git.write_text('#!/bin/sh\ncase "$*" in *rev-parse*) printf "123456789abcdef\\n";; esac\n')
            git.chmod(0o755)
            sandbox = home / '.local/bin/sandbox-exec'
            sandbox.write_text('#!/bin/sh\nprintf provider > "$HOME/provider-called"\n')
            sandbox.chmod(0o755)
            launcher = home / 'launch.sh'
            launcher.write_bytes(REFERENCE.read_bytes())
            subprocess.run(['patch', '-s', str(launcher), str(PATCH)], check=True)
            text = launcher.read_text()
            # Real preflight checks depend on pinned personal files; this stub records
            # their execution and does not invoke auth, token or provider helpers.
            start = text.index('lm_ok(){')
            end = text.index('\nLMC=', start)
            text = text[:start] + 'lm_ok(){ printf preflight >> "$HOME/preflight"; }' + text[end:]
            # Keep the production shell gate and its hash validation. The copied
            # helper substitutes only the kernel read with a synthetic fixture.
            helper = (HERE / 'host_pressure_admission.py').read_text()
            helper = helper.replace('allowed(platform.system(), probe)',
                "allowed('Darwin', lambda _: open(__import__('os').path.expanduser('~/fresh-pressure')).read())")
            fixture_helper = run / 'bin/host_pressure_admission.py'
            fixture_helper.write_text(helper)
            (run / 'bin/host_session_observation.py').write_bytes((HERE / 'host_session_observation.py').read_bytes())
            actual_hash = hashlib.sha256((HERE / 'host_pressure_admission.py').read_bytes()).hexdigest()
            fixture_hash = hashlib.sha256(fixture_helper.read_bytes()).hexdigest()
            self.assertIn(actual_hash, text)
            text = text.replace(actual_hash, fixture_hash)
            launcher.write_text(text)
            # Selection was healthy; the fresh reading may flip before spawn.
            (home / 'selection').write_text('1')
            (home / 'fresh-pressure').write_text(fresh)
            result = subprocess.run(['/bin/bash', str(launcher), 'JOB', 'phantom', lane],
                                    input='fixture', text=True, capture_output=True,
                                    env={'HOME': str(home), 'USER': 'fixture', 'TMPDIR': tmp}, timeout=10)
            for _ in range(100):
                if (home / 'provider-called').exists():
                    break
                time.sleep(.01)
            return result, (home / 'provider-called').exists(), (home / 'preflight').read_text() if (home / 'preflight').exists() else '', (run / 'queue/run/JOB.rc').exists(), (run / 'JOB.prompt').exists()

    def test_fresh_flip_holds_without_launch_and_preserves_early_effects(self):
        for lane in ('codex-cmp', 'codex-personal', 'devin'):
            with self.subTest(lane=lane):
                result, called, preflight, old_rc, prompt = self.launch(lane, '2')
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertIn('HELD:', result.stdout)
                self.assertNotIn('launched ', result.stdout)
                self.assertFalse(called)
                self.assertFalse(old_rc)
                self.assertTrue(prompt)
                self.assertEqual(len(preflight) // len('preflight'), {'codex-cmp': 1, 'codex-personal': 2, 'devin': 0}[lane])

    def test_healthy_recovery_launches_inert_provider(self):
        for lane in ('codex-cmp', 'codex-personal', 'devin'):
            with self.subTest(lane=lane):
                result, called, _, _, _ = self.launch(lane, '1')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('launched JOB ' + lane, result.stdout)
                self.assertTrue(called)


if __name__ == '__main__':
    unittest.main()
