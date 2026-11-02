"""Fixture tests for contrib/mac/dispatchd.py (RQ-DEVINROUTEDEFAULTQ7 /
DEVIN-LEVERAGE-20261026).

Every case builds a synthetic ~/.ashlr-runs tree in a temp HOME and invokes the
repo copy of dispatchd.py once (one tick) as a subprocess; nothing touches the
real ~/.ashlr-runs or the live queue. Covers: the leverage devin defaults
(target 10, ceiling 16), the ceiling raise cap, the Masbot 21:19 failure-spike
step-down computed in dispatchd itself (-2, floor 6, once per new finish), and
devin's place in the restock trigger loop.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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
    stub = home / 'stubbin' / 'ps'   # sandboxed runs cannot exec ps; empty output marks nothing alive
    stub.write_text('#!/bin/bash\nexit 0\n')
    stub.chmod(0o755)
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
    return tmp


def tick(home, env_extra=None):
    env = {'HOME': str(home),
           'PATH': str(Path(home) / 'stubbin') + ':' + os.environ.get('PATH', '/usr/bin:/bin'),
           'LANG': 'C'}
    if env_extra:
        env.update(env_extra)
    return subprocess.run([sys.executable, '-B', str(SCRIPT)], env=env,
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
    slot = {'target': 10, 'floor': 3, 'ceiling': 16, 'last_change': 0}
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


def queue_job(home, job, lane, tier='work'):
    """A valid ready.tsv line (prompt inside queue/prompts) plus its router-queue.md READY row."""
    q = home / '.ashlr-runs' / 'queue'
    pf = q / 'prompts' / f'{job}.md'
    pf.write_text('fixture prompt')
    with (q / 'ready.tsv').open('a') as f:
        f.write(f'{job}\tphantom\t{lane}\t{tier}\t{pf}\n')
    with (q / 'router-queue.md').open('a') as f:
        f.write(f'- READY {job} (pool={lane}): fixture\n')


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


class SlotDefaultTests(unittest.TestCase):
    def test_missing_devin_slot_seeds_leverage_defaults(self):
        # No devin entry in slots.json: the DEFAULT row seeds target 10, floor 3, ceiling 16.
        tmp = build(slots=held_lanes())
        self.addCleanup(tmp.cleanup)
        home = Path(tmp.name)
        slots = held_lanes()
        slots.pop('devin')
        (home / '.ashlr-runs' / 'queue' / 'slots.json').write_text(json.dumps(slots))
        r = tick(home)
        self.assertEqual(r.returncode, 0, r.stderr)
        devin = slots_of(home)['devin']
        self.assertEqual((devin['target'], devin['floor'], devin['ceiling']), (10, 3, 16), devin)


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


if __name__ == '__main__':
    unittest.main()
