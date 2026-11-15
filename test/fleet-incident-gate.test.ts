import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  advanceIncidentGateState,
  appendIncidentGateLedger,
  emptyIncidentGateState,
  evaluateIncidentGate,
  incidentGateLedgerPath,
  incidentGateStatePath,
  incidentJobKind,
  loadIncidentGateState,
  mineIncidentSignals,
  qualifyIncidentRepo,
  saveIncidentGateState,
  INCIDENT_LANE_HOLD_MINUTES,
  INCIDENT_REPO_COOLDOWN_MS,
  INCIDENT_WINDOW_MS,
  type IncidentSignal,
} from '../src/core/fleet/incident-gate.js';
import { cmdFleetIncidentGate, type IncidentGateCmdDeps } from '../src/cli/fleet-incident-gate.js';
import { LaneHoldError } from '../src/core/fleet/runs-lane-hold.js';
import type { RepoHoldChange, SetRepoHoldRequest } from '../src/core/fleet/fleet-types.js';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const row = (over: Record<string, unknown>) => JSON.stringify({ ts: iso(NOW - H), ...over });

const finish = (job: string, over: Record<string, unknown> = {}) =>
  row({ event: 'finish', job, lane: 'codex', repo: 'phantom', exit_code: 1, ...over });
const launch = (job: string, over: Record<string, unknown> = {}) =>
  row({ event: 'launch', job, repo: 'phantom', lane: 'codex', tier: 'work', ...over });
const closedOutcome = (jobId: string, n: number, over: Record<string, unknown> = {}) =>
  row({
    jobId, prUrl: `https://github.com/ashlrai/phantom/pull/${n}`, outcome: 'CLOSED',
    source: 'metrics-outcomes-reconciler', closedAt: iso(NOW - H), ...over,
  });

async function tmpDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('qualifyIncidentRepo', () => {
  it('keeps owner/name, resolves bare fleet names, lowercases, rejects junk', () => {
    expect(qualifyIncidentRepo('ashlrai/phantom')).toBe('ashlrai/phantom');
    expect(qualifyIncidentRepo('AshlrAI/Phantom')).toBe('ashlrai/phantom');
    expect(qualifyIncidentRepo('phantom')).toBe('ashlrai/phantom');
    expect(qualifyIncidentRepo('  locus  ')).toBe('ashlrai/locus');
    expect(qualifyIncidentRepo('not a repo')).toBeNull();
    expect(qualifyIncidentRepo('a/b/c')).toBeNull();
    expect(qualifyIncidentRepo(42)).toBeNull();
    expect(qualifyIncidentRepo('')).toBeNull();
  });
});

describe('incidentJobKind', () => {
  it('extracts the segment after an optional RQ- prefix', () => {
    expect(incidentJobKind('RQ-SWE5-INCIDENT-GATE')).toBe('SWE5');
    expect(incidentJobKind('RQ-AAA-1')).toBe('AAA');
    expect(incidentJobKind('LAND-9')).toBe('LAND');
    expect(incidentJobKind('x'.repeat(40))).toBe('x'.repeat(24));
  });
});

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

describe('mineIncidentSignals', () => {
  it('maps finish failures to lane-error and test-failure signals', () => {
    const jobs = [launch('RQ-AAA-1'), finish('RQ-AAA-1'), launch('RQ-AAA-2'), finish('RQ-AAA-2')];
    const mine = mineIncidentSignals({ jobs: jobs.join('\n'), nowMs: NOW });
    const lane = mine.signals.filter((s) => s.cls === 'lane-error');
    const test = mine.signals.filter((s) => s.cls === 'test-failure');
    expect(lane.map((s) => s.key)).toEqual(['lane-error:codex:exit-1', 'lane-error:codex:exit-1']);
    expect(test.map((s) => s.key)).toEqual([
      'test-failure:ashlrai/phantom:AAA:exit-1',
      'test-failure:ashlrai/phantom:AAA:exit-1',
    ]);
    expect(test[0]!.repo).toBe('ashlrai/phantom');
    expect(test[0]!.kind).toBe('AAA');
    expect(mine.observed).toBe(2);
    expect(mine.sources).toEqual({ jobs: 'read', events: 'missing' });
  });

  it('classifies pool_error, failure_class, empty-diff and exit codes', () => {
    const jobs = [
      finish('RQ-A-1', { pool_error: 'Rate Limit!! 429' }),
      finish('RQ-A-2', { failure_class: 'failed_empty_unknown' }),
      finish('RQ-A-3', { exit_code: 0, empty: true }),
      finish('RQ-A-4', { exit_code: 0, empty: false }),
    ].join('\n');
    const mine = mineIncidentSignals({ jobs, nowMs: NOW });
    const codes = mine.signals.filter((s) => s.cls === 'lane-error').map((s) => s.code).sort();
    expect(codes).toEqual(['class-failed_empty_unknown', 'empty-diff', 'pool-rate-limit-429']);
  });

  it('counts autobackoff, precheck and task_outcome rows; ignores successes', () => {
    const jobs = [
      row({ event: 'autobackoff_hold', job: 'RQ-B-1', lane: 'devin', pattern: 'devin_usage_limit', until: iso(NOW + H) }),
      row({ event: 'precheck_skip', job: 'RQ-C-9', repo: 'phantom', lane: 'codex', code: 13 }),
      row({ event: 'task_outcome', job: 'RQ-D-2', batch: 'B1', lane: 'codex', repo: 'phantom', outcome: 'failed' }),
      row({ event: 'task_outcome', job: 'RQ-D-3', batch: 'B1', lane: 'codex', repo: 'phantom', outcome: 'done' }),
      row({ event: 'task_outcome', job: 'RQ-D-4', batch: 'B1', lane: 'codex', repo: 'phantom', outcome: 'unreported' }),
    ].join('\n');
    const mine = mineIncidentSignals({ jobs, nowMs: NOW });
    const keys = mine.signals.map((s) => s.key);
    expect(keys).toContain('lane-error:devin:ab-devin_usage_limit');
    expect(keys).toContain('test-failure:ashlrai/phantom:C:precheck-13');
    expect(keys).toContain('lane-error:codex:task-failed');
    expect(keys).toContain('test-failure:ashlrai/phantom:D:task-failed');
    expect(keys.some((k) => k.includes('deferred') || k.includes('done') || k.includes('unreported'))).toBe(false);
    expect(mine.observed).toBe(3);
  });

  it('projects reconciler outcome rows and counts CLOSED-unmerged per repo', () => {
    const jobs = [
      closedOutcome('RQ-E-1', 101),
      closedOutcome('RQ-E-2', 102),
      // A publish-shaped row that kept event:'publish' still projects via source.
      closedOutcome('RQ-E-3', 103, { event: 'publish' }),
      row({ jobId: 'RQ-E-4', prUrl: 'https://github.com/ashlrai/phantom/pull/104', outcome: 'MERGED', source: 'metrics-outcomes-reconciler' }),
      row({ event: 'outcome', job: 'RQ-E-5', state: 'CLOSED', url: 'https://github.com/ashlrai/locus/pull/7' }),
    ].join('\n');
    const mine = mineIncidentSignals({ jobs, nowMs: NOW });
    const conflicts = mine.signals.filter((s) => s.cls === 'merge-conflict');
    expect(conflicts.map((s) => s.key).sort()).toEqual([
      'merge-conflict:ashlrai/locus',
      'merge-conflict:ashlrai/phantom',
      'merge-conflict:ashlrai/phantom',
      'merge-conflict:ashlrai/phantom',
    ]);
    expect(mine.observed).toBe(4);
  });

  it('reads dispatch-events.log AUTH/LAUNCH lines and joins LAUNCH_FAILED to the job lane', () => {
    const jobs = [launch('RQ-F-1', { lane: 'claude' })].join('\n');
    const events = [
      '2026-11-08 06:59:00 AUTH_FAILURE_SEEN claude RQ-F-1 claude_401: token expired',
      '2026-11-08 07:00:00 USAGE_LIMIT_SEEN devin RQ-F-2 devin_usage_limit',
      '2026-11-08 07:01:00 LAUNCH_FAILED RQ-F-1 (see RQ-F-1.launch)',
      '2026-11-08 07:02:00 LAUNCH_FAILED RQ-UNKNOWN-9 (see x)',
      '2026-11-08 07:03:00 ROUTE codex RQ-F-3',
      'not a timestamp line',
    ].join('\n');
    const mine = mineIncidentSignals({ jobs, events, nowMs: NOW });
    const keys = mine.signals.map((s) => s.key);
    expect(keys).toContain('lane-error:claude:event-auth-failure');
    expect(keys).toContain('lane-error:devin:event-usage-limit');
    // LAUNCH_FAILED joins through the job's launch row lane.
    expect(keys).toContain('lane-error:claude:event-launch-failed');
    expect(keys.filter((k) => k.includes('event-launch-failed'))).toHaveLength(1);
    expect(mine.observed).toBe(3);
  });

  it('excludes out-of-window rows but still uses them for lane/repo joins', () => {
    const old = iso(NOW - INCIDENT_WINDOW_MS - H);
    const jobs = [
      // The launch row is outside the window; the finish row is inside and
      // carries no lane/repo, so both must come from the join.
      row({ event: 'launch', job: 'RQ-G-2', repo: 'phantom', lane: 'codex', ts: old }),
      row({ event: 'finish', job: 'RQ-G-2', exit_code: 1 }),
      finish('RQ-G-3', { lane: 'claude', repo: 'locus', exit_code: 2 }),
    ].join('\n');
    const mine = mineIncidentSignals({ jobs, nowMs: NOW });
    expect(mine.signals.map((s) => s.key).sort()).toEqual([
      'lane-error:claude:exit-2',
      'lane-error:codex:exit-1',
      'test-failure:ashlrai/locus:G:exit-2',
      'test-failure:ashlrai/phantom:G:exit-1',
    ]);
    expect(mine.observed).toBe(2);
  });

  it('reports missing and degraded sources without treating them as zero', () => {
    const mine = mineIncidentSignals({ jobs: null, events: null, nowMs: NOW });
    expect(mine.sources).toEqual({ jobs: 'missing', events: 'missing' });
    const degraded = mineIncidentSignals({
      jobs: '', events: '', nowMs: NOW,
      sourceStates: { jobs: 'unreadable', events: 'read' },
    });
    expect(degraded.sources.jobs).toBe('unreadable');
  });
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const sig = (over: Partial<IncidentSignal>): IncidentSignal => ({
  at: NOW - H, cls: 'lane-error', key: 'lane-error:codex:exit-1',
  lane: 'codex', repo: null, kind: null, code: 'exit-1',
  detail: 'd', ...over,
});

describe('evaluateIncidentGate', () => {
  it('trips at minRepeats and emits the right action per class', () => {
    const testSig = (at: number) => sig({
      cls: 'test-failure', key: 'test-failure:ashlrai/phantom:AAA:exit-1',
      lane: 'codex', repo: 'ashlrai/phantom', kind: 'AAA', code: 'exit-1', at,
    });
    const conflictSig = (at: number) => sig({
      cls: 'merge-conflict', key: 'merge-conflict:ashlrai/phantom',
      lane: null, repo: 'ashlrai/phantom', kind: null, code: 'pr-closed-unmerged', at,
    });
    const signals = [
      sig({ key: 'lane-error:codex:exit-1' }),
      sig({ key: 'lane-error:codex:exit-1', at: NOW - 2 * H }),
      sig({ key: 'lane-error:codex:exit-1', at: NOW - 3 * H }),
      testSig(NOW - H), testSig(NOW - 2 * H), testSig(NOW - 3 * H),
      conflictSig(NOW - H), conflictSig(NOW - 2 * H), conflictSig(NOW - 3 * H),
    ];
    const out = evaluateIncidentGate({ signals, state: emptyIncidentGateState(), nowMs: NOW });
    const fired = out.fired.map((f) => f.key).sort();
    expect(fired).toEqual([
      'lane-error:codex:exit-1',
      'merge-conflict:ashlrai/phantom',
      'test-failure:ashlrai/phantom:AAA:exit-1',
    ]);
    const lane = out.fired.find((f) => f.key === 'lane-error:codex:exit-1')!;
    expect(lane.action).toMatchObject({ gate: 'lane-hold', lane: 'codex', minutes: INCIDENT_LANE_HOLD_MINUTES });
    const repo = out.fired.find((f) => f.cls === 'test-failure')!;
    expect(repo.action).toMatchObject({
      gate: 'repo-cooldown', repo: 'ashlrai/phantom', kind: 'cooldown',
      until: iso(NOW + INCIDENT_REPO_COOLDOWN_MS),
    });
  });

  it('does not trip below threshold and respects the firedAt watermark', () => {
    const two = [sig({}), sig({ at: NOW - 2 * H })];
    expect(evaluateIncidentGate({ signals: two, state: emptyIncidentGateState(), nowMs: NOW }).fired).toEqual([]);

    const three = [...two, sig({ at: NOW - 3 * H })];
    const firedState = advanceIncidentGateState(emptyIncidentGateState(), ['lane-error:codex:exit-1'], NOW);
    // Same three signals are all at/before the watermark → zero fresh → no refire.
    const again = evaluateIncidentGate({ signals: three, state: firedState, nowMs: NOW + H });
    expect(again.fired).toEqual([]);
    const cls = again.classes.find((c) => c.key === 'lane-error:codex:exit-1')!;
    expect(cls.count).toBe(0);
    expect(cls.total).toBe(3);
    // Three NEW signals after the watermark trip again.
    const newer = [sig({ at: NOW + 2 * H }), sig({ at: NOW + 3 * H }), sig({ at: NOW + 4 * H })];
    const refired = evaluateIncidentGate({ signals: newer, state: firedState, nowMs: NOW + 5 * H });
    expect(refired.fired.map((f) => f.key)).toEqual(['lane-error:codex:exit-1']);
  });

  it('honours custom minRepeats and window limits', () => {
    const signals = [sig({}), sig({ at: NOW - 2 * H })];
    const out = evaluateIncidentGate({
      signals, state: emptyIncidentGateState(), nowMs: NOW, limits: { minRepeats: 2 },
    });
    expect(out.fired).toHaveLength(1);
    const stale = evaluateIncidentGate({
      signals: [sig({ at: NOW - 10 * 24 * H }), sig({ at: NOW - 9 * 24 * H }), sig({ at: NOW - 8 * 24 * H })],
      state: emptyIncidentGateState(), nowMs: NOW,
    });
    expect(stale.fired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// State + ledger IO
// ---------------------------------------------------------------------------

describe('incident gate state and ledger', () => {
  it('round-trips state, treats corrupt/missing as empty', async () => {
    const { dir, cleanup } = await tmpDir('incident-state-');
    try {
      expect(loadIncidentGateState(dir).firedAt).toEqual({});
      const state = advanceIncidentGateState(emptyIncidentGateState(), ['a', 'b'], NOW);
      saveIncidentGateState(state, dir);
      expect(loadIncidentGateState(dir).firedAt).toEqual({ a: iso(NOW), b: iso(NOW) });
      await writeFile(incidentGateStatePath(dir), '{not json');
      expect(loadIncidentGateState(dir).firedAt).toEqual({});
      await writeFile(incidentGateStatePath(dir), JSON.stringify({ v: 2, firedAt: { x: iso(NOW) } }));
      expect(loadIncidentGateState(dir).firedAt).toEqual({});
    } finally { await cleanup(); }
  });

  it('appends ledger rows under a private dir', async () => {
    const { dir, cleanup } = await tmpDir('incident-ledger-');
    try {
      await appendIncidentGateLedger(dir, ['{"a":1}', '{"b":2}']);
      await appendIncidentGateLedger(dir, []);
      const text = await readFile(incidentGateLedgerPath(dir), 'utf8');
      expect(text).toBe('{"a":1}\n{"b":2}\n');
    } finally { await cleanup(); }
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliFixture {
  runsDir: string;
  stateDir: string;
  cleanup: () => Promise<void>;
}

async function makeFixture(jobs: string[], events = ''): Promise<CliFixture> {
  const runs = await tmpDir('incident-runs-');
  const state = await tmpDir('incident-state-');
  await mkdir(join(runs.dir, 'metrics'), { recursive: true });
  await writeFile(join(runs.dir, 'metrics', 'jobs.jsonl'), jobs.join('\n') + '\n');
  if (events) {
    await writeFile(join(runs.dir, 'dispatch-events.log'), events + '\n');
  }
  return {
    runsDir: runs.dir, stateDir: state.dir,
    cleanup: async () => { await runs.cleanup(); await state.cleanup(); },
  };
}

const okHold = (): RepoHoldChange => ({ ok: true, reason: null, before: null, after: null });

function cliDeps(fx: CliFixture, over: Partial<IncidentGateCmdDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const placeHold = vi.fn(async () => ({}));
  const setHold = vi.fn((_req: SetRepoHoldRequest, _opts: { nowMs: number }) => okHold());
  const deps: IncidentGateCmdDeps = {
    now: () => NOW,
    stateDir: fx.stateDir,
    output: (t: string) => out.push(t),
    error: (t: string) => err.push(t),
    placeHold,
    setHold,
    ...over,
  };
  return { deps, out, err, placeHold, setHold };
}

describe('cmdFleetIncidentGate', () => {
  it('dry-run reports plans and writes nothing', async () => {
    const jobs = [
      launch('RQ-H-1'), finish('RQ-H-1'), launch('RQ-H-2'), finish('RQ-H-2'), launch('RQ-H-3'), finish('RQ-H-3'),
    ];
    const fx = await makeFixture(jobs);
    try {
      const { deps, out, placeHold, setHold } = cliDeps(fx);
      const code = await cmdFleetIncidentGate(['--json', '--runs-dir', fx.runsDir], deps);
      expect(code).toBe(0);
      expect(placeHold).not.toHaveBeenCalled();
      expect(setHold).not.toHaveBeenCalled();
      const report = JSON.parse(out.join('\n')) as { mode: string; fired: { gate: string }[] };
      expect(report.mode).toBe('dry-run');
      expect(report.fired.map((f) => f.gate).sort()).toEqual(['lane-hold', 'repo-cooldown']);
      // No state or ledger files were created.
      await expect(readFile(incidentGateStatePath(fx.stateDir), 'utf8')).rejects.toThrow();
      await expect(readFile(incidentGateLedgerPath(fx.stateDir), 'utf8')).rejects.toThrow();
    } finally { await fx.cleanup(); }
  });

  it('--apply holds the lane, cools the repo, ledgers rows, and does not refire', async () => {
    const jobs = [
      launch('RQ-I-1'), finish('RQ-I-1'), launch('RQ-I-2'), finish('RQ-I-2'), launch('RQ-I-3'), finish('RQ-I-3'),
    ];
    const fx = await makeFixture(jobs);
    try {
      const { deps, out, placeHold, setHold } = cliDeps(fx);
      const code = await cmdFleetIncidentGate(['--apply', '--json', '--runs-dir', fx.runsDir], deps);
      expect(code).toBe(0);
      expect(placeHold).toHaveBeenCalledTimes(1);
      expect(placeHold.mock.calls[0]![0]).toBe('codex');
      expect(placeHold.mock.calls[0]![1]).toMatchObject({ minutes: INCIDENT_LANE_HOLD_MINUTES });
      expect(setHold).toHaveBeenCalledTimes(1);
      const req = setHold.mock.calls[0]![0];
      expect(req).toMatchObject({ repo: 'ashlrai/phantom', kind: 'cooldown', actor: 'backpressure' });
      expect(req.hold?.until).toBe(iso(NOW + INCIDENT_REPO_COOLDOWN_MS));

      const state = loadIncidentGateState(fx.stateDir);
      expect(Object.keys(state.firedAt).sort()).toEqual([
        'lane-error:codex:exit-1',
        'test-failure:ashlrai/phantom:I:exit-1',
      ]);
      const ledger = await readFile(incidentGateLedgerPath(fx.stateDir), 'utf8');
      const rows = ledger.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r['kind'] === 'incident-gate' && r['result'] === 'applied')).toBe(true);

      // Second run: watermarks suppress refire — no new holds, no new rows.
      placeHold.mockClear(); setHold.mockClear(); out.length = 0;
      const code2 = await cmdFleetIncidentGate(['--apply', '--runs-dir', fx.runsDir], deps);
      expect(code2).toBe(0);
      expect(placeHold).not.toHaveBeenCalled();
      expect(setHold).not.toHaveBeenCalled();
      const ledger2 = await readFile(incidentGateLedgerPath(fx.stateDir), 'utf8');
      expect(ledger2.trim().split('\n')).toHaveLength(2);
      expect(out.join('\n')).toContain('no repeated failure class');
    } finally { await fx.cleanup(); }
  });

  it('manual lane hold is refused and still advances the watermark', async () => {
    const jobs = [finish('RQ-J-1'), finish('RQ-J-2'), finish('RQ-J-3')];
    const fx = await makeFixture(jobs);
    try {
      const { deps } = cliDeps(fx, {
        placeHold: vi.fn(async () => { throw new LaneHoldError('manual-hold'); }),
      });
      const code = await cmdFleetIncidentGate(['--apply', '--runs-dir', fx.runsDir], deps);
      expect(code).toBe(0);
      const state = loadIncidentGateState(fx.stateDir);
      expect(state.firedAt['lane-error:codex:exit-1']).toBe(iso(NOW));
      const ledger = await readFile(incidentGateLedgerPath(fx.stateDir), 'utf8');
      expect(ledger).toContain('"result":"refused"');
    } finally { await fx.cleanup(); }
  });

  it('a refused repo cooldown does not advance — it refires next run', async () => {
    const jobs = [
      launch('RQ-K-1'), finish('RQ-K-1'), launch('RQ-K-2'), finish('RQ-K-2'), launch('RQ-K-3'), finish('RQ-K-3'),
    ];
    const fx = await makeFixture(jobs);
    try {
      const refuse: RepoHoldChange = { ok: false, reason: 'denied', before: null, after: null };
      const { deps } = cliDeps(fx, { setHold: vi.fn(() => refuse) });
      const code = await cmdFleetIncidentGate(['--apply', '--runs-dir', fx.runsDir], deps);
      expect(code).toBe(0);
      const state = loadIncidentGateState(fx.stateDir);
      expect(state.firedAt['test-failure:ashlrai/phantom:K:exit-1']).toBeUndefined();
      expect(state.firedAt['lane-error:codex:exit-1']).toBe(iso(NOW));
    } finally { await fx.cleanup(); }
  });

  it('placeHold errors exit 1 and do not advance', async () => {
    const jobs = [finish('RQ-L-1'), finish('RQ-L-2'), finish('RQ-L-3')];
    const fx = await makeFixture(jobs);
    try {
      const { deps } = cliDeps(fx, {
        placeHold: vi.fn(async () => { throw new Error('slots.json unavailable'); }),
      });
      const code = await cmdFleetIncidentGate(['--apply', '--runs-dir', fx.runsDir], deps);
      expect(code).toBe(1);
      expect(loadIncidentGateState(fx.stateDir).firedAt['lane-error:codex:exit-1']).toBeUndefined();
    } finally { await fx.cleanup(); }
  });

  it('degraded evidence exits 1 even on a clean dry run', async () => {
    const fx = await makeFixture([], '');
    try {
      const { deps } = cliDeps(fx, {
        read: async () => ({
          jobs: null, events: null,
          sources: { jobs: 'unreadable' as const, events: 'missing' as const },
        }),
      });
      const code = await cmdFleetIncidentGate(['--runs-dir', fx.runsDir], deps);
      expect(code).toBe(1);
    } finally { await fx.cleanup(); }
  });

  it('rejects bad flags', async () => {
    const fx = await makeFixture([]);
    try {
      const { deps, err } = cliDeps(fx);
      expect(await cmdFleetIncidentGate(['--bogus'], deps)).toBe(2);
      expect(await cmdFleetIncidentGate(['--window-hours', '0'], deps)).toBe(2);
      expect(await cmdFleetIncidentGate(['--runs-dir', 'relative'], deps)).toBe(2);
      expect(err.length).toBe(3);
      expect(await cmdFleetIncidentGate(['--help'], deps)).toBe(0);
    } finally { await fx.cleanup(); }
  });
});
