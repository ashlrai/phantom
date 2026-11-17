"""Fixture tests for the action-class registry reader.

Covers the eight classes and their metadata, fail-closed resolution for
unlisted and malformed registries, the job-prefix map, publishable gates,
and the CLI contract the staged publish.sh patch calls. Dispatcher launch
and publish hooks are not installed in this change.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import action_classes  # noqa: E402

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
