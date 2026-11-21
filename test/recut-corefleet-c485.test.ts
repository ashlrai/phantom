/**
 * Recut RQ-PHX-RECUTCOREFLEETC485 of PR #6281 (bridge: RQ-PHX-RECUTCOREFLEETC470),
 * carrying forward its consolidated stranded suite:
 *   test/recut-corefleet-c470.test.ts              (18 tests, three merged suites)
 * Upstream provenance kept from the source headers: #6281 recut #6167, which
 * consolidated #6054's three files (recut-corefleet-c413.test.ts,
 * lane-observation-owner-proof-303s.test.ts, lane-observation-preserved-178
 * .test.ts) qualifying #5398 and recovering #5163/#5206 (from PRs #5149/#5141).
 * Explicit measurements survive verbatim; unmeasured capacity/health/usage
 * stays absent or null; private state and free text never reach the output.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

// The only stub is the unrelated live-snapshot API used by `phm lanes health`.
vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-13T00:00:00.000Z', commit: 'abc1234', lanes: [], runs: [] } })),
}));

import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { cmdLanes } from '../src/cli/lanes.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

// --- section 1: readFleetRunsDirState (from recut-corefleet-c413.test.ts via #6167 and #6281) ---

async function runsDirWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recut-c485-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  return root;
}

const runsStatusFile = (status: unknown) => ({
  'queue/status.json': typeof status === 'string' ? status : JSON.stringify(status),
});

const RUNS_HEADER = {
  last_tick: '2026-11-13T15:00:00Z',
  paused: null,
  mem_free_pct: 40,
  schema: 'dispatchd.status.v1',
};

describe('readFleetRunsDirState owner-proof lane observation (recut of #5398 via #6167 and #6281)', () => {
  it('keeps measured zeros as zero and null bounds as null', async () => {
    const runsDir = await runsDirWith(runsStatusFile({ ...RUNS_HEADER, lanes: {
      'zero-lane': { running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true },
      'null-bounds': { running: 1, target: 3, queued: 2, floor: null, ceiling: null, held: false },
    } }));
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('healthy');
    expect(state.lastTick).toBe('2026-11-13T15:00:00Z');
    const lanes = Object.fromEntries(state.lanes.map(l => [l.lane, l]));
    expect(lanes['zero-lane']).toMatchObject({ running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true });
    expect(lanes['null-bounds']).toMatchObject({ running: 1, target: 3, queued: 2, floor: null, ceiling: null });
    expect(lanes['null-bounds']!.healthy).toBeUndefined();
  });

  it('passes measured 24h rollup figures through verbatim per lane', async () => {
    const runsDir = await runsDirWith(runsStatusFile({ ...RUNS_HEADER,
      rollup_24h: { by_lane: {
        'measured-lane': { merged: 4, merge_rate: 0.5 },
        'sparse-lane': { merged: 0 },
      } },
      lanes: {
        'measured-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
        'sparse-lane': { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: false },
        'unrolled-lane': { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: false },
      } }));
    const state = await readFleetRunsDirState({ runsDir });
    const lanes = Object.fromEntries(state.lanes.map(l => [l.lane, l]));
    expect(lanes['measured-lane']).toMatchObject({ merged24h: 4, mergeRate24h: 0.5 });
    expect(lanes['sparse-lane']!.merged24h).toBe(0);
    // A lane with no rollup entry stays unmeasured (null), never an invented zero.
    expect(lanes['unrolled-lane']).toMatchObject({ merged24h: null, mergeRate24h: null });
  });

  it('distinguishes unmeasured usage (null) from a measured zero', async () => {
    // metrics/jobs.jsonl absent -> tokensLastHour is unknown (null).
    const noMetrics = await runsDirWith(runsStatusFile({ ...RUNS_HEADER, lanes: {
      'lane-a': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
    } }));
    const unknown = await readFleetRunsDirState({ runsDir: noMetrics });
    expect(unknown.sources.metrics).toBe('missing');
    expect(unknown.lanes[0]!.tokensLastHour).toBeNull();
    // metrics/jobs.jsonl present but empty -> a measured zero, not null.
    const emptyMetrics = await runsDirWith({
      ...runsStatusFile({ ...RUNS_HEADER, lanes: {
        'lane-a': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      } }),
      'metrics/jobs.jsonl': '',
    });
    const measured = await readFleetRunsDirState({ runsDir: emptyMetrics });
    expect(measured.sources.metrics).toBe('healthy');
    expect(measured.lanes[0]!.tokensLastHour).toBe(0);
  });

  it('keeps real lastTick and valid lanes while degrading on one malformed lane entry', async () => {
    const runsDir = await runsDirWith(runsStatusFile({ ...RUNS_HEADER, lanes: {
      'good-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      'bad-lane': { running: 'many', target: 2, queued: 0, held: false },
      'bad-held': { running: 0, target: 1, queued: 0, held: 'yes' },
    } }));
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('degraded');
    expect(state.lastTick).toBe('2026-11-13T15:00:00Z');
    expect(state.lanes.map(l => l.lane)).toEqual(['good-lane']);
  });

  it('reports missing status.json without inventing lastTick or lanes', async () => {
    const runsDir = await runsDirWith({ 'queue/claimed.tsv': '' });
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.runsDirPresent).toBe(true);
    expect(state.sources.status).toBe('missing');
    expect(state.lanes).toEqual([]);
    expect(state.lastTick).toBeNull();
  });

  it('never promotes non-boolean healthy and scrubs held_reason paths', async () => {
    const runsDir = await runsDirWith(runsStatusFile({ ...RUNS_HEADER,
      operator_secret: 'PRIVATE-MARKER-c485',
      lanes: {
        'alpha-lane': {
          running: 0, target: 1, queued: 0, held: true,
          held_reason: 'hold until /Users/someone/private/quota resets',
          api_token: 'PRIVATE-MARKER-c485',
          healthy: 'yes',
        },
      } }));
    const state = await readFleetRunsDirState({ runsDir });
    const lane = state.lanes[0]!;
    expect('healthy' in lane).toBe(false);
    expect(lane.heldReason).not.toContain('/Users/someone');
    expect(lane.heldReason).toContain('[path]');
    expect(JSON.stringify(state)).not.toContain('PRIVATE-MARKER-c485');
  });
});

// --- section 2: phm lanes --json owner-proof edge matrix (from lane-observation-owner-proof-303s.test.ts via #6167 and #6281) ---

const OBS_HEADER = {
  last_tick: '2026-11-13T15:00:00Z',
  paused: null,
  mem_free_pct: 40,
  schema: 'dispatchd.status.v1',
};

async function homeWithFiles(files: Record<string, string>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lane-obs-c485-303s-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  vi.stubEnv('HOME', root);
}

const homeStatusFile = (status: unknown) => ({
  '.ashlr-runs/queue/status.json': typeof status === 'string' ? status : JSON.stringify(status),
});

async function lanesJson(): Promise<{ text: string; report: Record<string, any> }> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdLanes(['--json'])).toBe(0);
  const text = out.mock.calls.at(-1)![0] as string;
  return { text, report: JSON.parse(text) };
}

describe('phm lanes --json owner proof edge matrix (RQ-PHX-LANEOBSOWNERQUALIFY303S)', () => {
  it('keeps measured running/target/queued zero as zero and null bounds as null', async () => {
    await homeWithFiles(homeStatusFile({ ...OBS_HEADER, lanes: {
      'zero-lane': { running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true },
      'null-bounds': { running: 1, target: 3, queued: 2, floor: null, ceiling: null, held: false },
    } }));
    const { report } = await lanesJson();
    expect(report.sourceState).toBe('healthy');
    expect(report.lastTick).toBe('2026-11-13T15:00:00Z');
    const lanes = Object.fromEntries(report.lanes.map((l: { lane: string }) => [l.lane, l]));
    expect(lanes['zero-lane']).toMatchObject({ running: 0, target: 0, queued: 0, floor: 0, ceiling: 0, held: false, healthy: true });
    expect(lanes['null-bounds']).toMatchObject({ running: 1, target: 3, queued: 2, floor: null, ceiling: null });
  });

  it('keeps absent usage null rather than inventing zero when metrics are missing', async () => {
    await homeWithFiles(homeStatusFile({ ...OBS_HEADER, lanes: {
      'usage-unknown': { running: 2, target: 4, queued: 1, floor: null, ceiling: null, held: false },
    } }));
    const { report } = await lanesJson();
    const lane = report.lanes.find((l: { lane: string }) => l.lane === 'usage-unknown');
    expect(lane.tokensLastHour).toBeNull();
    expect(lane.merged24h).toBeNull();
    expect(lane.mergeRate24h).toBeNull();
    // The status source itself is healthy; only usage stayed unmeasured.
    expect(report.sourceState).toBe('healthy');
  });

  it('reports degraded with no invented lastTick when status.json is malformed JSON', async () => {
    await homeWithFiles(homeStatusFile('{not json'));
    const { report } = await lanesJson();
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('degraded');
  });

  it('reports degraded with no invented lastTick when status.json fails schema validation', async () => {
    for (const bad of [
      { paused: null, mem_free_pct: 40, schema: 'dispatchd.status.v1', lanes: {} }, // no last_tick
      { last_tick: '2026-11-13T15:00:00Z', paused: null, mem_free_pct: 40, schema: 'dispatchd.status.v1', lanes: [] }, // lanes not object
      { last_tick: 'not-a-timestamp', paused: null, mem_free_pct: 40, schema: 'dispatchd.status.v1', lanes: {} },
      'null', '[]', '"text"',
    ]) {
      await homeWithFiles(homeStatusFile(bad));
      const { report } = await lanesJson();
      expect(report.lanes).toEqual([]);
      expect(report.lastTick).toBeNull();
      expect(report.sourceState).toBe('degraded');
      dirs.splice(0).forEach(dir => void rm(dir, { recursive: true, force: true }));
      vi.unstubAllEnvs();
    }
  });

  it('reports missing with no invented lastTick when status.json is absent but runs dir exists', async () => {
    await homeWithFiles({ '.ashlr-runs/queue/claimed.tsv': '' });
    const { report } = await lanesJson();
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('missing');
  });

  it('keeps the real lastTick and valid lanes while degrading on one malformed lane entry', async () => {
    await homeWithFiles(homeStatusFile({ ...OBS_HEADER, lanes: {
      'good-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      'bad-lane': { running: 'many', target: 2, queued: 0, held: false },
      'bad-held': { running: 0, target: 1, queued: 0, held: 'yes' },
    } }));
    const { report } = await lanesJson();
    expect(report.sourceState).toBe('degraded');
    expect(report.lastTick).toBe('2026-11-13T15:00:00Z');
    const names = report.lanes.map((l: { lane: string }) => l.lane);
    expect(names).toEqual(['good-lane']);
  });
});

// --- section 3: phm lanes --json observation preservation (from lane-observation-preserved-178.test.ts via #6167 and #6281) ---

const baseStatus = {
  last_tick: '2026-11-11T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {} as Record<string, unknown>,
};

// A temporary HOME whose only run-state is `.ashlr-runs/queue/status.json`.
// No real run-state is read or written.
async function homeWithStatus(status: unknown): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lane-obs-c485-178-'));
  dirs.push(root);
  await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
  await writeFile(
    join(root, '.ashlr-runs/queue/status.json'),
    typeof status === 'string' ? status : JSON.stringify(status),
  );
  vi.stubEnv('HOME', root);
}

function captureLog(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'log').mockImplementation(() => undefined);
}

describe('phm lanes --json observation preservation (RQ-PHX-LANEOBSERVEPRESERVE178)', () => {
  it('preserves measured healthy true/false and leaves absent health unknown (173 #1)', async () => {
    await homeWithStatus({ ...baseStatus, lanes: {
      'alpha-lane': { running: 1, target: 3, queued: 2, floor: 1, ceiling: 4, held: false, healthy: true },
      'beta-lane': { running: 0, target: 2, queued: 0, floor: null, ceiling: null, held: true, held_reason: 'operator hold', healthy: false },
      'gamma-lane': { running: 2, target: 4, queued: 1, held: false },
    } });
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.lastTick).toBe('2026-11-11T12:00:00Z');
    // sourceState reports the status.json source specifically; it parsed cleanly.
    expect(report.sourceState).toBe('healthy');
    const lanes = Object.fromEntries(report.lanes.map((l: { lane: string }) => [l.lane, l]));
    expect(lanes['alpha-lane']).toMatchObject({ running: 1, target: 3, queued: 2, floor: 1, ceiling: 4, held: false, healthy: true });
    expect(lanes['beta-lane']).toMatchObject({ running: 0, target: 2, held: true, heldReason: 'operator hold', healthy: false });
    expect(lanes['gamma-lane']).toMatchObject({ running: 2, target: 4, queued: 1, held: false });
    expect('healthy' in lanes['gamma-lane']).toBe(false);
    expect(lanes['gamma-lane'].healthy).toBeUndefined();
  });

  it('omits health for lanes that never reported it and keeps explicit false (175 #1)', async () => {
    await homeWithStatus({ ...baseStatus, lanes: {
      'observed-false': { running: 0, target: 2, queued: 0, held: false, healthy: false },
      'unobserved': { running: 1, target: 2, queued: 0, held: false },
    } });
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const text = out.mock.calls[0]![0] as string;
    const report = JSON.parse(text);
    const lanes = Object.fromEntries(report.lanes.map((l: { lane: string }) => [l.lane, l]));
    expect(lanes['observed-false'].healthy).toBe(false);
    expect('healthy' in lanes['unobserved']).toBe(false);
    // No measured health and no metrics source: usage stays unknown (null), not zero.
    expect(lanes['unobserved'].tokensLastHour).toBeNull();
    // sourceState is the status.json source only: it parsed cleanly.
    expect(report.sourceState).toBe('healthy');
    // Raw serialized JSON: the unobserved lane object carries no healthy key.
    expect(text).not.toMatch(/"unobserved"[^}]*"healthy"/);
  });

  it('does not leak private state fields or unscrubbed free text (173 #2)', async () => {
    await homeWithStatus({ ...baseStatus,
      operator_secret: 'PRIVATE-MARKER-9f8e7d',
      lanes: {
        'alpha-lane': {
          running: 0, target: 1, queued: 0, held: true,
          held_reason: 'hold until /Users/someone/private/quota resets',
          api_token: 'PRIVATE-MARKER-9f8e7d',
          healthy: 'yes',
        },
      } });
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const text = out.mock.calls[0]![0];
    const report = JSON.parse(text);
    expect(text).not.toContain('PRIVATE-MARKER-9f8e7d');
    expect(text).not.toContain('/Users/someone');
    expect(report.lanes[0].heldReason).not.toContain('/Users/someone');
    // A non-boolean healthy value is not promoted to a measurement.
    expect('healthy' in report.lanes[0]).toBe(false);
  });

  it('stays honest when status.json is malformed (173 #3)', async () => {
    await homeWithStatus('{not json');
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('degraded');
  });

  it('stays honest when the runs directory is absent (173 #4)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lane-obs-c485-178-empty-'));
    dirs.push(root);
    vi.stubEnv('HOME', root);
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('missing');
  });

  it('keeps existing verbs and rejects invalid arguments (173 #5)', async () => {
    await homeWithStatus(baseStatus);
    const out = captureLog();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdLanes(['bogus'])).toBe(2);
    expect(await cmdLanes([])).toBe(2);
    expect(await cmdLanes(['--json', 'extra'])).toBe(2);
    expect(await cmdLanes(['health', '--x'])).toBe(2);
    expect(err).toHaveBeenCalled();
    // Existing verbs still work against the same home.
    expect(await cmdLanes(['health', '--json'])).toBe(0);
    expect(JSON.parse(out.mock.calls.at(-1)![0]).schema).toBe('lanes.health.v1');
    expect(await cmdLanes(['fit', '--lane', 'alpha-lane', '--json'])).toBe(0);
    expect(out.mock.calls.at(-1)![0]).toContain('lanes.fit.v1');
  });
});
