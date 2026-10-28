#!/usr/bin/env python3
"""Local Mac bridge coordination. No providers, credentials, or third-party modules."""
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
RUNS = Path(os.environ.get('BRIDGE_RUNS_DIR', str(Path.home() / '.ashlr-runs'))).resolve()
PROJECTS = Path(os.environ.get('BRIDGE_PROJECTS_DIR', str(Path.home() / 'Projects/ashlrai'))).resolve()


class Refusal(Exception):
    pass


def identifier(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', value):
        raise Refusal('invalid-identifier')
    return value


def atomic_json(path, data):
    temp = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    temp.write_text(json.dumps(data) + '\n')
    os.replace(temp, path)


def station(job, name, started_ms, outcome):
    RUNS.mkdir(parents=True, exist_ok=True, mode=0o700)
    record = {'schema': 'queue.v1', 'job': job, 'station': name,
              'duration_ms': max(0, round(time.time() * 1000 - float(started_ms))),
              'outcome': outcome, 'timestamp': time.time(),
              'run_id': os.environ.get('BRIDGE_RUN_ID', '')}
    # One append syscall; separate writers cannot interleave a record.
    fd = os.open(RUNS / 'queue.v1.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (json.dumps(record, separators=(',', ':')) + '\n').encode())
    finally:
        os.close(fd)


def now_ms():
    return time.time() * 1000


def process_start(pid):
    try:
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='],
                                capture_output=True, text=True, check=False)
        return result.stdout.strip()
    except OSError:
        return ''  # Restricted hosts cannot inspect starts; PID liveness still blocks.


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, ValueError, TypeError):
        return True  # Unknown ownership never authorizes reclamation.



def check_claim(worktree):
    """An agent may close inherited FDs; its live PID still owns this worktree.

    Read only while holding the worktree flock, before replacing any claim.
    Missing claims support pre-launch/publish; malformed claims require review.
    """
    canonical = str(Path(worktree).resolve())
    path = RUNS / (Path(canonical).name + '.claim')
    try:
        claim = json.loads(path.read_text())
    except FileNotFoundError:
        return
    except (OSError, ValueError):
        raise Refusal('invalid-claim-metadata') from None
    try:
        pid, created, start, target = (claim['pid'], claim['created_at'],
                                       claim['process_start'], claim['worktree'])
        if (type(pid) is not int or pid <= 0 or
                type(created) not in (int, float) or not math.isfinite(created) or
                not isinstance(start, str) or not isinstance(target, str) or
                not Path(target).is_absolute()):
            raise ValueError
        if str(Path(target).resolve()) != canonical:
            raise Refusal('claim-worktree-mismatch')
    except (KeyError, TypeError, ValueError, OSError):
        raise Refusal('invalid-claim-metadata') from None
    if alive(pid):
        current_start = process_start(pid)
        if not start or not current_start or current_start == start:
            raise Refusal('live-claim')
    if time.time() - created < 1:
        raise Refusal('recent-stale-claim')


def lock_path(key):
    locks = RUNS / 'locks'
    locks.mkdir(parents=True, exist_ok=True, mode=0o700)
    return locks / (hashlib.sha256(key.encode()).hexdigest() + '.lock')


@contextlib.contextmanager
def locked(key, timeout=0, worktree=None):
    """Never unlink lock files: flock releases on last holder exit, even SIGKILL.

    The persistent inode avoids mkdir/unlink stale-reaper races. PID and age
    metadata is a second fail-closed guard, not permission to evict a live lock.
    Children inherit this descriptor so supervisor death cannot free their claim.
    """
    fd = os.open(lock_path(key), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Refusal('live-claim' if worktree else 'lock-timeout')
                time.sleep(0.025)
        if worktree:
            check_claim(worktree)
        data = os.read(fd, 8192)
        if data:
            try:
                old = json.loads(data)
                pid = old['pid']
                created = old['created_at']
                if (type(pid) is not int or pid <= 0 or
                        type(created) not in (int, float) or not math.isfinite(created) or
                        type(old['active']) is not bool or
                        not isinstance(old['process_start'], str) or
                        old['worktree'] != worktree):
                    raise ValueError
                age = time.time() - created
                if old['active']:
                    # PID reuse is distinguished by the process start identity.
                    if alive(pid):
                        start = process_start(pid)
                        if not start or not old['process_start'] or start == old['process_start']:
                            raise Refusal('live-claim')
                    if age < 1:
                        raise Refusal('recent-stale-claim')
            except (KeyError, ValueError, TypeError):
                raise Refusal('invalid-lock-metadata') from None
        owner = {'pid': os.getpid(), 'process_start': process_start(os.getpid()),
                 'created_at': time.time(), 'worktree': worktree, 'active': True}
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        os.write(fd, json.dumps(owner).encode())
        os.set_inheritable(fd, True)
        yield fd
        owner['active'] = False
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        os.write(fd, json.dumps(owner).encode())
    finally:
        # close, never LOCK_UN: a still-running child may own the same lease.
        os.close(fd)


def git(repo, *args, capture=True, timeout=None):
    return subprocess.run(['git', '-C', str(repo), *args], check=True,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, text=True, timeout=timeout).stdout


def fetched_base(repo, run_id, job):
    common = str(Path(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').strip()).resolve())
    cache = RUNS / 'fetch'
    cache.mkdir(exist_ok=True, mode=0o700)
    stamp = cache / (hashlib.sha256((common + '\0' + run_id).encode()).hexdigest() + '.json')
    started = now_ms()
    with locked('fetch:' + common, timeout=25) as fd:
        if not stamp.exists():
            try:
                # Retain the lock in Git if this supervisor is killed mid-fetch.
                subprocess.run(['git', '-C', str(repo), 'fetch', '-q', 'origin'],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=20, pass_fds=(fd,))
                default = subprocess.run(['git', '-C', str(repo), 'symbolic-ref', '-q', '--short',
                                          'refs/remotes/origin/HEAD'], capture_output=True, text=True)
                ref = default.stdout.strip() or 'origin/main'
                base = git(repo, 'rev-parse', '--verify', ref + '^{commit}').strip()
                atomic_json(stamp, {'base': base, 'ok': True})
            except (subprocess.SubprocessError, OSError):
                atomic_json(stamp, {'ok': False})
        record = json.loads(stamp.read_text())
    station(job, 'fetch', started, 'ready' if record['ok'] else 'failed')
    if not record['ok']:
        raise Refusal('fetch-failed-for-run')
    return common, record['base']


def prepare(job, repo_name, pool, tier, prompt, lease_fd):
    repo = PROJECTS / repo_name
    wt = PROJECTS / 'wt' / job
    branch = 'codex-bridge/' + job
    base_file = RUNS / (job + '.base')
    run_id = identifier(os.environ.get('BRIDGE_RUN_ID', ''))
    if any(c.isspace() for c in str(wt)):
        raise Refusal('legacy-base-path-whitespace')
    hold = RUNS / 'HOLD'
    if hold.exists() and pool in hold.read_text().splitlines():
        raise Refusal('pool-held')
    if (wt / '.git').exists():
        source_common = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').strip()
        target_common = git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir').strip()
        if Path(source_common).resolve() != Path(target_common).resolve():
            raise Refusal('worktree-repository-mismatch')
        if not base_file.exists() or not (RUNS / (job + '.prepared')).exists():
            raise Refusal('unowned-or-incomplete-worktree')
        fields = base_file.read_text().split()
        if len(fields) != 4 or fields[1:] != [branch, str(wt), pool]:
            raise Refusal('worktree-metadata-mismatch')
        base = fields[0]
        if git(wt, 'symbolic-ref', '--short', 'HEAD').strip() != branch:
            raise Refusal('worktree-branch-mismatch')
        git(wt, 'merge-base', '--is-ancestor', base, 'HEAD')
    else:
        common, base = fetched_base(repo, run_id, job)
        if os.environ.get('BASE_OVERRIDE'):
            base = git(repo, 'rev-parse', '--verify', os.environ['BASE_OVERRIDE'] + '^{commit}').strip()
        wt.parent.mkdir(parents=True, exist_ok=True)
        started = now_ms()
        # Registration only is serialized; checkout and dependency preparation fan out.
        with locked('worktree-add:' + common, timeout=25) as add_fd:
            subprocess.run(['git', '-C', str(repo), 'worktree', 'add', '--no-checkout', '-q',
                            '-b', branch, str(wt), base], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           pass_fds=(add_fd, lease_fd))
        base_file.write_text(f'{base} {branch} {wt} {pool}\n')
        subprocess.run(['git', '-C', str(wt), 'reset', '--hard', '-q', base], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=(lease_fd,))
        (RUNS / (job + '.prepared')).touch()
        station(job, 'worktree', started, 'ready')
    tracked = git(wt, 'ls-files', '-v', '-z').split('\0')
    sparse = [item[2:] for item in tracked if item.startswith('S ') or item[:1].islower()]
    if sparse:
        # Git applies only one of these flag modes per invocation.
        for flag in ('--no-skip-worktree', '--no-assume-unchanged'):
            subprocess.run(['git', '-C', str(wt), 'update-index', flag, '-z', '--stdin'],
                           input='\0'.join(sparse) + '\0', text=True, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=(lease_fd,))
    if (repo / 'node_modules').is_dir() and not os.path.lexists(wt / 'node_modules'):
        helper = ROOT / 'bridge-worktree.mjs'
        if not helper.exists():
            helper = ROOT.parent / 'bridge-worktree.mjs'
        started = now_ms()
        subprocess.run(['node', str(helper), str(repo), str(wt)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=(lease_fd,))
        station(job, 'dependencies', started, 'ready')
    rules = (ROOT / 'agent-rules.txt').read_text()
    (RUNS / (job + '.prompt')).write_text(prompt + '\n' + rules.replace('{repo}', repo_name))
    return wt, base


def start_agent(job, pool, tier, wt, lease_fd):
    family = 'codex' if pool.startswith('codex') else pool
    default = {'codex': 'gpt-6.1-sol', 'claude': 'opus', 'devin': 'swe-2-max'}[family]
    try:
        models = json.loads((RUNS / 'models.json').read_text())
        if not isinstance(models, dict):
            raise Refusal('invalid-model-config')
        model = models.get(family + '.' + tier) or models.get(family) or default
    except (OSError, ValueError):
        model = default
    if not isinstance(model, str) or not model or any(c.isspace() for c in model):
        raise Refusal('invalid-model')
    env = dict(os.environ)
    env.pop('GH_TOKEN', None)
    env.pop('GITHUB_TOKEN', None)
    profile = pool if family == 'codex' else ('claude' if pool == 'claude' else 'agent')
    command = ['sandbox-exec', '-f', str(RUNS / 'bin' / (profile + '.sb'))]
    if family == 'codex':
        if pool == 'codex-personal':
            env['CODEX_HOME'] = str(Path.home() / '.codex-2')
        command += ['codex', 'exec', '-m', model, '--sandbox', 'danger-full-access', '-C', str(wt), '-']
    elif pool == 'claude':
        token = (RUNS / 'bin' / 'claude.token').read_text().strip()
        if not token:
            raise Refusal('missing-claude-token')
        env['CLAUDE_CODE_OAUTH_TOKEN'] = token
        command += ['claude', '-p', '--dangerously-skip-permissions', '--model', model]
    else:
        command += ['devin', '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false',
                    '--model', model, '-p', '--prompt-file', str(RUNS / (job + '.prompt'))]
    with (RUNS / (job + '.base.meta')).open('a') as meta:
        meta.write(f'MODEL {pool} {tier} {model}\n')
    # The agent only sees pipes for stdout/stderr, not denied run-directory FDs.
    # Start the actual sandbox process before acknowledging readiness; a shell
    # doing model lookup is not evidence that an agent process was spawned.
    with (RUNS / (job + '.prompt')).open('rb') as prompt:
        process = subprocess.Popen(command, cwd=wt, env=env, stdin=prompt,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   pass_fds=(lease_fd,))
    try:
        with (RUNS / (job + '.log')).open('wb') as log:
            logger = subprocess.Popen(['cat'], stdin=process.stdout, stdout=log,
                                      pass_fds=(lease_fd,))
    except OSError:
        process.terminate()
        process.wait()
        raise
    process.stdout.close()
    return process, logger


def launch(job, repo, pool, tier):
    started = now_ms()
    identifier(job)
    identifier(repo)
    identifier(os.environ.get('BRIDGE_RUN_ID', ''))
    if pool not in ('codex-cmp', 'codex-personal', 'claude', 'devin') or tier not in ('frontier', 'work', 'mid', 'fast'):
        raise Refusal('unsupported-pool-or-tier')
    prompt = sys.stdin.read()
    RUNS.mkdir(parents=True, exist_ok=True, mode=0o700)
    wt = str((PROJECTS / 'wt' / job).resolve())
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid:
        os.close(write_fd)
        # A slow/stalled filesystem is reported, never solved by breaking a lease.
        ready, _, _ = select.select([read_fd], [], [], 30)
        if not ready:
            os.close(read_fd)
            print('HELD: launch readiness timeout; inspect claim before retry')
            station(job, 'launch', started, 'timeout')
            return 3
        data = os.read(read_fd, 4096).decode()
        os.close(read_fd)
        print(data.strip() or 'HELD: launch worker exited before ready')
        return 0 if data.startswith('launched ') else 3
    os.close(read_fd)
    os.setsid()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    devnull = os.open(os.devnull, os.O_RDWR)
    for std in (0, 1, 2):
        os.dup2(devnull, std)
    os.close(devnull)
    outcome = 'failed'
    try:
        with locked(wt, worktree=wt) as lease_fd:
            atomic_json(RUNS / (job + '.claim'), {'pid': os.getpid(), 'worktree': wt,
                        'process_start': process_start(os.getpid()), 'created_at': time.time()})
            target, base = prepare(job, repo, pool, tier, prompt, lease_fd)
            process, logger = start_agent(job, pool, tier, target, lease_fd)
            # Both pipeline processes retain the lease if the supervisor dies.
            atomic_json(RUNS / (job + '.claim'), {'pid': process.pid, 'worktree': wt,
                        'process_start': process_start(process.pid), 'created_at': time.time(),
                        'supervisor_pid': os.getpid()})
            time.sleep(0.05)
            if process.poll() is not None:
                logger.wait()
                raise Refusal('agent-exited-before-ready')
            station(job, 'launch', started, 'ready')
            os.write(write_fd, f'launched {job} {pool} pid {process.pid} base {base[:9]}\n'.encode())
            os.close(write_fd)
            write_fd = -1
            rc = process.wait()
            logger.wait()
            station(job, 'session', started, 'completed' if rc == 0 else 'failed')
            outcome = 'completed'
    except (Refusal, OSError, subprocess.SubprocessError, ValueError) as error:
        reason = str(error) if isinstance(error, Refusal) else type(error).__name__
        station(job, 'launch', started, reason)
        if write_fd >= 0:
            try:
                os.write(write_fd, ('HELD: ' + reason + '\n').encode())
            except BrokenPipeError:
                pass
    finally:
        if write_fd >= 0:
            os.close(write_fd)
    os._exit(0 if outcome == 'completed' else 3)


def main():
    os.umask(0o077)
    if len(sys.argv) < 2:
        raise Refusal('invalid-arguments')
    command, *args = sys.argv[1:]
    if command == 'station' and len(args) == 4:
        station(*args)
        return 0
    if command == 'launch' and len(args) in (3, 4):
        return launch(*args[:3], args[3] if len(args) == 4 else os.environ.get('TIER', 'work'))
    if command == 'lock' and len(args) >= 3 and args[1] == '--':
        wt = str(Path(args[0]).resolve())
        with locked(wt, worktree=wt) as fd:
            env = dict(os.environ, BRIDGE_LOCK_FD=str(fd))
            return subprocess.call(args[2:], pass_fds=(fd,), env=env)
    raise Refusal('invalid-arguments')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Refusal as error:
        print('HELD: ' + str(error), file=sys.stderr)
        sys.exit(3)
