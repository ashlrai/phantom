"""Command-handler regression tests; no real GUI applications are accessed."""

import contextlib
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest import mock

import app_control as control


class FakeSystem:
    def __init__(self, states=(True, False)):
        self.states = list(states)
        self.last = self.states[-1]
        self.events = []
        self.now = 0
        self.error = None
        self.available = True

    def resolve(self, filename):
        self.events.append(('resolve', filename))
        return ('/known/Application.app', 'org.example.App') if self.available else None

    def running(self, bundle):
        self.events.append(('running', bundle))
        if self.error:
            raise control.ControlError(self.error)
        if self.states:
            self.last = self.states.pop(0)
        return self.last

    def quit(self, bundle):
        self.events.append(('quit', bundle))

    def launch(self, path):
        self.events.append(('launch', path))

    def focus(self, bundle):
        self.events.append(('focus', bundle))

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.system = FakeSystem()

    def call(self, action, app='Safari', automatic=False):
        return control.handle(action, app, automatic, self.temp.name, self.system)

    def test_all_allowlisted_and_aliases_deny_automatic_termination(self):
        for app in [*control.APPS, 'CHROME', '  GrOk   BoT ', 'grok']:
            for action in ('quit', 'restart'):
                with self.subTest(app=app, action=action):
                    self.assertEqual(self.call(action, app, True)['code'],
                                     'automatic_termination_denied')
        self.assertEqual(self.system.events, [])

    def test_unknown_and_injected_names_never_reach_system(self):
        for app in ('Docker', 'Safari; touch /tmp/x', '" & quit & "', '../Safari', ''):
            with self.subTest(app=app):
                result = self.call('launch', app)
                self.assertEqual(result['code'], 'unknown_app')
                self.assertIsNone(result['app'])
        self.assertEqual(self.system.events, [])

    def test_explicit_restart_waits_for_confirmed_disappearance(self):
        self.system.states = [True, True, False]
        self.assertEqual(self.call('restart')['code'], 'restart_launch_requested')
        self.assertEqual([event[0] for event in self.system.events],
                         ['resolve', 'running', 'quit', 'running', 'running', 'launch'])

    def test_quit_timeout_never_launches_or_forces(self):
        self.system = FakeSystem((True,))
        self.assertEqual(self.call('restart')['code'], 'quit_timeout')
        self.assertEqual(sum(e[0] == 'quit' for e in self.system.events), 1)
        self.assertNotIn('launch', [e[0] for e in self.system.events])
        self.assertLessEqual(self.system.now, 10.01)

    def test_unavailable_and_stopped_focus_do_not_launch(self):
        self.system.available = False
        self.assertEqual(self.call('restart')['code'], 'unavailable')
        self.system = FakeSystem((False,))
        self.assertEqual(self.call('focus')['code'], 'not_running')
        self.assertNotIn('launch', [e[0] for e in self.system.events])

    def test_permission_denial_deduplicates_generic_action(self):
        self.system.error = 'permission_denied'
        for _ in range(2):
            result = self.call('restart')
            self.assertEqual(result['code'], 'permission_denied')
            self.assertTrue(result['needs_mason_written'])
        self.assertEqual((Path(self.temp.name) / 'NEEDS-MASON.md').read_text().splitlines(),
                         [control.NEEDS_LINE])
        self.assertFalse(any(e[0] in ('quit', 'launch') for e in self.system.events))

    def test_refusal_and_unknown_status_never_restart(self):
        for code in ('request_refused', 'command_timeout', 'status_unknown'):
            self.system = FakeSystem()
            self.system.quit = mock.Mock(side_effect=control.ControlError(code))
            self.assertEqual(self.call('restart')['code'], code)
            self.assertNotIn('launch', [e[0] for e in self.system.events])

    def test_permission_denial_during_quit_and_unwritable_request(self):
        self.system.quit = mock.Mock(side_effect=control.ControlError('permission_denied'))
        result = control.handle('restart', 'Safari', False,
                                str(Path(self.temp.name) / 'missing'), self.system)
        self.assertEqual(result['code'], 'permission_denied')
        self.assertFalse(result['needs_mason_written'])
        self.assertNotIn('launch', [e[0] for e in self.system.events])

    def test_command_handler_prints_structured_status_and_failure(self):
        for app, expected, exit_code in [('sAfArI', 'ok', 0), ('Docker', 'unknown_app', 1)]:
            with self.subTest(app=app), mock.patch.object(control, 'MacSystem', return_value=self.system):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    rc = control.main(['status', app, '--output-dir', self.temp.name])
                self.assertEqual(rc, exit_code)
                self.assertEqual(json.loads(output.getvalue())['code'], expected)

    def test_launch_status_and_quit(self):
        self.assertEqual(self.call('launch', 'chrome')['code'], 'launch_requested')
        self.assertTrue(self.call('status')['running'])
        self.assertEqual(self.call('quit')['code'], 'already_stopped')


class SystemTests(unittest.TestCase):
    def test_fixed_paths_and_bounded_plist_resolution(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = plistlib.dumps({'CFBundleIdentifier': 'com.apple.Safari'})
            with mock.patch.object(control.Path, 'home', return_value=root):
                with mock.patch.object(control.Path, 'open', autospec=True) as opened:
                    # Only the explicitly supplied app path is examined.
                    opened.side_effect = [OSError(), OSError(), io.BytesIO(data)]
                    self.assertEqual(control.MacSystem().resolve('Safari.app')[1],
                                     'com.apple.Safari')

    @mock.patch('app_control.subprocess.run')
    def test_system_calls_use_argv_and_redact_errors(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, 'true\n', '')
        system = control.MacSystem()
        self.assertTrue(system.running('com.apple.Safari'))
        system.focus('com.apple.Safari')
        system.quit('com.apple.Safari')
        system.launch('/Applications/Safari.app')
        for call in run.call_args_list:
            self.assertIsInstance(call.args[0], list)
            self.assertNotIn('shell', call.kwargs)
            self.assertEqual(call.kwargs['timeout'], 6)
        run.return_value = subprocess.CompletedProcess([], 1, '', 'secret -1743')
        with self.assertRaisesRegex(control.ControlError, '^permission_denied$'):
            system.quit('com.apple.Safari')

    @mock.patch('app_control.subprocess.run', side_effect=subprocess.TimeoutExpired('osascript', 6))
    def test_osascript_timeout_is_safe_error(self, _run):
        with self.assertRaisesRegex(control.ControlError, '^command_timeout$'):
            control.MacSystem().quit('com.apple.Safari')


if __name__ == '__main__':
    unittest.main()
