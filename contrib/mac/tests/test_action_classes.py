"""Fixture tests for RQ-SWE5-ACTION-CLASSES: the unified action-class autonomy
registry reader (contrib/mac/action_classes.py + action-classes.json) and the
gates dispatchd.py derives from it.

Module cases run against the repo copy of the registry; dispatcher cases use the
same harness as test_dispatchd.py (synthetic ~/.ashlr-runs in a temp HOME, one
tick per subprocess) and steer the registry through ACTION_CLASSES_JSON. Covers:
the eight classes and their metadata, fail-closed resolution for unlisted and
malformed registries, the job-prefix map, publishable gates, launch refusal,
publish refusal, and the CLI contract publish.sh relies on.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import action_classes  # noqa: E402

from test_dispatchd import (AP_GREEN, build, devin_slot, events, held_lanes,  # noqa: E402
                            lane_slot, queue_job, ready_lines, tick, launch_stubs)

REGISTRY_JSON = Path(action_classes.__file__).resolve().parent / 'action-classes.json'
REG = action_classes.load()
HELPER = Path(__file__).resolve().parents[1] / 'action_classes.py'


def registry_with(**mutations):
    """A copy of the checked-in registry with per-class or top-level mutations."""
    reg = json.loads(REGISTRY_JSON.read_text())
    classes = mutations.pop('classes', {})
    for name, patch in classes.items():
        if patch is None:
            reg['classes'].pop(name, None)
        else:
            reg['classes'].setdefault(name, {}).update(patch)
    for key, value in mutations.items():
        reg[key] = value
    return reg


class tempfile_for:
    """Write a registry object to a temp file and yield its path."""
    def __init__(self, reg):
        self._f = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
        json.dump(reg, self._f)
        self._f.close()
        self.path = self._f.name

    def __enter__(self):
        return self.path

    def __exit__(self, *exc):
        os.unlink(self.path)


def write_registry(home, reg):
    path = Path(home) / 'action-classes-override.json'
    if reg is not None:
        path.write_text(json.dumps(reg))
    return {'ACTION_CLASSES_JSON': str(path)}


class RegistryTests(unittest.TestCase):
    def test_checked_in_registry_lists_all_eight_classes_with_metadata(self):
        self.assertIsNotNone(REG)
        self.assertEqual(sorted(REG['classes']), [
            'close', 'external-comms', 'merge', 'publish', 'read', 'release',
            'secrets-touch', 'write-worktree'])
        for name, entry in REG['classes'].items():
            self.assertIn(entry['gate'], action_classes.GATES)
            self.assertIn(entry['blastRadius'], action_classes.BLAST_RADII)
            self.assertIn(entry['reversibility'], action_classes.REVERSIBILITIES)
            self.assertTrue(entry['summary'])

    def test_resolve_fails_closed_for_unlisted_names(self):
        for name in ('', 'read ', 'Read', 'publishh', 'unlisted', 'secrets-touc'):
            entry = action_classes.resolve(REG, name)
            self.assertIs(entry['listed'], False, name)
            self.assertEqual(entry['gate'], 'forbidden')
            self.assertEqual(entry['blastRadius'], 'unknown')
            self.assertEqual(entry['reversibility'], 'irreversible')
            self.assertEqual(action_classes.disposition(REG, name), 'forbidden')
            self.assertFalse(action_classes.may_run(REG, name))
            self.assertFalse(action_classes.may_publish(REG, name))

    def test_disposition_maps_gates_to_allowed_operator_forbidden(self):
        self.assertEqual(action_classes.disposition(REG, 'secrets-touch'), 'forbidden')
        self.assertEqual(action_classes.disposition(REG, 'publish'), 'allowed')
        reg = registry_with(classes={'publish': {'gate': 'operator'}})
        self.assertEqual(action_classes.disposition(reg, 'publish'), 'operator')
        self.assertFalse(action_classes.may_run(reg, 'publish'))

    def test_job_classification_prefixes_then_default(self):
        self.assertEqual(action_classes.classify_job(REG, 'RQ-DRAIN-phantom-1-x'), 'merge')
        self.assertEqual(action_classes.classify_job(REG, 'RQ-DESK-A'), 'merge')
        self.assertEqual(action_classes.classify_job(REG, 'RQ-CLOSE-123'), 'close')
        self.assertEqual(action_classes.classify_job(REG, 'CLOSE-9'), 'close')
        self.assertEqual(action_classes.classify_job(REG, 'RQ-ANYTHING-ELSE'), 'publish')
        self.assertEqual(action_classes.classify_job(REG, 'RQ-BATCH-x'), 'publish')
        self.assertEqual(action_classes.classify_job(None, 'RQ-OTHER'), 'unlisted')

    def test_publishable_gates_cover_publish_merge_close_only(self):
        for name in ('publish', 'merge', 'close'):
            self.assertTrue(action_classes.may_publish(REG, name), name)
        for name in ('read', 'write-worktree', 'release', 'external-comms', 'secrets-touch'):
            self.assertFalse(action_classes.may_publish(REG, name), name)

    def test_malformed_registries_load_as_none(self):
        bad = [None, [], 'x', {'schema': 'nope'},
               registry_with(schema='action-classes.v2'),
               registry_with(classes={'publish': {'gate': 'bogus'}}),
               registry_with(classes={'publish': {'blastRadius': 'wide'}}),
               registry_with(classes={'publish': {'reversibility': 'maybe'}}),
               registry_with(classes={'publish': {'summary': 7}}),
               registry_with(jobClassMap={'prefixes': [], 'default': 'nope'}),
               registry_with(jobClassMap={'prefixes': [['X-', 'nope']], 'default': 'publish'}),
               registry_with(publishableGates=['bogus']),
               registry_with(publishableGates=[])]
        for i, reg in enumerate(bad):
            with self.subTest(i=i):
                with tempfile_for(reg) as path:
                    self.assertIsNone(action_classes.load(path))
        self.assertIsNone(action_classes.load('/nonexistent/action-classes.json'))

    def test_unloaded_registry_denies_everything(self):
        self.assertFalse(action_classes.may_run(None, 'read'))
        self.assertFalse(action_classes.may_publish(None, 'publish'))
        entry = action_classes.resolve(None, 'publish')
        self.assertIs(entry['listed'], False)


class CliTests(unittest.TestCase):
    def cli(self, *args):
        return subprocess.run([sys.executable, '-B', str(HELPER), *args],
                              capture_output=True, text=True, timeout=30)

    def test_list_and_resolve(self):
        r = self.cli('list', '--json')
        self.assertEqual(r.returncode, 0)
        self.assertEqual(len(json.loads(r.stdout)['classes']), 8)
        r = self.cli('resolve', 'publish', '--json')
        self.assertEqual(r.returncode, 0)
        self.assertEqual(json.loads(r.stdout)['gate'], 'publish-pipeline')
        r = self.cli('resolve', 'nope')
        self.assertEqual(r.returncode, 2)

    def test_check_contract_for_publish_sh(self):
        r = self.cli('check', 'publish')
        self.assertEqual((r.returncode, r.stdout.strip()), (0, 'gate=publish-pipeline'))
        self.assertEqual(self.cli('check', 'merge').returncode, 0)
        self.assertEqual(self.cli('check', 'close').returncode, 0)
        self.assertEqual(self.cli('check', 'release').returncode, 2)
        self.assertEqual(self.cli('check', 'secrets-touch').returncode, 2)
        self.assertEqual(self.cli('check', 'unlisted').returncode, 3)

    def test_check_fails_closed_when_registry_unreadable(self):
        r = subprocess.run([sys.executable, '-B', str(HELPER), '--registry', '/nonexistent.json', 'check', 'publish'],
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 4)
        r = subprocess.run([sys.executable, '-B', str(HELPER), 'check', 'publish'],
                           env={**os.environ, 'ACTION_CLASSES_JSON': '/nonexistent.json'},
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 4)

    def test_classify_command_reports_job_class(self):
        r = self.cli('classify', 'RQ-DRAIN-phantom-9-x', '--json')
        self.assertEqual(r.returncode, 0)
        body = json.loads(r.stdout)
        self.assertEqual(body['class'], 'merge')


class DispatchActionClassTests(unittest.TestCase):
    """One tick per case; ACTION_CLASSES_JSON steers the loaded registry."""

    def fixture(self, env_extra=None):
        slots = held_lanes()
        slots['codex-cmp'] = lane_slot(target=10)
        slots['devin'] = devin_slot(target=10, last_change=int(1e15))
        tmp = build(slots=slots)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        env = launch_stubs(home)
        if env_extra:
            env.update(env_extra)
        return home, env

    def run_tick(self, home, env):
        result = tick(home, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def claims(self, home):
        rows = (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()
        return [row['job'] for row in map(json.loads, rows) if row['event'] == 'claim']

    def test_valid_registry_launches_and_labels_the_metric(self):
        home, env = self.fixture()
        queue_job(home, 'RQ-AC-OK', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-AC-OK'])
        rows = [json.loads(line) for line in
                (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
        launches = [r for r in rows if r.get('event') == 'launch' and r.get('job') == 'RQ-AC-OK']
        self.assertEqual(launches[0]['action_class'], 'publish')
        status = json.loads((home / '.ashlr-runs/queue/status.json').read_text())
        self.assertEqual(status['action_classes']['loaded'], True)
        self.assertEqual(status['action_classes']['schema'], 'action-classes.v1')

    def test_missing_registry_fails_closed_on_launch_and_publish(self):
        home, env = self.fixture({'ACTION_CLASSES_JSON': '/nonexistent/action-classes.json'})
        queue_job(home, 'RQ-AC-DENIED', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), [])
        self.assertIn('ACTION_CLASS_DENIED RQ-AC-DENIED', events(home))
        self.assertIn('RQ-AC-DENIED', [line.split('\t')[0] for line in ready_lines(home)])
        self.assertTrue((home / '.ashlr-runs/queue/run/RQ-AC-DENIED.acdenied').exists())
        status = json.loads((home / '.ashlr-runs/queue/status.json').read_text())
        self.assertEqual(status['action_classes']['loaded'], False)

    def test_write_worktree_forbidden_refuses_launch(self):
        env_extra = write_registry(
            self._dir(), registry_with(classes={'write-worktree': {'gate': 'forbidden'}}))
        home, env = self.fixture(env_extra)
        queue_job(home, 'RQ-AC-NEVER', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), [])
        self.assertIn('ACTION_CLASS_DENIED RQ-AC-NEVER launch refused (class=publish gate=publish-pipeline)',
                      events(home))

    def test_job_classified_secrets_touch_is_never_launched(self):
        reg = registry_with()
        reg['jobClassMap']['prefixes'].insert(0, ['RQ-SECRETS-', 'secrets-touch'])
        env_extra = write_registry(self._dir(), reg)
        home, env = self.fixture(env_extra)
        queue_job(home, 'RQ-SECRETS-1', 'codex-cmp')
        queue_job(home, 'RQ-AC-NORMAL', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-AC-NORMAL'])
        self.assertIn('ACTION_CLASS_DENIED RQ-SECRETS-1 launch refused (class=secrets-touch gate=forbidden)',
                      events(home))

    def _dir(self):
        if not hasattr(self, '_tmp_home'):
            self._tmp_home = tempfile.TemporaryDirectory()
            self.addCleanup(self._tmp_home.cleanup)
        return Path(self._tmp_home.name)

    # --- publish side -------------------------------------------------------

    def finished_worktree(self, home, job):
        queue_job(home, job, 'codex-cmp')
        r = home / '.ashlr-runs'
        q = r / 'queue'
        ready = ready_lines(home)
        (q / 'run' / f'{job}.line').write_text(ready[-1] + '\n')
        (q / 'ready.tsv').write_text('\n'.join(ready[:-1]) + ('\n' if ready[:-1] else ''))
        wt = home / 'Projects/ashlrai/wt' / job
        wt.mkdir()
        for path, content in [(r / f'{job}.base', f'deadbeef phantom {wt} codex-cmp\n'),
                              (r / f'{job}.log', 'fixture finished\n')]:
            path.write_text(content)
            old = time.time() - 600
            os.utime(path, (old, old))
        (q / 'run' / f'{job}.rc').write_text('0\n')

    def publish_stubs(self, home):
        r = home / '.ashlr-runs'
        (r / 'phantom-open-prs').write_text(f'{int(time.time())} 0\n')
        git = home / 'stubbin/git'
        git.write_text('#!/bin/sh\nexit 0\n')
        git.chmod(0o755)
        reap = r / 'bin/reap-one.sh'
        reap.write_text('#!/bin/sh\n'
                        'r="$HOME/.ashlr-runs"\n'
                        'printf "%s\\n" "$1" >> "$r/publish-order"\n'
                        'printf "RESULT PR https://example.invalid/%s\\n" "$1" > "$r/$1.publish"\n'
                        'rm "$r/$1.base"\n'
                        'rmdir "$r/queue/run/$1.reaping"\n')
        reap.chmod(0o755)

    def test_publish_allowed_for_publish_and_merge_jobs(self):
        home, env = self.fixture()
        self.publish_stubs(home)
        self.finished_worktree(home, 'RQ-AC-PUB')
        self.finished_worktree(home, 'RQ-DRAIN-phantom-1-x')
        out = self.run_tick(home, env).stdout + self.run_tick(home, env).stdout
        self.assertIn('REAP RQ-DRAIN-phantom-1-x ', out)   # merge class -> merge-queue gate is publishable
        self.assertIn('REAP RQ-AC-PUB ', out)             # publish class -> publish-pipeline gate

    def test_publish_held_when_class_gate_is_not_publishable(self):
        # publish ends in release-channel: allowed to run, never publishable by the generic path.
        env_extra = write_registry(
            self._dir(), registry_with(classes={'publish': {'gate': 'release-channel'}}))
        home, env = self.fixture(env_extra)
        self.publish_stubs(home)
        self.finished_worktree(home, 'RQ-AC-HELD')
        result = self.run_tick(home, env)
        self.assertNotIn('REAP RQ-AC-HELD', result.stdout)
        self.assertIn('ACTION_CLASS_HELD RQ-AC-HELD class=publish gate=release-channel', events(home))
        self.assertFalse((home / '.ashlr-runs/publish-order').exists())
        self.assertTrue((home / '.ashlr-runs/queue/run/RQ-AC-HELD.acdenied').exists())
        # A second tick logs no duplicate event.
        self.run_tick(home, env)
        self.assertEqual(events(home).count('ACTION_CLASS_HELD RQ-AC-HELD'), 1)


if __name__ == '__main__':
    unittest.main()
