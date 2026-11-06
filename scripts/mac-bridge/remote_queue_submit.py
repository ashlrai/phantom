#!/usr/bin/env python3
"""Submit one validated Phantom drop through a trusted stdio transport.

The named drop is read with host_queue_ingress.snapshot (stable nonsymlink
identity, filename and header grammar) and sent as an opaque base64 enqueue
request on the transport's stdin — never in argv. --coordinator-argv names a
bounded JSON file holding one nonempty literal argv array, such as an ssh line
ending in host_queue_stdio.py --db PATH; this host never touches coordinator
SQLite. No socket, SSH configuration, scan, or retry is added. Preview (the
default) validates inputs without spawning; --apply runs one bounded
round-trip. Enqueue success reports submitted; 'job already exists' reports
existing-unverified with a nonzero exit — the server never exposes payload
equality, so an ambiguous identity is never silently accepted. The source drop
is never renamed or deleted. Output is fixed metadata only.
"""

import argparse
import base64
import json
import os
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time

import host_queue_ingress as ingress
import host_queue_stdio

TOOL = 'remote_queue_submit'
MAX_ARGV_FILE = 4096   # --coordinator-argv JSON file bound
MAX_ARGV_ITEMS = 32    # argv element count bound
MAX_ARGV_ITEM = 512    # per-element length bound
CONFLICT = 2           # exit status for existing-unverified


class SubmitError(Exception):
    """Fixed-message failure; never carries job bytes, argv, or server text."""


def load_argv(path):
    """Nonempty literal argv array from a bounded nonsymlink regular file."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SubmitError('invalid coordinator argv')
        with os.fdopen(fd, 'rb') as handle:
            raw = handle.read(MAX_ARGV_FILE + 1)
        spec = json.loads(raw)
    except (OSError, ValueError, RecursionError):
        raise SubmitError('invalid coordinator argv')
    valid = len(raw) <= MAX_ARGV_FILE and isinstance(spec, list) \
        and 1 <= len(spec) <= MAX_ARGV_ITEMS \
        and all(type(item) is str and 1 <= len(item) <= MAX_ARGV_ITEM
                and '\x00' not in item for item in spec)
    if not valid:
        raise SubmitError('invalid coordinator argv')
    return spec


def kill_group(proc):
    """SIGKILL the transport's whole group, then confirm it drained."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    for _ in range(100):  # bounded settle: about two seconds
        try:
            os.killpg(proc.pid, 0)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.02)


def pump(proc, request, deadline):
    """Bounded full-duplex exchange: returns (reply, oversized, timed_out)."""
    sel = selectors.DefaultSelector()
    for stream, events, tag in ((proc.stdin, selectors.EVENT_WRITE, 'in'),
                                (proc.stdout, selectors.EVENT_READ, 'out'),
                                (proc.stderr, selectors.EVENT_READ, 'err')):
        os.set_blocking(stream.fileno(), False)
        sel.register(stream, events, tag)
    view, sent = memoryview(request), 0
    reply = bytearray()
    try:
        while sel.get_map():
            left = deadline - time.monotonic()
            if left <= 0:
                return bytes(reply), False, True
            for key, _mask in sel.select(min(left, 0.25)):
                try:
                    if key.data == 'in':
                        sent += os.write(key.fd, view[sent:sent + 65536])
                        if sent >= len(view):
                            sel.unregister(key.fileobj)
                            key.fileobj.close()  # stdin EOF completes the request
                    else:
                        chunk = os.read(key.fd, 32768)
                        if not chunk:
                            sel.unregister(key.fileobj)
                            continue
                        if key.data == 'err':
                            continue  # stderr is drained and discarded, never logged
                        room = host_queue_stdio.MAX_RESPONSE + 1 - len(reply)
                        reply += chunk[:max(room, 0)]
                        if len(chunk) > room:
                            return bytes(reply), True, False
                except BlockingIOError:
                    continue
                except OSError:  # broken stdin pipe or a raced close
                    try:
                        sel.unregister(key.fileobj)
                        key.fileobj.close()
                    except (KeyError, OSError, ValueError):
                        pass
        return bytes(reply), False, False
    finally:
        sel.close()


def exchange(argv, request, timeout):
    """One bounded stdio round-trip; returns the parsed reply object."""
    deadline = time.monotonic() + timeout
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, start_new_session=True)
    except (OSError, ValueError):
        raise SubmitError('transport failed to start')
    try:
        reply, oversized, timed_out = pump(proc, request, deadline)
        if not timed_out and not oversized:
            try:
                proc.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                stream.close()
            except OSError:
                pass
        if oversized or timed_out:
            kill_group(proc)
            raise SubmitError('response exceeds limit' if oversized
                              else 'request timed out')
        try:
            parsed = json.loads(reply)
        except (ValueError, RecursionError):
            parsed = None
        if not isinstance(parsed, dict) or type(parsed.get('ok')) is not bool:
            raise SubmitError('invalid response' if proc.returncode == 0
                              else 'transport or coordinator failed')
        if parsed['ok'] and proc.returncode != 0:
            raise SubmitError('transport or coordinator failed')
        return parsed
    except KeyboardInterrupt:
        kill_group(proc)
        raise
    except (OSError, ValueError):
        kill_group(proc)
        raise SubmitError('transport failed')


def run(args):
    """(result, exit_code); raises SubmitError with fixed text on failure."""
    if not ingress.JOB_FILE.fullmatch(args.job + '.md'):
        raise SubmitError('invalid job name')
    program = load_argv(args.coordinator_argv)
    try:
        directory = os.open(args.drop_dir,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise SubmitError('invalid drop directory')
    try:
        data = ingress.snapshot(directory, args.job + '.md')
    finally:
        os.close(directory)
    if data is None:
        raise SubmitError('invalid or unstable drop')
    fixed = {'tool': TOOL, 'apply': args.apply, 'job': args.job}
    if not args.apply:
        return {'ok': True, **fixed, 'result': 'preview', 'bytes': len(data)}, 0
    request = json.dumps({'action': 'enqueue', 'job': args.job,
                          'payload_base64': base64.b64encode(data).decode('ascii')},
                         separators=(',', ':')).encode()
    if len(request) > host_queue_stdio.MAX_REQUEST:  # unreachable; kept as a guard
        raise SubmitError('request exceeds limit')
    reply = exchange(program, request, args.request_timeout)
    if reply['ok'] is True:
        return {'ok': True, **fixed, 'result': 'submitted', 'bytes': len(data)}, 0
    if reply.get('error') == 'job already exists':
        return {'ok': False, **fixed, 'result': 'existing-unverified'}, CONFLICT
    raise SubmitError('request rejected')


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, epilog=(
        'Example argv file: ["ssh","coord","python3","/opt/phantom/scripts/'
        'mac-bridge/host_queue_stdio.py","--db","/var/local/phantom/'
        'queue.sqlite"]. The request JSON travels on stdin only.'))
    parser.add_argument('--drop-dir', required=True, help='directory holding the drop file')
    parser.add_argument('--job', required=True, help='RQ-PHX job name, no .md extension')
    parser.add_argument('--coordinator-argv', required=True,
                        help='bounded JSON file: one nonempty literal argv array')
    parser.add_argument('--request-timeout', type=ingress.bounded(3600), default=30,
                        help='transport round-trip seconds (1-3600)')
    parser.add_argument('--apply', action='store_true',
                        help='perform the submit; default preview spawns nothing')
    return parser.parse_args(argv)


def main(argv=None, out=None):
    args = parse_args(argv)
    out = out or sys.stdout

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    previous = None
    if threading.current_thread() is threading.main_thread():  # signals: main only
        previous = signal.signal(signal.SIGTERM, interrupted)
    try:
        try:
            result, status = run(args)
        except KeyboardInterrupt:
            result, status = {'error': 'interrupted'}, 1
        except SubmitError as exc:
            result, status = {'error': str(exc)}, 1
        except (OSError, ValueError, OverflowError):
            result, status = {'error': 'submit failed'}, 1
        result = {'tool': TOOL, 'ok': status == 0, 'apply': args.apply,
                  'job': args.job, **result}
        print(json.dumps(result, separators=(',', ':')), file=out, flush=True)
        return status
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)


if __name__ == '__main__':
    sys.exit(main())
