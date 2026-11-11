"""Fixture tests for contrib/mac/dispatchd.py (RQ-DEVINROUTEDEFAULTQ7 /
DEVIN-LEVERAGE-20261026).

Every case builds a synthetic ~/.ashlr-runs tree in a temp HOME and invokes the
repo copy of dispatchd.py once (one tick) as a subprocess; nothing touches the
real ~/.ashlr-runs or the live queue. Covers: the leverage devin defaults
(target 6, ceiling 10, hard_cap 10), the ceiling raise cap, the Masbot 21:19 failure-spike
step-down computed in dispatchd itself (-2, floor 6, once per new finish), and
devin's place in the restock trigger loop. Priority fixtures cover ready and
publish ordering, serialized publisher handoffs, and the per-repo FIX-MAIN cap.
"""
import json
import importlib.machinery
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'dispatchd.py'
LANES = ['codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local']

AP_GREEN = ('#!/usr/bin/python3\n'
            'import json, sys\n'
            'json.dump({"lane_disk_gate": "green", "memory": {"known": True, "raise_ok": True}}, sys.stdout)\n')


def build(slots=None, lanes_status=None, finishes=(), publishes=(), ready=(), queue_md=''):
    """A minimal ~/.ashlr-runs: queue/, metrics/, run/, bin/ plus the files the tick reads."""
    tmp = tempfile.TemporaryDirectory()
    home = Path(tmp.name)
    r = home / '.ashlr-runs'
    q = r / 'queue'
    for d in (q / 'prompts', q / 'run', r / 'metrics', r / 'bin', home / 'Projects' / 'ashlrai' / 'phantom',
              home / 'Projects' / 'ashlrai' / 'wt', home / 'stubbin'):
        d.mkdir(parents=True, exist_ok=True)
    stub = home / 'stubbin' / 'ps'   # a nonempty OS inventory with no fleet owners
    stub.write_text('#!/bin/bash\necho \"1000 /usr/bin/idle\"\nexit 0\n')
    stub.chmod(0o755)
    for command in ('memory_pressure', 'sysctl', 'lsof'):
        stub = home / 'stubbin' / command
        stub.write_text('#!/bin/bash\necho n/tmp\nexit 0\n' if command == 'lsof' else '#!/bin/bash\nexit 0\n')
        stub.chmod(0o755)
    set_daemon_tick(home, 'now')   # RQ-LOADGATE-1: a healthy host by default: fresh daemon tick, load and ncpu pinned in tick()
    (r / 'LOADGATE_TEST').write_text('')
    (r / 'DISKGUARD_TEST').write_text('')   # the fixture's healthy disk must not depend on the host's free space
    rows = [json.dumps(m) for m in list(finishes) + list(publishes)]
    (r / 'metrics' / 'jobs.jsonl').write_text(''.join(row + '\n' for row in rows))
    if slots is not None:
        (q / 'slots.json').write_text(json.dumps(slots))
    (q / 'status.json').write_text(json.dumps({'lanes': lanes_status or {}}))
    (q / 'ready.tsv').write_text(''.join(line + '\n' for line in ready))
    (q / 'claimed.tsv').write_text('')
    (q / 'keep.txt').write_text('')
    (q / 'RETIRED').write_text('')
    (q / 'router-queue.md').write_text(queue_md)
    (r / 'HOLD').write_text('')
    (q / 'BATCH_OFF').write_text('')   # one job per session here; test_batching.py covers RQ-QUEUE-BATCH-1 batches
    return tmp


ASHLR_STUB = ('#!/bin/bash\n'   # stands in for `ashlr daemon status --json`; the tick time comes from $HOME/ashlr-last-tick
              'f="$HOME/ashlr-last-tick"; [ -f "$f" ] || exit 1\nv="$(cat "$f")"\n'
              '[ "$v" = now ] && v="$(date -u +%Y-%m-%dT%H:%M:%SZ)"\n'
              'if [ "$v" = null ]; then echo \'{"lastTickAt": null}\'; else echo "{\\"lastTickAt\\": \\"$v\\"}"; fi\n')


def set_daemon_tick(home, value):
    """value: 'now', 'null', an ISO timestamp, or None to make the stub fail (daemon status unavailable)."""
    home = Path(home)
    stub = home / 'stubbin' / 'ashlr'
    stub.write_text(ASHLR_STUB)
    stub.chmod(0o755)
    f = home / 'ashlr-last-tick'
    if value is None:
        f.unlink(missing_ok=True)
    else:
        f.write_text(value)


def tick(home, env_extra=None, script=None):
    env = {'HOME': str(home),
           'PATH': str(Path(home) / 'stubbin') + ':' + os.environ.get('PATH', '/usr/bin:/bin'),
           'LANG': 'C', 'LOADGATE_LOADAVG': '1.0', 'LOADGATE_NCPU': '18', 'LOADGATE_PRESSURE': '1', 'LOADGATE_SWAP_GB': '0',
           'DISKGUARD_FREE_GB': '500'}
    if env_extra:
        env.update(env_extra)
    env.setdefault('PYTHONPATH', str(Path(home) / 'stubbin') + ':' + str(SCRIPT.parent))
    script = script or SCRIPT
    return subprocess.run([sys.executable, '-B', str(script)], env=env,
                          capture_output=True, text=True, timeout=120)


def slots_of(home):
    return json.loads((home / '.ashlr-runs' / 'queue' / 'slots.json').read_text())


def events(home):
    f = home / '.ashlr-runs' / 'dispatch-events.log'
    return f.read_text() if f.exists() else ''


def fin(job, **kw):
    return {'event': 'finish', 'lane': 'devin', 'job': job, 'empty': False, **kw}


def pub(job):
    return {'event': 'publish', 'job': job, 'url': f'https://example.invalid/{job}'}


def devin_slot(**kw):
    slot = {'target': 10, 'floor': 3, 'ceiling': 16, 'hard_cap': 16, 'last_change': 0}   # fixtures raise hard_cap past the 10 default
    slot.update(kw)
    return slot


def held_lanes():
    return {lane: {'held': True, 'target': 0, 'floor': 0, 'ceiling': 0, 'last_change': 0} for lane in LANES}


# RQ-LANERECOVERNOV1Q8 fixtures: auth-vs-usage log lines, a finished/gone worker, a free lane slot.
AUTH_401 = 'ERROR: unexpected status 401 Unauthorized: {"error":{"message":"expired token"}}'
AUTH_REFRESH = 'ERROR: Failed to refresh access token: invalid_grant'
USAGE_ACU = 'ERROR: ACU limit reached for this workspace'


def dead(home, job, lane, lines, result='EMPTY'):
    """A finished, gone worker: .base + fresh .log + a RESULT line; no worktree, so it is never reaped."""
    r = home / '.ashlr-runs'
    (r / f'{job}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{job} {lane}\n')
    (r / f'{job}.log').write_text(''.join(text + '\n' for text in lines))
    (r / f'{job}.publish').write_text(f'RESULT {result}\n')


def lane_slot(**kw):
    return {'target': 10, 'floor': 0, 'ceiling': 16, 'last_change': 0, **kw}


def queue_job(home, job, lane, tier='work', repo='phantom', size=None):
    """A valid ready.tsv line (prompt inside queue/prompts) plus its router-queue.md READY row."""
    q = home / '.ashlr-runs' / 'queue'
    (home / 'Projects' / 'ashlrai' / repo).mkdir(exist_ok=True)
    pf = q / 'prompts' / f'{job}.md'
    pf.write_text('fixture prompt')
    with (q / 'ready.tsv').open('a') as f:
        f.write(f'{job}\t{repo}\t{lane}\t{tier}\t{pf}\n')
    with (q / 'router-queue.md').open('a') as f:
        size_hint = f', size<={size}' if size is not None else ''
        f.write(f'- READY {job} (pool={lane}{size_hint}): fixture\n')


def launch_stubs(home):
    """launch.sh + a green autopilot; returns the tick env that also lifts the disk guard."""
    stub = home / '.ashlr-runs' / 'bin' / 'launch.sh'
    stub.write_text('#!/bin/bash\necho "launched $@"\n')
    stub.chmod(0o755)
    (home / '.ashlr-runs' / 'bin' / 'autopilot.py').write_text(AP_GREEN)
    (home / '.ashlr-runs' / 'DISKGUARD_TEST').write_text('')
    return {'DISKGUARD_FREE_GB': '500'}


def ready_lines(home):
    return (home / '.ashlr-runs' / 'queue' / 'ready.tsv').read_text().splitlines()


def dispatched(home, job):
    return (home / '.ashlr-runs' / 'queue' / 'run' / f'{job}.dispatched').exists()


def auth_mark(home, job):
    f = home / '.ashlr-runs' / 'queue' / 'run' / f'{job}.authfail.seen'
    return f.read_text().strip() if f.exists() else None


class DispatchClaimTests(unittest.TestCase):
    def test_tick_claim_recovers_after_owner_exit(self):
        tmp = build(); self.addCleanup(tmp.cleanup); home = Path(tmp.name).resolve()
        env = launch_stubs(home); queue_job(home, 'RQ-CLAIM', lane='devin')
        lock = home / '.ashlr-runs/queue/dispatchd.tick.lock'
        owner = subprocess.Popen([sys.executable, '-c',
            'import fcntl,sys,time; f=open(sys.argv[1], "a"); fcntl.flock(f, fcntl.LOCK_EX); print("locked", flush=True); time.sleep(60)',
            str(lock)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(owner.stdout.readline().strip(), 'locked')
            self.assertEqual(tick(home, env).returncode, 0)
            self.assertFalse(dispatched(home, 'RQ-CLAIM'))
        finally:
            owner.kill(); owner.wait(); owner.stdout.close()
        self.assertEqual(tick(home, env).returncode, 0)
        self.assertTrue(dispatched(home, 'RQ-CLAIM'))
        self.assertEqual(tick(home, env).returncode, 0)
        rows = [json.loads(x) for x in (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
        self.assertEqual(sum(x.get('event') == 'launch' and x.get('job') == 'RQ-CLAIM' for x in rows), 1)

    def test_interrupted_claim_is_retried(self):
        tmp = build(); self.addCleanup(tmp.cleanup); home = Path(tmp.name).resolve()
        env = launch_stubs(home); queue_job(home, 'RQ-CRASH', lane='devin')
        q = home / '.ashlr-runs/queue'; line = (q / 'ready.tsv').read_text()
        (q / 'ready.tsv').write_text('')
        (q / 'run/RQ-CRASH.line').write_text(line)
        receipt = q / 'run/RQ-CRASH.dispatched'; receipt.write_text('0')
        os.utime(receipt, (time.time() - 300, time.time() - 300))
        self.assertEqual(tick(home, env).returncode, 0)
        self.assertTrue(dispatched(home, 'RQ-CRASH'))
        self.assertIn('LAUNCH_INTERRUPTED RQ-CRASH', events(home))

    def test_candidate_worker_cwd_prevents_duplicate_after_grace(self):
        candidate = SCRIPT.parent / 'host-integration/dispatchd.candidate.py'
        for lane in ('grok', 'cursor'):
            with self.subTest(lane=lane):
                tmp = build(); self.addCleanup(tmp.cleanup); home = Path(tmp.name).resolve()
                env = launch_stubs(home); queue_job(home, 'RQ-LIVE', lane=lane)
                (home / 'stubbin/router_queue.py').write_text('def load(path): return ({}, set())\ndef read_metadata(path): return open(path).read()\n')
                (home / '.ashlr-runs/bin/router.py').write_text('def load(path): return ({}, {})\n')
                (home / '.ashlr-runs/queue/ROUTER_OFF').touch()
                r = home / '.ashlr-runs'; wt = home / 'Projects/ashlrai/wt/RQ-LIVE'; wt.mkdir()
                (r / 'RQ-LIVE.base').write_text(f'phantom branch {wt} {lane}\n')
                receipt = r / 'queue/run/RQ-LIVE.dispatched'; receipt.write_text('0')
                os.utime(receipt, (time.time() - 300, time.time() - 300))
                (home / 'stubbin/lsof').write_text(f'#!/bin/sh\necho n{wt}\n')
                result = tick(home, env, script=candidate)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(receipt.exists())
                rows = [json.loads(x) for x in (r / 'metrics/jobs.jsonl').read_text().splitlines()]
                self.assertFalse(any(x.get('event') == 'launch' and x.get('job') == 'RQ-LIVE' for x in rows))


class SlotDefaultTests(unittest.TestCase):
    def test_missing_devin_slot_seeds_leverage_defaults(self):
        # No devin entry in slots.json: the DEFAULT row seeds target 6, floor 3, ceiling 10, hard_cap 10.
        tmp = build(slots=held_lanes())
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        slots = held_lanes()
        slots.pop('devin')
        (home / '.ashlr-runs' / 'queue' / 'slots.json').write_text(json.dumps(slots))
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        devin = slots_of(home)['devin']
        self.assertEqual((devin['target'], devin['floor'], devin['ceiling'], devin['hard_cap']), (6, 3, 10, 10), devin)


class CeilingTests(unittest.TestCase):
    def _fixture(self, target, last_change=0):
        slots = held_lanes()
        slots['devin'] = devin_slot(target=target, last_change=last_change)
        tmp = build(slots=slots)
        home = Path(tmp.name)
        q = home / '.ashlr-runs' / 'queue'
        pf = q / 'prompts' / 'RQ-CEIL-1.md'
        pf.write_text('fixture prompt')
        (q / 'ready.tsv').write_text(f'RQ-CEIL-1\tphantom\tdevin\twork\t{pf}\n')
        (q / 'router-queue.md').write_text('- READY RQ-CEIL-1 (pool=devin, tier=work, repo=phantom): fixture\n')
        for i in range(target):
            j = f'RQ-RUN-{i:02d}'
            (home / 'Projects' / 'ashlrai' / 'wt' / j).mkdir()
            (home / '.ashlr-runs' / f'{j}.base').write_text(f'deadbeef x {home}/Projects/ashlrai/wt/{j} devin\n')
        (home / '.ashlr-runs' / 'bin' / 'autopilot.py').write_text(AP_GREEN)
        return tmp, home

    def test_raise_stops_at_ceiling_16(self):
        # 15 running under target 15 with queue depth and a green disk gate: +2 raise
        # clamps at the leverage ceiling 16, never overshoots it.
        tmp, home = self._fixture(15)
        self.addCleanup(tmp.cleanup)
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(slots_of(home)['devin']['target'], 16)
        self.assertIn('SLOTS devin 15->16', events(home))

    def test_at_ceiling_never_raises(self):
        tmp, home = self._fixture(16)
        self.addCleanup(tmp.cleanup)
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(slots_of(home)['devin']['target'], 16)
        self.assertNotIn('SLOTS devin 16->', events(home))


class StepDownTests(unittest.TestCase):
    def _run(self, finishes, publishes, slot=None, extra_ready=()):
        slots = held_lanes()
        slots['devin'] = slot or devin_slot(last_change=int(1e15))
        tmp = build(slots=slots, finishes=finishes, publishes=publishes, ready=extra_ready)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        return home, slots_of(home)['devin'], events(home)

    def test_spike_steps_target_down_two(self):
        # 10 devin completions, 4 without a PR (3 unpublished finishes + 1 empty):
        # over the >3 bar, so target 10 -> 8, once for the newest finish.
        fins = [fin(f'RQ-D-{i}') for i in range(10)]
        fins[0]['empty'] = True
        pubs = [pub(f'RQ-D-{i}') for i in range(4, 10)]
        home, devin, ev = self._run(fins, pubs)
        self.assertEqual(devin['target'], 8)
        self.assertEqual(devin['step_seen'], 'RQ-D-9')
        self.assertIn('SLOTS devin 10->8 step-down (4 of last 10 without PR)', ev)

    def test_no_spike_no_step(self):
        # Exactly 3 of 10 without a PR sits at the bar, not over it: no step.
        fins = [fin(f'RQ-E-{i}') for i in range(10)]
        pubs = [pub(f'RQ-E-{i}') for i in range(3, 10)]
        _home, devin, ev = self._run(fins, pubs)
        self.assertEqual(devin['target'], 10)
        self.assertNotIn('step-down', ev)

    def test_empty_counts_and_publish_counts_as_pr(self):
        # All ten finishes published: nothing counts against the lane.
        fins = [fin(f'RQ-F-{i}') for i in range(10)]
        pubs = [pub(f'RQ-F-{i}') for i in range(10)]
        _home, devin, _ev = self._run(fins, pubs)
        self.assertEqual(devin['target'], 10)
        # Ten finishes, ten empties: the worst possible window steps to the floor zone.
        fins = [fin(f'RQ-G-{i}', empty=True) for i in range(10)]
        _home, devin, ev = self._run(fins, [])
        self.assertEqual(devin['target'], 8)
        self.assertIn('step-down', ev)

    def test_once_per_new_finish_and_floor_6(self):
        # A second tick on the same window does not step again; a new finish does,
        # and repeated spikes pin the target at the floor 6 instead of falling below.
        fins = [fin(f'RQ-H-{i}') for i in range(10)]
        pubs = [pub(f'RQ-H-{i}') for i in range(6, 10)]
        slots = held_lanes()
        slots['devin'] = devin_slot(last_change=int(1e15))
        tmp = build(slots=slots, finishes=fins, publishes=pubs)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        self.assertEqual(tick(home).returncode, 0)
        self.assertEqual(slots_of(home)['devin']['target'], 8)
        self.assertEqual(tick(home).returncode, 0)   # same last finish seen: no second step
        self.assertEqual(slots_of(home)['devin']['target'], 8)
        jl = home / '.ashlr-runs' / 'metrics' / 'jobs.jsonl'
        with jl.open('a') as f:
            f.write(json.dumps(fin('RQ-H-10')) + '\n')   # new non-PR finish: window slides
        self.assertEqual(tick(home).returncode, 0)
        self.assertEqual(slots_of(home)['devin']['target'], 6)
        self.assertEqual(slots_of(home)['devin']['step_seen'], 'RQ-H-10')
        with jl.open('a') as f:
            f.write(json.dumps(fin('RQ-H-11')) + '\n')
        self.assertEqual(tick(home).returncode, 0)
        self.assertEqual(slots_of(home)['devin']['target'], 6)   # floor 6 holds

    def test_held_devin_lane_does_not_step(self):
        fins = [fin(f'RQ-I-{i}', empty=True) for i in range(10)]
        _home, devin, ev = self._run(fins, [], slot=devin_slot(held=True, last_change=int(1e15)))
        self.assertEqual(devin['target'], 10)
        self.assertNotIn('step-down', ev)


class RestockTriggerTests(unittest.TestCase):
    def _stub(self, home):
        stub = home / '.ashlr-runs' / 'bin' / 'restock.sh'
        stub.write_text('#!/bin/bash\ntouch "$HOME/.ashlr-runs/queue/restock-called"\n')
        stub.chmod(0o755)
        return home / '.ashlr-runs' / 'queue' / 'restock-called'

    def test_devin_in_trigger_loop(self):
        # Codex lanes held, devin idle with an empty queue: the trigger fires the
        # restocker for devin, so it must sit inside dispatchd's trigger loop.
        slots = held_lanes()
        slots['devin'] = devin_slot(last_change=int(1e15))
        tmp = build(slots=slots, queue_md='# queue\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        called = self._stub(home)
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(called.exists(), 'restock.sh was not invoked for a starved devin lane')

    def test_parked_backlog_refreshes_evidence_and_wakes_restock(self):
        slots = held_lanes()
        slots['devin'] = devin_slot(last_change=int(1e15))
        rows = [f'PARKED-MERGERATE.devin\tRQ-PARK-{n}\tdevin\twork\tphantom\tunused' for n in range(22)]
        tmp = build(slots=slots, ready=rows, queue_md='# queue\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        called = self._stub(home)
        gh = home / 'stubbin/gh'
        gh.write_text('#!/bin/sh\necho 20\n')
        gh.chmod(0o755)
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(called.exists())
        self.assertEqual((home / '.ashlr-runs/phantom-open-prs').read_text().split()[1], '20')
        self.assertEqual(ready_lines(home), rows)
        status = json.loads((home / '.ashlr-runs/queue/status.json').read_text())
        self.assertEqual(status['lanes']['devin']['queued'], 0)
        self.assertEqual(status['invalid_queue_lines'], 0)
        metrics = (home / '.ashlr-runs/metrics/jobs.jsonl').read_text()
        self.assertNotIn('"event": "enqueue"', metrics)
        route_state = json.loads((home / '.ashlr-runs/queue/route-state.json').read_text())
        self.assertEqual(route_state, {})

    def test_saturated_backlog_eventually_dispatches_through_precheck(self):
        slots = held_lanes()
        slots['devin'] = devin_slot(last_change=int(1e15))
        tmp = build(slots=slots, queue_md='# queue\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        q = home / '.ashlr-runs/queue'
        rows = []
        for n in range(22):
            prompt = q / 'prompts' / f'RQ-PROBE-{n}.md'
            prompt.write_text(f'RQ-PROBE-{n} (repo=phantom): Required checks apply; no merge without Security pin\n')
            rows.append(f'PARKED-MERGERATE.devin\tRQ-PROBE-{n}\tdevin\twork\tphantom\t{prompt}')
        (q / 'ready.tsv').write_text('\n'.join(rows) + '\n')
        # Restock records every enqueue in this durable history before the
        # supervisor can park it; those records are not active dispatches.
        (q / 'claimed.tsv').write_text(''.join(f'RQ-PROBE-{n}\tdevin\twork\t12:00\t1\n' for n in range(22)))
        (home / '.ashlr-runs/phantom-open-prs').write_text(f'{time.time()} 150\n')
        precheck = home / '.ashlr-runs/bin/precheck.sh'
        precheck.write_text('#!/bin/sh\necho checked >> "$HOME/prechecked"\nexit 13\n')
        precheck.chmod(0o755)
        restock_script = SCRIPT.parent / 'restock.py'
        def recover():
            return subprocess.run([sys.executable, '-B', str(restock_script), '--per-lane', '0'],
                                  env={'HOME': str(home), 'PATH': str(home / 'stubbin') + ':' + os.environ.get('PATH', '/usr/bin:/bin')},
                                  capture_output=True, text=True, timeout=60)
        r = recover()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((q / 'ready.tsv').read_text().count('PARKED-MERGERATE.'), 21)
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((home / 'prechecked').exists(), (r.stdout, r.stderr, events(home), ready_lines(home)))
        self.assertIn('RQ-PROBE-0', json.loads((q / 'precheck-parked.json').read_text()))
        self.assertFalse((q / 'run/RQ-PROBE-0.dispatched').exists())
        self.assertIn('no merge without Security pin', (q / 'prompts/RQ-PROBE-0.md').read_text())
        self.assertEqual(recover().returncode, 0)
        self.assertEqual((q / 'ready.tsv').read_text().count('PARKED-MERGERATE.'), 21)
        # Once the precheck becomes due and succeeds, the ordinary dispatcher claims it.
        state = json.loads((q / 'precheck-parked.json').read_text())
        state['RQ-PROBE-0']['retry_at'] = 0
        (q / 'precheck-parked.json').write_text(json.dumps(state))
        precheck.write_text('#!/bin/sh\necho passed >> "$HOME/prechecked"\nexit 0\n')
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((q / 'run/RQ-PROBE-0.dispatched').exists())
        self.assertIn('passed', (home / 'prechecked').read_text())
        self.assertEqual(tick(home).returncode, 0)
        metrics = [json.loads(row) for row in (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]
        self.assertEqual(sum(m.get('event') == 'launch' and m.get('job') == 'RQ-PROBE-0' for m in metrics), 1)

    def test_concurrent_unpark_survives_dispatcher_rewrite(self):
        from unittest.mock import patch
        for status_first in (True, False):
            with self.subTest(status_first=status_first):
                old = ('PARKED-MERGERATE.devin\tRQ-RACE\tdevin\twork\tphantom\tprompt' if status_first
                       else 'RQ-RACE\tphantom\tPARKED-MERGERATE.devin\twork\tprompt')
                new = 'RQ-RACE\tphantom\tdevin\twork\tprompt'
                tmp = build(slots=held_lanes(), ready=[old], queue_md='# queue\n')
                self.addCleanup(tmp.cleanup)
                home = Path(tmp.name)
                script = home / 'dispatchd-test.py'
                injection = f'open(Q + "/ready.tsv", "w").write({(new + chr(10))!r})\n'
                script.write_text(SCRIPT.read_text().replace('# Reconcile concurrent parked-row rewrites', injection + '# Reconcile concurrent parked-row rewrites'))
                module_path = str(SCRIPT.parent)
                with patch(__name__ + '.SCRIPT', script):
                    result = tick(home, {'PYTHONPATH': module_path})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(ready_lines(home), [new])

    def test_held_devin_never_triggers(self):
        slots = held_lanes()
        slots['devin'] = devin_slot(held=True, last_change=int(1e15))
        tmp = build(slots=slots, queue_md='# queue\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        called = self._stub(home)
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(called.exists())

    def test_restock_off_flag_blocks_trigger(self):
        slots = held_lanes()
        slots['devin'] = devin_slot(last_change=int(1e15))
        tmp = build(slots=slots, queue_md='# queue\n')
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        called = self._stub(home)
        (home / '.ashlr-runs' / 'queue' / 'RESTOCK_OFF').write_text('')
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(called.exists())


class AuthBackoffTests(unittest.TestCase):
    """RQ-LANERECOVERNOV1Q8: repeated authentication failures hold the lane autobackoff-style.

    Two or more distinct failed/EMPTY finishes on one lane whose logs carry a provider
    auth-error line inside the 30-minute window set held/held_by=autobackoff/held_until.
    Below that bar nothing holds; a produced PR never counts; manual holds are never
    touched; an expired hold releases and the lane launches again. No fixture writes a
    credential store.
    """

    def _home(self, lanes, queue_md='# queue\n'):
        slots = held_lanes()
        slots.update(lanes)
        tmp = build(slots=slots, queue_md=queue_md)
        self.addCleanup(tmp.cleanup)
        # resolve(): /var -> /private/var on macOS, so the queue/prompts realpath check passes.
        home = Path(tmp.name).resolve()
        return home, launch_stubs(home)

    def test_single_auth_failure_below_threshold(self):
        home, env = self._home({'devin': lane_slot()})
        dead(home, 'RQ-A1', 'devin', [AUTH_401])
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('held', slots_of(home)['devin'])
        self.assertEqual(auth_mark(home, 'RQ-A1'), 'fail devin_auth_failure')
        self.assertNotIn('LANE_HOLD devin', events(home))

    def test_repeated_auth_failures_hold_lane(self):
        home, env = self._home({'devin': lane_slot()})
        dead(home, 'RQ-A1', 'devin', [AUTH_401])
        dead(home, 'RQ-A2', 'devin', ['some output', AUTH_REFRESH])
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        devin = slots_of(home)['devin']
        self.assertEqual((devin['held'], devin['held_by']), (True, 'autobackoff'))
        self.assertIn('devin_auth_failure', devin['held_reason'])
        self.assertIn('src=default', devin['held_reason'])
        self.assertIn('LANE_HOLD devin autobackoff', events(home))

    def test_failure_streak_accumulates_across_ticks(self):
        home, env = self._home({'devin': lane_slot()})
        dead(home, 'RQ-A1', 'devin', [AUTH_401])
        self.assertEqual(tick(home, env).returncode, 0)
        self.assertNotIn('held', slots_of(home)['devin'])
        dead(home, 'RQ-A2', 'devin', [AUTH_401])
        self.assertEqual(tick(home, env).returncode, 0)
        # The persisted verdict from the first tick makes this the second failure.
        self.assertTrue(slots_of(home)['devin'].get('held'))

    def test_produced_work_and_lane_isolation(self):
        home, env = self._home({'devin': lane_slot(), 'codex-cmp': lane_slot()})
        dead(home, 'RQ-A1', 'devin', [AUTH_401])
        dead(home, 'RQ-PR', 'devin', [AUTH_401], result='PR https://example.invalid/pr/1')
        dead(home, 'RQ-C1', 'codex-cmp', [AUTH_REFRESH])
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        slots = slots_of(home)
        # One EMPTY + one PR on devin is a single countable failure: no hold.
        self.assertNotIn('held', slots['devin'])
        self.assertEqual(auth_mark(home, 'RQ-PR'), 'work devin_auth_failure')
        # One failure on codex-cmp is likewise below its own threshold.
        self.assertNotIn('held', slots['codex-cmp'])
        dead(home, 'RQ-C2', 'codex-cmp', [AUTH_401])
        self.assertEqual(tick(home, env).returncode, 0)
        slots = slots_of(home)
        self.assertTrue(slots['codex-cmp'].get('held'))
        self.assertIn('codex_auth_failure', slots['codex-cmp']['held_reason'])
        self.assertNotIn('held', slots['devin'])

    def test_usage_limit_lines_are_not_auth_failures(self):
        home, env = self._home({'devin': lane_slot()})
        dead(home, 'RQ-U1', 'devin', [USAGE_ACU])
        dead(home, 'RQ-U2', 'devin', [USAGE_ACU])
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        devin = slots_of(home)['devin']
        # The usage backoff holds on one line; the auth path never counts these.
        self.assertIn('devin_acu_exhausted', devin['held_reason'])
        self.assertIsNone(auth_mark(home, 'RQ-U1'))

    def test_manual_hold_is_never_touched(self):
        home, env = self._home({'devin': lane_slot(
            held=True, held_by='operator', held_until='2999-01-01T00:00:00+00:00',
            held_reason='manual')})
        dead(home, 'RQ-A1', 'devin', [AUTH_401])
        dead(home, 'RQ-A2', 'devin', [AUTH_401])
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(slots_of(home)['devin']['held_by'], 'operator')
        self.assertNotIn('LANE_HOLD devin autobackoff', events(home))

    def test_held_lane_waits_while_healthy_lanes_dispatch(self):
        home, env = self._home({'devin': lane_slot(), 'codex-cmp': lane_slot()})
        dead(home, 'RQ-A1', 'devin', [AUTH_401])
        dead(home, 'RQ-A2', 'devin', [AUTH_401])
        queue_job(home, 'RQ-D-WAIT', 'devin')
        queue_job(home, 'RQ-C-RUN', 'codex-cmp')
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(slots_of(home)['devin'].get('held'))
        # Eligible work still reaches the healthy lane; the held lane's job stays queued.
        self.assertTrue(dispatched(home, 'RQ-C-RUN'))
        self.assertFalse(dispatched(home, 'RQ-D-WAIT'))
        self.assertEqual([l.split('\t')[0] for l in ready_lines(home)], ['RQ-D-WAIT'])
        self.assertIn('LAUNCH RQ-C-RUN', events(home))

    def test_expired_auth_hold_recovers_and_launches(self):
        home, env = self._home({'devin': lane_slot(
            held=True, held_by='autobackoff', held_until='2020-01-01T00:00:00+00:00',
            held_reason='autobackoff devin_auth_failure job=RQ-OLD until=2020-01-01 src=default')})
        queue_job(home, 'RQ-D-OK', 'devin')
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('held', slots_of(home)['devin'])
        self.assertIn('LANE_UNHOLD devin', events(home))
        self.assertTrue(dispatched(home, 'RQ-D-OK'))


class RunHelperTests(unittest.TestCase):
    """RQ-TICK-BUDGET _run: a timeout kills the whole process group, grandchildren included."""
    def _load(self):
        import re, signal, time
        src = SCRIPT.read_text()
        block = re.search(r'^def _run\(.*?^    return subprocess\.CompletedProcess\(.*?\n', src, re.M | re.S).group(0)
        logs = []
        ns = {'os': os, 'subprocess': subprocess, 'time': time, 'signal': signal, 'log': logs.append}
        exec(block, ns)
        return ns['_run'], logs

    def test_ok_returns_completed_process(self):
        run, logs = self._load()
        r = run(['/bin/sh', '-c', 'echo out; echo err >&2; exit 3'], 5)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (3, 'out\n', 'err\n'))
        self.assertEqual(logs, [])

    def test_timeout_kills_grandchildren(self):
        run, logs = self._load()
        with tempfile.TemporaryDirectory() as d:
            pidf = Path(d) / 'pid'
            with self.assertRaises(subprocess.TimeoutExpired):
                run(['/bin/sh', '-c', f'sleep 60 & echo $! > {pidf}; wait'], 1)
            pid = int(pidf.read_text())
            gone = False
            for _ in range(50):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    gone = True
                    break
                time.sleep(0.1)
            self.assertTrue(gone, 'grandchild survived the group kill')
        self.assertTrue(any(m.startswith('SLOW sh timeout 1s, group killed') or 'group killed' in m for m in logs), logs)


class QueueWaitTests(unittest.TestCase):
    def fixture(self, lanes):
        slots = held_lanes()
        for lane in lanes:
            slots[lane] = lane_slot(target=10)
        tmp = build(slots=slots)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        return home, launch_stubs(home)

    def metrics(self, home):
        return [json.loads(line) for line in
                (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()]

    def test_enqueue_once_while_paused_then_claim_with_measurable_wait(self):
        from datetime import datetime
        home, env = self.fixture(['codex-cmp'])
        queue_job(home, 'RQ-WAIT', 'codex-cmp')
        pause = home / '.ashlr-runs/PAUSE'
        pause.write_text("fixture pause")
        for _ in range(2):
            r = tick(home, env)
            self.assertEqual(r.returncode, 0, r.stderr)
        rows = self.metrics(home)
        self.assertEqual([r['event'] for r in rows], ['enqueue'])
        self.assertEqual({k: rows[0][k] for k in ('job', 'repo', 'lane', 'tier')},
                         dict(job='RQ-WAIT', repo='phantom', lane='codex-cmp', tier='work'))
        pause.unlink()
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        rows = self.metrics(home)
        self.assertEqual([r['event'] for r in rows], ['enqueue', 'claim', 'launch'])
        wait = (datetime.fromisoformat(rows[1]['ts']) - datetime.fromisoformat(rows[0]['ts'])).total_seconds()
        self.assertGreaterEqual(wait, 0)
        self.assertLess(wait, 300)
        for key in ('job', 'repo', 'lane', 'tier'):
            self.assertEqual(rows[0][key], rows[1][key])

    def test_claim_limit_preserves_priority_across_ticks_and_skips_blocked_head(self):
        lanes = ['codex-cmp', 'codex-personal', 'claude', 'devin']
        home, env = self.fixture(lanes)
        # MAX_LAUNCH_PER_TICK limits claims to four. Priority holds even when
        # several lanes remain backlogged; the blocked first path waits.
        queue_job(home, 'RQ-BLOCKED', 'codex-cmp')
        (home / 'Projects/ashlrai/wt/RQ-BLOCKED').mkdir()
        jobs = []
        for n in range(3):
            for lane in lanes:
                job = 'RQ-%s-%d' % (lane, n)
                jobs.append(job)
                queue_job(home, job, lane)
        r = tick(home, env)
        self.assertEqual(r.returncode, 0, r.stderr)
        claimed = [r for r in self.metrics(home) if r['event'] == 'claim']
        self.assertEqual([r['job'] for r in claimed], sorted(jobs)[:4])
        self.assertEqual(len(claimed), 4)
        self.assertNotIn('RQ-BLOCKED', [r['job'] for r in claimed])
        self.assertIn('RQ-BLOCKED', [line.split('\t')[0] for line in ready_lines(home)])


class DispatchPriorityTests(unittest.TestCase):
    def fixture(self, lanes=('codex-cmp',)):
        slots = held_lanes()
        for lane in lanes:
            slots[lane] = lane_slot(target=10)
        tmp = build(slots=slots)
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        return home, launch_stubs(home)

    def claims(self, home):
        rows = (home / '.ashlr-runs/metrics/jobs.jsonl').read_text().splitlines()
        return [row['job'] for row in map(json.loads, rows) if row['event'] == 'claim']

    def run_tick(self, home, env):
        result = tick(home, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_local_oversized_and_unknown_jobs_remain_queued(self):
        home, env = self.fixture(('codex-local', 'codex-cmp'))
        for job, size in [('RQ-LOCAL-LARGE', 61), ('RQ-LOCAL-UNKNOWN', None), ('RQ-LOCAL-BAD', 'oops')]:
            queue_job(home, job, 'codex-local', size=size)
        queue_job(home, 'RQ-OTHER', 'codex-cmp', size=200)
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-OTHER'])
        remaining = '\n'.join(ready_lines(home))
        for job in ('RQ-LOCAL-LARGE', 'RQ-LOCAL-UNKNOWN', 'RQ-LOCAL-BAD'):
            self.assertIn(job, remaining)

    def test_launch_buckets_override_queue_order_and_lane_cursor(self):
        home, env = self.fixture(('codex-cmp', 'codex-personal', 'devin'))
        jobs = [('RQ-OTHER', 'codex-cmp'), ('LAND-A', 'codex-cmp'),
                ('RQ-DESK-A', 'codex-personal'), ('RQ-REL-A', 'devin'),
                ('RQ-FIX-MAIN-A', 'devin')]
        for job, lane in jobs:
            queue_job(home, job, lane)
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-FIX-MAIN-A', 'RQ-REL-A', 'RQ-DESK-A', 'LAND-A'])
        self.assertEqual([line.split('\t')[0] for line in ready_lines(home)], ['RQ-OTHER'])

    def test_land_fixup_and_recut_share_a_bucket_before_other_jobs(self):
        home, env = self.fixture()
        jobs = ['RQ-A-OTHER', 'RQ-RECUT-Z', 'RQ-LAND-Y', 'RQ-FIXUP-X',
                'RECUT-C', 'LAND-B', 'FIXUP-A']
        for job in jobs:
            queue_job(home, job, 'codex-cmp')
        self.run_tick(home, env)
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), sorted(jobs[1:]) + ['RQ-A-OTHER'])

    def test_repo_rank_precedes_size_and_job_path(self):
        home, env = self.fixture()
        repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon',
                 'ashlr-md', 'ashlr-stack', 'ashlr-plugin', 'unknown-repo']
        expected = []
        for index, repo in reversed(list(enumerate(repos))):
            job = f'RQ-WORK-{8 - index}'
            expected.insert(0, job)
            queue_job(home, job, 'codex-cmp', repo=repo, size=1000 - index)
        self.run_tick(home, env)
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), expected)

    def test_repo_size_and_path_rank_override_lane_order_and_old_cursor(self):
        home, env = self.fixture(('codex-cmp', 'codex-personal', 'claude', 'devin'))
        jobs = [('RQ-Z-100', 'phantom', 'codex-cmp', 100),
                ('RQ-C-20', 'phantom', 'codex-cmp', 20),
                ('RQ-B-20', 'phantom', 'codex-personal', 20),
                ('RQ-A-1', 'locus', 'devin', 1),
                ('RQ-0-1', 'unknown-repo', 'claude', 1)]
        for job, repo, lane, size in jobs:
            queue_job(home, job, lane, repo=repo, size=size)
        (home / '.ashlr-runs/queue/claim-cursor.json').write_text('{"lane":"devin"}')
        self.run_tick(home, env)
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-B-20', 'RQ-C-20', 'RQ-Z-100', 'RQ-A-1', 'RQ-0-1'])

    def test_numeric_size_hint_then_path_with_missing_and_invalid_last(self):
        home, env = self.fixture()
        for job, size in [('RQ-D-MISSING', None), ('RQ-C-INVALID', 'oops'),
                          ('RQ-B-100', '100'), ('RQ-Z-20', '20'), ('RQ-A-20', '20')]:
            queue_job(home, job, 'codex-cmp', size=size)
        self.run_tick(home, env)
        self.run_tick(home, env)
        self.assertEqual(self.claims(home),
                         ['RQ-A-20', 'RQ-Z-20', 'RQ-B-100', 'RQ-C-INVALID', 'RQ-D-MISSING'])

    def test_size_hint_is_scoped_to_exact_job_envelope(self):
        home, env = self.fixture()
        queue_job(home, 'RQ-WORK-A', 'codex-cmp', size=100)
        queue_job(home, 'RQ-WORK-AB', 'codex-cmp', size=1)
        queue_job(home, 'RQ-WORK-Z', 'codex-cmp')
        q = home / '.ashlr-runs/queue'
        with (q / 'router-queue.md').open('a') as f:
            f.write('Unrelated prose RQ-WORK-Z size<=0\n')
            f.write('- READY RQ-OTHER (repo=phantom): refer RQ-WORK-Z (size<=0)\n')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-WORK-AB', 'RQ-WORK-A', 'RQ-WORK-Z'])

    def test_equal_size_uses_prompt_path_as_final_launch_tiebreaker(self):
        home, env = self.fixture()
        queue_job(home, 'RQ-WORK-A', 'codex-cmp', size=20)
        queue_job(home, 'RQ-WORK-Z', 'codex-cmp', size=20)
        q = home / '.ashlr-runs/queue'
        lines = []
        for line, filename in zip(ready_lines(home), ['z-prompt.md', 'a-prompt.md']):
            fields = line.split('\t')
            renamed = q / 'prompts' / filename
            Path(fields[4]).rename(renamed)
            fields[4] = str(renamed)
            lines.append('\t'.join(fields))
        (q / 'ready.tsv').write_text('\n'.join(lines) + '\n')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-WORK-Z', 'RQ-WORK-A'])

    def test_size_hint_falls_back_to_actual_arbitrary_prompt_path(self):
        home, env = self.fixture()
        queue_job(home, 'RQ-WORK-A', 'codex-cmp', size=100)
        queue_job(home, 'RQ-WORK-Z', 'codex-cmp')
        q = home / '.ashlr-runs/queue'
        lines = ready_lines(home)
        fields = lines[-1].split('\t')
        custom = q / 'prompts/arbitrary-task.md'
        Path(fields[4]).rename(custom)
        custom.write_text('Job RQ-WORK-Z (pool codex-cmp, tier work, repo phantom).\n\n'
                          'RQ-WORK-Z (repo=phantom, size<=20): fixture\n')
        fields[4] = str(custom)
        lines[-1] = '\t'.join(fields)
        (q / 'ready.tsv').write_text('\n'.join(lines) + '\n')
        (q / 'router-queue.md').write_text('- READY RQ-WORK-A (size<=100): fixture\n')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-WORK-Z', 'RQ-WORK-A'])

    def test_size_hint_accepts_optional_router_revision(self):
        home, env = self.fixture()
        queue_job(home, 'RQ-WORK-A', 'codex-cmp', size=100)
        queue_job(home, 'RQ-WORK-Z', 'codex-cmp')
        q = home / '.ashlr-runs/queue'
        (q / 'router-queue.md').write_text('- READY RQ-WORK-A (size<=100): fixture\n'
                                          '- READY RQ-WORK-Z r2 (size<=20): fixture\n')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-WORK-Z', 'RQ-WORK-A'])

    def test_same_repo_fix_main_cap_spans_lanes_and_does_not_block_other_work(self):
        home, env = self.fixture(('codex-cmp', 'codex-personal'))
        queue_job(home, 'RQ-FIX-MAIN-A', 'codex-cmp')
        queue_job(home, 'RQ-FIX-MAIN-B', 'codex-personal')
        queue_job(home, 'RQ-ORDINARY', 'codex-personal')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-FIX-MAIN-A', 'RQ-ORDINARY'])
        self.assertEqual([line.split('\t')[0] for line in ready_lines(home)], ['RQ-FIX-MAIN-B'])
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-FIX-MAIN-A', 'RQ-ORDINARY'])
        self.assertIn('RQ-FIX-MAIN-B', ready_lines(home)[0])

    def test_fix_main_cap_is_per_repo(self):
        home, env = self.fixture()
        queue_job(home, 'RQ-FIX-MAIN-A', 'codex-cmp', repo='phantom')
        queue_job(home, 'RQ-FIX-MAIN-B', 'codex-cmp', repo='locus')
        queue_job(home, 'RQ-FIX-MAIN-C', 'codex-cmp', repo='phantom')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-FIX-MAIN-A', 'RQ-FIX-MAIN-B'])
        self.assertEqual([line.split('\t')[0] for line in ready_lines(home)], ['RQ-FIX-MAIN-C'])

    def test_refix_drains_serialize_per_pr_and_skip_empty_duplicates(self):
        home, env = self.fixture(('codex-cmp', 'codex-personal'))
        empty = 'RQ-DRAIN-phantom-7-aaaaaaa'
        (home / '.ashlr-runs' / f'{empty}.publish').write_text('RESULT EMPTY\n')
        for job, lane, repo in [(empty, 'codex-cmp', 'phantom'),
                                ('RQ-DRAIN-phantom-8-aaaaaaa', 'codex-cmp', 'phantom'),
                                ('RQ-DRAIN-phantom-8-bbbbbbb', 'codex-personal', 'phantom'),
                                ('RQ-DRAIN-phantom-9-aaaaaaa', 'codex-personal', 'phantom'),
                                ('RQ-DRAIN-locus-8-aaaaaaa', 'codex-personal', 'locus'),
                                ('RQ-ORDINARY', 'codex-personal', 'phantom')]:
            queue_job(home, job, lane, repo=repo)
        queue_job(home, empty, 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(set(self.claims(home)), {'RQ-DRAIN-phantom-8-aaaaaaa',
                         'RQ-DRAIN-phantom-9-aaaaaaa', 'RQ-DRAIN-locus-8-aaaaaaa', 'RQ-ORDINARY'})
        self.assertEqual([line.split('\t')[0] for line in ready_lines(home)], ['RQ-DRAIN-phantom-8-bbbbbbb'])

    def test_active_refix_reservation_releases_after_terminal_result(self):
        home, env = self.fixture()
        active = 'RQ-DRAIN-phantom-8-aaaaaaa'
        r = self.active_fix(home, job=active)
        queue_job(home, 'RQ-DRAIN-phantom-8-bbbbbbb', 'codex-cmp')
        queue_job(home, 'RQ-ORDINARY', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-ORDINARY'])
        (r / f'{active}.publish').write_text('RESULT EMPTY\n')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-ORDINARY', 'RQ-DRAIN-phantom-8-bbbbbbb'])

    def active_fix(self, home, job='RQ-FIX-MAIN-A', line=True, base=True):
        r = home / '.ashlr-runs'
        if line:
            (r / 'queue/run' / f'{job}.line').write_text(f'{job}\tphantom\tcodex-cmp\twork\tunused\n')
        if base:
            wt = home / 'Projects/ashlrai/wt' / job
            wt.mkdir()
            (r / f'{job}.base').write_text(f'deadbeef phantom {wt} codex-cmp\n')
            (r / f'{job}.log').write_text('fixture running\n')
        return r

    def test_active_process_blocks_fix_main_using_base_repo_without_saved_line(self):
        home, env = self.fixture()
        self.active_fix(home, line=False)
        (home / 'stubbin/ps').write_text('#!/bin/sh\necho "123 launch.sh RQ-FIX-MAIN-A phantom"\n')
        queue_job(home, 'RQ-FIX-MAIN-B', 'codex-cmp')
        queue_job(home, 'RQ-OTHER', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-OTHER'])
        self.assertIn('RQ-FIX-MAIN-B', ready_lines(home)[0])

    def test_launch_grace_blocks_fix_main_before_base_exists(self):
        home, env = self.fixture()
        r = self.active_fix(home, base=False)
        (r / 'queue/run/RQ-FIX-MAIN-A.dispatched').write_text(str(int(time.time())))
        queue_job(home, 'RQ-FIX-MAIN-B', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), [])
        self.assertIn('RQ-FIX-MAIN-B', ready_lines(home)[0])

    def test_recent_worker_without_visible_process_reserves_fix_main_repo(self):
        home, env = self.fixture()
        self.active_fix(home)
        queue_job(home, 'RQ-FIX-MAIN-B', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), [])

    def test_failed_process_snapshot_cannot_release_fix_main_reservation(self):
        for has_base in (True, False):
            with self.subTest(has_base=has_base):
                home, env = self.fixture()
                r = self.active_fix(home, base=has_base)
                if has_base:
                    paths = (r / 'RQ-FIX-MAIN-A.base', r / 'RQ-FIX-MAIN-A.log')
                else:
                    receipt = r / 'queue/run/RQ-FIX-MAIN-A.dispatched'
                    receipt.write_text('0')
                    paths = (receipt,)
                for path in paths:
                    old = time.time() - 600
                    os.utime(path, (old, old))
                (home / 'stubbin/ps').write_text('#!/bin/sh\nexit 1\n')
                (r / 'PUBLISH_HOLD').write_text('fixture hold')
                queue_job(home, 'RQ-FIX-MAIN-B', 'codex-cmp')
                queue_job(home, 'RQ-OTHER', 'codex-cmp')
                self.run_tick(home, env)
                # Unknown global ownership stops the entire tick, including unrelated launches.
                self.assertEqual(self.claims(home), [])
                self.assertEqual([line.split('\t')[0] for line in ready_lines(home)], ['RQ-FIX-MAIN-B', 'RQ-OTHER'])
                self.assertFalse(json.loads((r / 'queue/process-snapshot.json').read_text())['known'])
                (r / 'queue/run/RQ-FIX-MAIN-A.rc').write_text('0\n')
                self.run_tick(home, env)
                self.assertEqual(self.claims(home), [])
                # Once process inspection is healthy, explicit completion releases the repo.
                (home / 'stubbin/ps').write_text('#!/bin/sh\necho "1000 /usr/bin/idle"\n')
                self.run_tick(home, env)
                self.assertEqual(self.claims(home), ['RQ-FIX-MAIN-B', 'RQ-OTHER'])

    def test_deferred_launch_does_not_reserve_repo_forever(self):
        home, env = self.fixture()
        r = self.active_fix(home, base=False)
        receipt = r / 'queue/run/RQ-FIX-MAIN-A.dispatched'
        receipt.write_text('0')
        old = time.time() - 600
        os.utime(receipt, (old, old))
        (r / 'RQ-FIX-MAIN-A.launch').write_text('HELD: fixture provider hold\n')
        queue_job(home, 'RQ-FIX-MAIN-B', 'codex-cmp')
        self.run_tick(home, env)
        self.assertEqual(self.claims(home), ['RQ-FIX-MAIN-B'])
        self.assertFalse(receipt.exists())

    def test_completed_worker_releases_cap_before_publish(self):
        for evidence in ('rc', 'result'):
            with self.subTest(evidence=evidence):
                home, env = self.fixture()
                r = self.active_fix(home)
                if evidence == 'rc':
                    (r / 'queue/run/RQ-FIX-MAIN-A.rc').write_text('0\n')
                else:
                    (r / 'RQ-FIX-MAIN-A.publish').write_text('RESULT EMPTY\n')
                (r / 'PUBLISH_HOLD').write_text('fixture hold')
                queue_job(home, 'RQ-FIX-MAIN-B', 'codex-cmp')
                self.run_tick(home, env)
                self.assertEqual(self.claims(home), ['RQ-FIX-MAIN-B'])

    def finished_worktree(self, home, job, repo='phantom', size=None):
        queue_job(home, job, 'codex-cmp', repo=repo, size=size)
        r = home / '.ashlr-runs'
        q = r / 'queue'
        ready = ready_lines(home)
        (q / 'run' / f'{job}.line').write_text(ready[-1] + '\n')
        (q / 'ready.tsv').write_text('\n'.join(ready[:-1]) + ('\n' if ready[:-1] else ''))
        wt = home / 'Projects/ashlrai/wt' / job
        wt.mkdir()
        for path, content in [(r / f'{job}.base', f'deadbeef {repo} {wt} codex-cmp\n'),
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

    def published(self, home, count):
        path = home / '.ashlr-runs/publish-order'
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            rows = path.read_text().splitlines() if path.exists() else []
            if len(rows) >= count:
                return rows
            time.sleep(0.01)
        self.fail(f'publisher did not finish {count} handoffs')

    def test_publish_handoffs_follow_bucket_repo_size_and_path_order(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        jobs = [('RQ-OTHER', 'phantom', 1), ('RQ-DESK-Z', 'locus', 1),
                ('RQ-DESK-B', 'phantom', 100), ('RQ-DESK-Z2', 'phantom', 20),
                ('RQ-DESK-A', 'phantom', 20), ('RQ-REL-Z', 'locus', 500),
                ('RQ-FIX-MAIN-Z', 'phantom', 900)]
        for job, repo, size in jobs:
            self.finished_worktree(home, job, repo, size)
        expected = ['RQ-FIX-MAIN-Z', 'RQ-REL-Z', 'RQ-DESK-A', 'RQ-DESK-Z2',
                    'RQ-DESK-B', 'RQ-DESK-Z', 'RQ-OTHER']
        for count in range(1, len(expected) + 1):
            result = self.run_tick(home, env)
            reaps = [line.split('REAP ')[1].split()[0] for line in result.stdout.splitlines() if 'REAP ' in line]
            self.assertEqual(reaps, [expected[count - 1]], result.stdout)
            self.assertEqual(self.published(home, count), expected[:count])

    def test_existing_reap_holds_next_publish_handoff(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        self.finished_worktree(home, 'RQ-DESK-A')
        (home / '.ashlr-runs/queue/run/RQ-EXISTING.reaping').mkdir()
        result = self.run_tick(home, env)
        self.assertNotIn('REAP ', result.stdout)
        self.assertFalse((home / '.ashlr-runs/publish-order').exists())

    def test_merged_job_is_not_republished_when_base_survives(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        job = 'RQ-LOCUSMCPLEAKQ7'
        self.finished_worktree(home, job)
        ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
        url = f'https://example.invalid/{job}'
        with ledger.open('a') as f:
            for row in [fin(job), pub(job), {'event': 'outcome', 'url': url, 'state': 'MERGED'}]:
                f.write(json.dumps(row) + '\n')
        for _ in range(2):
            self.assertNotIn('REAP ' + job, self.run_tick(home, env).stdout)
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        self.assertEqual(sum(r.get('event') == 'finish' and r.get('job') == job for r in rows), 1)
        self.assertEqual(sum(r.get('event') == 'outcome' and r.get('state') == 'MERGED' for r in rows), 1)
        self.assertFalse((home / '.ashlr-runs/publish-order').exists())

    def test_reconciled_merge_survives_repeated_ticks_and_restart(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        job = 'RQ-RECONCILED'
        self.finished_worktree(home, job)
        ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
        url = 'https://github.com/ashlrai/phantom/pull/101'
        ledger.write_text(json.dumps({'jobId': job, 'prUrl': url, 'outcome': 'PUBLISHED'}) + '\n')
        loader = importlib.machinery.SourceFileLoader('reconcile_fixture', str(SCRIPT.parent / 'metrics-outcomes'))
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
        loader.exec_module(module)
        lookup = lambda _: {'state': 'MERGED', 'mergedAt': '2026-10-25T19:00:00Z'}
        self.assertEqual(module.reconcile(ledger, lookup), (1, 0))
        for _ in range(3):  # each tick starts a fresh dispatcher process
            self.assertNotIn('REAP ' + job, self.run_tick(home, env).stdout)
        self.assertEqual(module.reconcile(ledger, lookup), (0, 0))
        self.assertFalse((home / '.ashlr-runs/publish-order').exists())
        with ledger.open('a') as f:
            f.write(json.dumps({'event': 'launch', 'job': job}) + '\n')
        self.assertIn('REAP ' + job, self.run_tick(home, env).stdout)
        self.assertEqual(self.published(home, 1), [job])

    def test_reconciled_published_event_matches_pr_across_restarts(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        job = 'RQ-LOCUSMCPLEAKQ7'
        self.finished_worktree(home, job)
        ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
        url = 'https://github.com/ashlrai/phantom/pull/101'
        published = {'event': 'publish', 'jobId': job, 'prUrl': url + '/', 'outcome': 'PUBLISHED'}
        ledger.write_text(json.dumps(published) + '\n')
        loader = importlib.machinery.SourceFileLoader('reconcile_event_fixture', str(SCRIPT.parent / 'metrics-outcomes'))
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
        loader.exec_module(module)
        self.assertEqual(module.reconcile(ledger, lambda _: {'state': 'MERGED', 'mergedAt': '2026-10-25T19:00:00Z'}), (1, 0))
        for _ in range(3):
            self.assertNotIn('REAP ' + job, self.run_tick(home, env).stdout)
        self.assertFalse((home / '.ashlr-runs/publish-order').exists())

    def test_late_old_pr_completion_does_not_complete_new_attempt(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        job = 'RQ-RETRY-LATE'
        self.finished_worktree(home, job)
        ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
        old = 'https://github.com/ashlrai/phantom/pull/101'
        rows = [
            {'event': 'launch', 'job': job},
            {'event': 'publish', 'jobId': job, 'prUrl': old, 'outcome': 'PUBLISHED'},
            {'event': 'launch', 'job': job},
            {'event': 'publish', 'job': job, 'url': 'https://github.com/ashlrai/phantom/pull/102'},
            {'event': 'publish', 'jobId': job, 'prUrl': old, 'outcome': 'MERGED', 'source': 'metrics-outcomes-reconciler'},
        ]
        ledger.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        self.assertIn('REAP ' + job, self.run_tick(home, env).stdout)
        self.assertEqual(self.published(home, 1), [job])

    def test_retry_records_finish_once_and_new_launch_resets_attempt(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        job = 'RQ-RETRY'
        self.finished_worktree(home, job)
        root = home / '.ashlr-runs'
        reap = root / 'bin/reap-one.sh'
        reap.write_text('#!/bin/sh\nrmdir "$HOME/.ashlr-runs/queue/run/$1.reaping"\n')
        for _ in range(2):
            self.assertIn('REAP ' + job, self.run_tick(home, env).stdout)
            deadline = time.monotonic() + 3
            while (root / 'queue/run' / f'{job}.reaping').exists() and time.monotonic() < deadline:
                time.sleep(0.01)
        ledger = root / 'metrics/jobs.jsonl'
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        self.assertEqual(sum(r.get('event') == 'finish' and r.get('job') == job for r in rows), 1)
        with ledger.open('a') as f:
            f.write(json.dumps({'event': 'launch', 'job': job}) + '\n')
        self.assertIn('REAP ' + job, self.run_tick(home, env).stdout)
        rows = [json.loads(line) for line in ledger.read_text().splitlines()]
        self.assertEqual(sum(r.get('event') == 'finish' and r.get('job') == job for r in rows), 2)

    def test_stale_orphan_reap_marker_does_not_block_other_publishers(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        self.finished_worktree(home, 'RQ-DESK-A')
        marker = home / '.ashlr-runs/queue/run/RQ-ORPHAN.reaping'
        marker.mkdir()
        old = time.time() - 600
        os.utime(marker, (old, old))
        result = self.run_tick(home, env)
        self.assertIn('REAP RQ-DESK-A ', result.stdout)
        self.assertEqual(self.published(home, 1), ['RQ-DESK-A'])
        self.assertTrue(marker.exists())

    def test_publisher_without_base_holds_next_publish_handoff(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        self.finished_worktree(home, 'RQ-DESK-A')
        (home / 'stubbin/ps').write_text('#!/bin/sh\necho "123 publish.sh RQ-EXISTING"\n')
        result = self.run_tick(home, env)
        self.assertNotIn('REAP ', result.stdout)
        self.assertFalse((home / '.ashlr-runs/publish-order').exists())

    def test_landonly_still_allows_land_fixup_and_recut_after_bucket_shift(self):
        home, env = self.fixture(())
        self.publish_stubs(home)
        (home / '.ashlr-runs/PUBLISH_LANDONLY').write_text('')
        for job in ['LAND-A', 'FIXUP-B', 'RECUT-C', 'RQ-OTHER']:
            self.finished_worktree(home, job)
        for count, job in enumerate(['FIXUP-B', 'LAND-A', 'RECUT-C'], start=1):
            self.run_tick(home, env)
            self.assertEqual(self.published(home, count)[-1], job)
        result = self.run_tick(home, env)
        self.assertNotIn('REAP ', result.stdout)


class EmptyGateIntegrationTests(unittest.TestCase):
    fixture = QueueWaitTests.fixture
    metrics = QueueWaitTests.metrics
    def test_same_base_empty_is_dropped_without_model_launch(self):
        home, env = self.fixture(['codex-cmp'])
        repo = home / 'Projects/ashlrai/phantom'
        for args in (['init'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                                'commit', '--allow-empty', '-m', 'base'],
                     ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
                     ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']):
            subprocess.run(['git', '-C', str(repo)] + args, check=True, capture_output=True)
        job = 'RQ-UPKEEP-REL-TEST'
        queue_job(home, job, 'codex-cmp')
        sha = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
        ledger = home / '.ashlr-runs/metrics/jobs.jsonl'
        ledger.write_text(json.dumps(dict(event='claim', job=job, repo='phantom', base_sha=sha)) + '\n' +
                          json.dumps(dict(event='finish', job=job, empty=True, exit_code=0)) + '\n')
        result = tick(home, env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(ready_lines(home), [])
        rows = self.metrics(home)
        self.assertEqual(sum(r['event'] == 'skipped_empty' for r in rows), 1)
        self.assertFalse(any(r['event'] == 'launch' for r in rows))


if __name__ == '__main__':
    unittest.main()


class DiffMetricsTests(unittest.TestCase):
    def measure(self, scenario, base_override=None, lane='codex-cmp', log='finished\n', rc=None):
        tmp = build(slots=held_lanes())
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        job = 'RQ-DIFF-METRICS'
        wt = home / 'Projects/ashlrai/wt' / job
        wt.mkdir()
        other = home / 'Projects/ashlrai/wt' / 'other-repo'
        other.mkdir()
        subprocess.run(['git', '-C', str(other), 'init', '-q'], check=True, capture_output=True)
        for i in range(30): (other / f'unrelated-{i}').write_text('unrelated\n')
        def git(*args):
            return subprocess.run(['git', '-C', str(wt), *args], check=True, capture_output=True, text=True).stdout.strip()
        git('init', '-q')
        git('config', 'user.name', 'Fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        for i in range(30): (wt / f'prior-{i}').write_text('old\n')
        (wt / 'job-file').write_text('before\n')
        git('add', '.')
        git('commit', '-qm', 'earlier repository work')
        base = base_override or git('rev-parse', 'HEAD')
        scenario(wt, git)
        r = home / '.ashlr-runs'
        for path, content in [(r / f'{job}.base', f'{base} phantom {wt} {lane}\n'),
                              (r / f'{job}.log', log)]:
            path.write_text(content)
            os.utime(path, (time.time() - 600, time.time() - 600))
        if rc is not None: (r / 'queue/run' / f'{job}.rc').write_text(str(rc))
        (r / 'bin/reap-one.sh').write_text('#!/bin/sh\nexit 0\n')
        (r / 'phantom-open-prs').write_text(f'{int(time.time())} 0\n')
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        rows = [json.loads(line) for line in (r / 'metrics/jobs.jsonl').read_text().splitlines()]
        return next(row for row in rows if row.get('event') == 'finish' and row.get('job') == job)

    def write_sessions_db(self, home, sessions):
        """A minimal devin-cli sessions.db: the columns dispatchd reads, nothing more."""
        d = home / '.local/share/devin/cli'; d.mkdir(parents=True, exist_ok=True)
        con = sqlite3.connect(str(d / 'sessions.db'))
        con.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, metadata TEXT)')
        con.execute('CREATE TABLE message_nodes (node_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, chat_message TEXT NOT NULL)')
        for s in sessions:
            con.execute('INSERT INTO sessions (id, working_directory, metadata) VALUES (?,?,?)',
                        (s['id'], s['wd'], json.dumps(s.get('meta', {}))))
            for msg in s['messages']:
                con.execute('INSERT INTO message_nodes (session_id, chat_message) VALUES (?,?)',
                            (s['id'], json.dumps(msg)))
        con.commit(); con.close()

    def test_claude_result_usage_is_recorded_once(self):
        transcript = '\n'.join(json.dumps(row) for row in [
            {'type': 'assistant', 'message': {'usage': {'input_tokens': 999}}},
            {'type': 'result', 'usage': {'input_tokens': 10, 'output_tokens': 5,
             'cache_read_input_tokens': 20, 'cache_creation_input_tokens': 3}},
        ])
        row = self.measure(lambda wt, git: None, lane='claude', log=transcript)
        self.assertEqual([row[k] for k in ('tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write', 'tokens_total')],
                         [33, 5, 20, 3, 38])
        self.assertEqual(row['usage_source'], 'claude-result-json')
        self.assertIsNone(row['usage_missing'])
        self.assertIsNone(row['acus'])

    def test_claude_missing_and_invalid_usage_remains_unknown(self):
        row = self.measure(lambda wt, git: None, lane='claude', log='plain output')
        self.assertIsNone(row['tokens_total'])
        self.assertEqual(row['usage_missing'], 'claude-result-not-in-log')
        row = self.measure(lambda wt, git: None, lane='claude', log=json.dumps({'type': 'result', 'usage': {
                'input_tokens': 0, 'output_tokens': 0, 'cache_read_input_tokens': -1}}))
        self.assertIsNone(row['tokens_total'])
        self.assertIsNone(row['tokens_in'])
        self.assertIsNone(row['tokens_cache_read'])
        self.assertEqual(row['tokens_out'], 0)
        self.assertEqual(row['usage_missing'], 'claude-usage-incomplete')

    def test_devin_session_usage_records_tokens_and_acus(self):
        def scenario(wt, git):
            wd = os.path.realpath(str(wt))   # the CLI stores the resolved worktree path
            self.write_sessions_db(wt.parents[3], [
                {'id': 'devin-s1', 'wd': wd, 'meta': {'total_acu_cost': 0.75, 'total_credit_cost': 0}, 'messages': [
                    {'role': 'user', 'metadata': {'is_user_input': True}},
                    # the CLI stores every response twice; request_id dedupes
                    {'role': 'assistant', 'metadata': {'request_id': 'req-1', 'metrics': {
                        'input_tokens': 12910, 'output_tokens': 27, 'cache_read_tokens': 2368, 'cache_creation_tokens': None}}},
                    {'role': 'assistant', 'metadata': {'request_id': 'req-1', 'metrics': {
                        'input_tokens': 12910, 'output_tokens': 27, 'cache_read_tokens': 2368, 'cache_creation_tokens': None}}},
                ]},
                {'id': 'devin-s2', 'wd': wd, 'meta': {'total_acu_cost': 1.5}, 'messages': [
                    {'role': 'assistant', 'metadata': {'request_id': 'req-2', 'metrics': {
                        'input_tokens': 50, 'output_tokens': 5, 'cache_read_tokens': 10}}},
                ]},
                {'id': 'devin-foreign', 'wd': '/elsewhere', 'meta': {'total_acu_cost': 99}, 'messages': [
                    {'role': 'assistant', 'metadata': {'request_id': 'req-9', 'metrics': {'input_tokens': 1, 'output_tokens': 1}}},
                ]},
            ])
        row = self.measure(scenario, lane='devin')
        self.assertEqual([row[k] for k in ('tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_write', 'tokens_total')],
                         [15338, 32, 2378, 0, 15370])
        self.assertEqual(row['acus'], 2.25)
        self.assertEqual(row['usage_source'], 'devin-sessions-db')
        self.assertIsNone(row['usage_missing'])

    def test_devin_missing_usage_stays_null_with_reason(self):
        # No sessions.db on the host at all.
        row = self.measure(lambda wt, git: None, lane='devin')
        self.assertIsNone(row['tokens_total']); self.assertIsNone(row['acus'])
        self.assertEqual(row['usage_missing'], 'devin-session-db-missing')

        # A database that knows other worktrees but not this job's.
        row = self.measure(lambda wt, git: self.write_sessions_db(wt.parents[3], [
            {'id': 'devin-foreign', 'wd': '/elsewhere', 'meta': {'total_acu_cost': 1}, 'messages': []}]), lane='devin')
        self.assertIsNone(row['tokens_total']); self.assertIsNone(row['acus'])
        self.assertEqual(row['usage_missing'], 'devin-no-session-for-worktree')

        # A session that ended before any served response: ACUs still settle.
        def no_response(wt, git):
            self.write_sessions_db(wt.parents[3], [
                {'id': 'devin-s1', 'wd': os.path.realpath(str(wt)), 'meta': {'total_acu_cost': 0.5}, 'messages': [
                    {'role': 'user', 'metadata': {'is_user_input': True}}]}])
        row = self.measure(no_response, lane='devin')
        self.assertIsNone(row['tokens_total'])
        self.assertEqual(row['acus'], 0.5)
        self.assertEqual(row['usage_missing'], 'devin-usage-not-reported')

        # A served response without metrics: the token total is unknowable, not zero.
        def unmeasured(wt, git):
            self.write_sessions_db(wt.parents[3], [
                {'id': 'devin-s1', 'wd': os.path.realpath(str(wt)), 'meta': {'total_acu_cost': 0.5}, 'messages': [
                    {'role': 'assistant', 'metadata': {'request_id': 'req-1', 'metrics': None}}]}])
        row = self.measure(unmeasured, lane='devin')
        self.assertIsNone(row['tokens_total']); self.assertIsNone(row['tokens_in'])
        self.assertEqual(row['acus'], 0.5)
        self.assertEqual(row['usage_missing'], 'devin-usage-incomplete')

        # Other lanes keep the 'tokens used' line; its absence is named too.
        row = self.measure(lambda wt, git: None, lane='codex-cmp')
        self.assertIsNone(row['tokens_total'])
        self.assertEqual(row['usage_missing'], 'tokens-line-not-in-log')

    def test_devin_tokens_line_fallback(self):
        # sessions.db absent but the log still carries a 'tokens used' line.
        row = self.measure(lambda wt, git: None, lane='devin', log='output\ntokens used\n 12,345\n')
        self.assertEqual(row['tokens_total'], 12345)
        self.assertEqual(row['usage_source'], 'tokens-line')
        self.assertIsNone(row['usage_missing'])

    def test_committed_job_diff_excludes_prior_repository_work(self):
        def scenario(wt, git):
            (wt / 'job-file').write_text('after\n')
            git('add', '.')
            git('commit', '-qm', 'job change')
        row = self.measure(scenario)
        self.assertEqual((row['diff_files'], row['diff_lines'], row['empty']), (1, 2, False))

    def test_zero_line_mode_change_and_empty_tree(self):
        row = self.measure(lambda wt, git: (wt / 'job-file').chmod(0o755))
        self.assertEqual((row['diff_files'], row['diff_lines'], row['empty']), (1, 0, False))
        row = self.measure(lambda wt, git: (wt / 'BRIDGE_NOTES.md').write_text('notes\n'))
        self.assertEqual((row['diff_files'], row['diff_lines'], row['empty']), (0, 0, True))

    def test_untracked_and_binary_lines_are_unavailable(self):
        row = self.measure(lambda wt, git: (wt / 'new-file').write_text('new\n'))
        self.assertEqual((row['diff_files'], row['diff_lines'], row['empty']), (1, None, False))
        row = self.measure(lambda wt, git: (wt / 'job-file').write_bytes(b'\x00binary'))
        self.assertEqual((row['diff_files'], row['diff_lines'], row['empty']), (1, None, False))

    def test_missing_base_records_unknown_instead_of_zero(self):
        row = self.measure(lambda wt, git: None, base_override='0' * 40)
        self.assertEqual((row['diff_files'], row['diff_lines'], row['empty']), (None, None, None))

    def test_devin_failure_labels_do_not_copy_log_contents(self):
        for log, expected in [('ERROR: 401 Unauthorized private-value\n', 'authentication'),
                              ('ERROR: ACU limit reached private-value\n', 'quota'),
                              ('private-value\n', 'failed_empty_unknown')]:
            with self.subTest(expected=expected):
                row = self.measure(lambda wt, git: None, lane='devin', log=log, rc=1)
                self.assertEqual(row['failure_class'], expected)
                self.assertNotIn('private-value', json.dumps(row))
        row = self.measure(lambda wt, git: (wt / 'job-file').write_text('work'), lane='devin', rc=1)
        self.assertEqual(row['failure_class'], 'failed_with_work')


class SnapshotSafetyTests(unittest.TestCase):
    def preserved_fixture(self, lane='codex-cmp'):
        tmp = build(slots=held_lanes())
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        job = 'RQ-PRESERVE-ACTIVE'
        root = home / '.ashlr-runs'
        wt = home / 'Projects' / 'ashlrai' / 'wt' / job
        wt.mkdir()
        (wt / 'unique-work.txt').write_text('must survive unknown process ownership')
        (root / (job + '.base')).write_text(f'deadbeef branch {wt} {lane}\n')
        (root / (job + '.log')).write_text('existing work\n')
        old = time.time() - 1000
        os.utime(root / (job + '.base'), (old, old))
        os.utime(root / (job + '.log'), (old, old))
        queue_job(home, 'RQ-NEXT', 'codex-cmp')
        return home, root, wt

    def assert_preserved(self, home, root, wt, ready):
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads((root / 'queue/process-snapshot.json').read_text())['known'])
        self.assertEqual((root / 'queue/ready.tsv').read_text(), ready)
        self.assertEqual((wt / 'unique-work.txt').read_text(), 'must survive unknown process ownership')
        self.assertFalse((root / 'queue/run/RQ-PRESERVE-ACTIVE.reaping').exists())
        self.assertFalse(dispatched(home, 'RQ-NEXT'))
        self.assertNotIn('REAP ', events(home))
        self.assertNotIn('LAUNCH ', events(home))

    def test_unknown_process_inventory_preserves_workers_and_claims(self):
        home, root, wt = self.preserved_fixture()
        (home / 'stubbin/ps').write_text('#!/bin/bash\nexit 124\n')
        self.assert_preserved(home, root, wt, (root / 'queue/ready.tsv').read_text())

    def test_failed_cwd_inspection_preserves_argumentless_claude_worker(self):
        home, root, wt = self.preserved_fixture('claude')
        (home / 'stubbin/lsof').write_text('#!/bin/bash\nexit 124\n')
        self.assert_preserved(home, root, wt, (root / 'queue/ready.tsv').read_text())


class VerifiedCompletionTests(unittest.TestCase):
    """RQ-SWE5-VERIFY-METRIC: status.json verified_completion block — independently
    reconciled PR outcomes vs completion claims, plus coordination failures."""

    @staticmethod
    def ts(offset_s=0):
        return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(time.time() + offset_s))

    @staticmethod
    def pr(n, repo='ashlrai/phantom'):
        return f'https://github.com/{repo}/pull/{n}'

    def vc(self, home):
        status = json.loads((home / '.ashlr-runs' / 'queue' / 'status.json').read_text())
        return status['verified_completion']

    def run_tick(self, rows):
        tmp = build(slots=held_lanes(), finishes=[], publishes=[])
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name).resolve()
        ledger = home / '.ashlr-runs' / 'metrics' / 'jobs.jsonl'
        ledger.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        result = tick(home)
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.vc(home)

    def test_empty_ledger_reports_healthy_zero_claims(self):
        vc = self.run_tick([])
        self.assertEqual(vc['schema'], 'dispatchd.verified-completion.v1')
        self.assertEqual(vc['window_hours'], 24)
        self.assertEqual(vc['source_state'], 'healthy')
        self.assertEqual(vc['eligible'], 0)
        self.assertIsNone(vc['rate'])
        self.assertEqual(vc['claims'], {'published': 0, 'batch_members': 0, 'outcomes': 0})

    def test_eventless_producer_and_reconciler_rows_verify_a_merge(self):
        pr = self.pr(501)
        rows = [
            {'event': 'launch', 'job': 'RQ-VC-1', 'lane': 'devin', 'repo': 'phantom', 'ts': self.ts(-60)},
            {'event': 'finish', 'job': 'RQ-VC-1', 'exit_code': 0, 'empty': False, 'ts': self.ts(-50)},
            {'jobId': 'RQ-VC-1', 'prUrl': pr, 'outcome': 'PUBLISHED', 'ts': self.ts(-40), 'lane': 'devin'},
            {'jobId': 'RQ-VC-1', 'prUrl': pr, 'outcome': 'MERGED', 'ts': self.ts(-30),
             'mergedAt': self.ts(-30), 'source': 'metrics-outcomes-reconciler'},
        ]
        vc = self.run_tick(rows)
        self.assertEqual(vc['eligible'], 1)
        self.assertEqual(vc['verified'], 1)
        self.assertEqual(vc['failed'], 0)
        self.assertEqual(vc['pending'], 0)
        self.assertEqual(vc['rate'], 1.0)
        self.assertEqual(vc['claims']['published'], 1)
        self.assertEqual(vc['by_lane']['devin'], {'eligible': 1, 'verified': 1, 'failed': 0, 'pending': 0})

    def test_closed_pr_is_a_false_completion(self):
        pr = self.pr(502)
        rows = [
            {'event': 'publish', 'job': 'RQ-VC-2', 'url': pr, 'lane': 'devin', 'ts': self.ts(-60)},
            {'event': 'outcome', 'job': 'RQ-VC-2', 'url': pr, 'state': 'CLOSED', 'ts': self.ts(-30)},
        ]
        vc = self.run_tick(rows)
        self.assertEqual(vc['eligible'], 1)
        self.assertEqual(vc['failed'], 1)
        self.assertEqual(vc['false_completions'], 1)
        self.assertEqual(vc['rate'], 0.0)
        self.assertEqual(vc['detail']['false_completion_jobs'], ['RQ-VC-2'])

    def test_publish_without_reconciled_outcome_stays_pending(self):
        rows = [{'event': 'publish', 'job': 'RQ-VC-3', 'url': self.pr(503), 'lane': 'devin', 'ts': self.ts(-60)}]
        vc = self.run_tick(rows)
        self.assertEqual(vc['eligible'], 1)
        self.assertEqual(vc['pending'], 1)
        self.assertIsNone(vc['rate'])

    def test_unpublished_nonempty_finish_is_not_a_claim(self):
        rows = [{'event': 'finish', 'job': 'RQ-VC-4', 'lane': 'devin', 'exit_code': 0, 'empty': False, 'ts': self.ts(-60)}]
        vc = self.run_tick(rows)
        self.assertEqual(vc['eligible'], 0)
        self.assertEqual(vc['completed_unpublished'], 1)

    def test_duplicates_and_unauthorized_actions_are_counted(self):
        shared = self.pr(510)
        rows = [
            {'event': 'claim', 'job': 'RQ-DUP-1', 'repo': 'phantom', 'lane': 'devin', 'ts': self.ts(-300)},
            {'event': 'publish', 'job': 'RQ-DUP-1', 'url': self.pr(511), 'ts': self.ts(-200)},
            {'event': 'publish', 'job': 'RQ-DUP-1', 'url': self.pr(512), 'ts': self.ts(-190)},
            {'event': 'claim', 'job': 'RQ-SHR-1', 'lane': 'devin', 'ts': self.ts(-300)},
            {'event': 'publish', 'job': 'RQ-SHR-1', 'url': shared, 'ts': self.ts(-200)},
            {'event': 'claim', 'job': 'RQ-SHR-2', 'lane': 'devin', 'ts': self.ts(-300)},
            {'event': 'publish', 'job': 'RQ-SHR-2', 'url': shared, 'ts': self.ts(-200)},
            {'event': 'claim', 'job': 'RQ-BAD-1', 'repo': 'phantom', 'lane': 'devin', 'ts': self.ts(-300)},
            {'event': 'publish', 'job': 'RQ-BAD-1', 'url': self.pr(513, 'ashlrai/lexicon'), 'ts': self.ts(-200)},
        ]
        vc = self.run_tick(rows)
        self.assertEqual(vc['eligible'], 4)
        self.assertEqual(vc['pending'], 4)
        self.assertEqual(vc['duplicates'], {'multi_pr_jobs': 1, 'shared_pr_urls': 1})
        self.assertEqual(vc['detail']['multi_pr_jobs'], ['RQ-DUP-1'])
        self.assertEqual(vc['unauthorized_actions'], 1)
        self.assertEqual(vc['detail']['unauthorized_jobs'], ['RQ-BAD-1'])

    def test_batch_member_done_verifies_through_batch_pr(self):
        pr = self.pr(520)
        rows = [
            {'event': 'batch_claim', 'job': 'RQ-MEM-1', 'batch': 'RQ-BATCH-phantom-t-1', 'repo': 'phantom',
             'lane': 'devin', 'ts': self.ts(-300)},
            {'event': 'task_outcome', 'job': 'RQ-MEM-1', 'batch': 'RQ-BATCH-phantom-t-1', 'lane': 'devin',
             'repo': 'phantom', 'outcome': 'done', 'ts': self.ts(-200)},
            {'event': 'launch', 'job': 'RQ-BATCH-phantom-t-1', 'lane': 'devin', 'repo': 'phantom', 'ts': self.ts(-290)},
            {'event': 'publish', 'job': 'RQ-BATCH-phantom-t-1', 'url': pr, 'ts': self.ts(-100)},
            {'jobId': 'RQ-BATCH-phantom-t-1', 'prUrl': pr, 'outcome': 'MERGED', 'ts': self.ts(-50),
             'source': 'metrics-outcomes-reconciler'},
        ]
        vc = self.run_tick(rows)
        self.assertEqual(vc['claims']['batch_members'], 1)
        self.assertEqual(vc['claims']['published'], 0)   # the batch session itself is infrastructure
        self.assertEqual(vc['eligible'], 1)
        self.assertEqual(vc['verified'], 1)
