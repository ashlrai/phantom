#!/usr/bin/env python3
"""Bounded, explicit control of a small set of macOS GUI applications."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import time

# Paths, aliases and scripts are constants; caller text never enters a command.
APPS = {
    'phantom': ('Phantom', 'Phantom.app'),
    'codex': ('Codex', 'Codex.app'),
    'claude': ('Claude', 'Claude.app'),
    'grok bot': ('Grok Bot', 'Grok Bot.app'),
    'chatgpt': ('ChatGPT', 'ChatGPT.app'),
    'cursor': ('Cursor', 'Cursor.app'),
    'safari': ('Safari', 'Safari.app'),
    'google chrome': ('Google Chrome', 'Google Chrome.app'),
}
ALIASES = {'chrome': 'google chrome', 'grok': 'grok bot'}
BUNDLE_ID = re.compile(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z')
NEEDS_LINE = ('- Enable Automation permission for the calling terminal or agent to control '
              'the requested app in System Settings > Privacy & Security > Automation.')


class ControlError(Exception):
    pass


class MacSystem:
    def resolve(self, filename):
        for root in (Path('/Applications'), Path('/System/Applications'),
                     Path.home() / 'Applications'):
            path = root / filename
            try:
                info = path / 'Contents' / 'Info.plist'
                with info.open('rb') as handle:
                    data = handle.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    continue
                bundle = plistlib.loads(data).get('CFBundleIdentifier')
                if isinstance(bundle, str) and BUNDLE_ID.fullmatch(bundle):
                    return str(path), bundle
            except (OSError, ValueError, TypeError, AttributeError, plistlib.InvalidFileException):
                continue
        return None

    def command(self, argv, timeout=6):
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                                    check=False)
        except subprocess.TimeoutExpired as exc:
            raise ControlError('command_timeout') from exc
        except OSError as exc:
            raise ControlError('system_unavailable') from exc
        if result.returncode:
            error = result.stderr.lower()
            if any(s in error for s in ('-1743', '-1744', '-10004', 'not authorized',
                                        'not permitted', 'permission denied')):
                raise ControlError('permission_denied')
            raise ControlError('request_refused')
        return result.stdout.strip()

    def running(self, bundle):
        output = self.command(['/usr/bin/osascript', '-e',
                               f'application id "{bundle}" is running'])
        if output not in ('true', 'false'):
            raise ControlError('status_unknown')
        return output == 'true'

    def launch(self, path):
        self.command(['/usr/bin/open', '-a', path])

    def focus(self, bundle):
        self.command(['/usr/bin/osascript', '-e',
                      f'tell application id "{bundle}" to activate'])

    def quit(self, bundle):
        self.command(['/usr/bin/osascript', '-e',
                      f'tell application id "{bundle}" to quit'])

    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)


def record_permission(directory):
    """Append one generic, credential-free action line under a caller-supplied directory."""
    fd = None
    try:
        path = Path(directory) / 'NEEDS-MASON.md'
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'r+', encoding='utf-8') as handle:
            fd = None
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                return False
            fcntl.flock(handle, fcntl.LOCK_EX)
            if NEEDS_LINE not in handle.read().splitlines():
                handle.seek(0, os.SEEK_END)
                if handle.tell():
                    handle.seek(handle.tell() - 1)
                    if handle.read(1) != '\n':
                        handle.write('\n')
                handle.write(NEEDS_LINE + '\n')
                handle.flush()
        return True
    except (OSError, UnicodeError, ValueError):
        return False
    finally:
        if fd is not None:
            os.close(fd)


def handle(action, name, automatic, output_dir, system=None):
    """Return a content-free result; injected system supports hermetic tests."""
    key = ' '.join(name.casefold().split())
    key = ALIASES.get(key, key)
    result = {'action': action, 'app': APPS[key][0] if key in APPS else None,
              'ok': False}
    if action not in ('status', 'launch', 'focus', 'quit', 'restart'):
        return dict(result, code='unknown_action')
    if key not in APPS:
        return dict(result, code='unknown_app')
    if automatic and action in ('quit', 'restart'):
        return dict(result, code='automatic_termination_denied')
    system = system or MacSystem()
    try:
        resolved = system.resolve(APPS[key][1])
        if not resolved:
            return dict(result, code='unavailable')
        path, bundle = resolved
        if action == 'status':
            return dict(result, ok=True, code='ok', running=system.running(bundle))
        if action == 'launch':
            system.launch(path)
            return dict(result, ok=True, code='launch_requested')
        running = system.running(bundle)
        if action == 'focus':
            if not running:
                return dict(result, code='not_running')
            system.focus(bundle)
            return dict(result, ok=True, code='focus_requested')
        if running:
            system.quit(bundle)
            deadline = system.monotonic() + 10
            while system.running(bundle):
                remaining = deadline - system.monotonic()
                if remaining <= 0:
                    return dict(result, code='quit_timeout')
                system.sleep(min(0.2, remaining))
        if action == 'restart':
            system.launch(path)
            return dict(result, ok=True, code='restart_launch_requested')
        return dict(result, ok=True, code='stopped' if running else 'already_stopped')
    except ControlError as exc:
        code = str(exc)
        if code == 'permission_denied':
            return dict(result, code=code, needs_mason_written=record_permission(output_dir))
        return dict(result, code=code)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('status', 'launch', 'focus', 'quit', 'restart'))
    parser.add_argument('app')
    parser.add_argument('--automatic', action='store_true')
    parser.add_argument('--output-dir', required=True,
                        help='existing directory for a permission action request')
    args = parser.parse_args(argv)
    result = handle(args.action, args.app, args.automatic, args.output_dir)
    print(json.dumps(result))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
