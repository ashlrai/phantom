/**
 * RQ-PHX-RANGERECONCILEE311C: carries test/lane-observation-preserved-178.test.ts from
 * PR #5206 (head c5fc27e7fea67a23608188847de1355d1b9bcd2f) onto master.
 * Preserved lane-observation regression coverage (RQ-PHX-LANEOBSERVEPRESERVE178),
 * consolidated from PR #5149 head 04c22c15555a002d8501a73864eb55fa390413a3:
 *   test/lanes-state-recovery-173.test.ts     blob 35405875e1b7114ed206c96afd30de1b1114f150
 *   test/lanes-state-owner-finish-175.test.ts blob bab729113acfddfbb72beec84a8b021a211fe06e
 * Recovered for RQ-PHX-LANEOBSERVETESTPORT189S from PR #5163
 * (source SHA 1c0d569ef1e0b4ae6dac97c85e20f8c5797f518d, blob 51989e91afd95d465c7dd1a99ffec4ce4be15ac3).
 * Mason t1628u/t1630u: agents must distinguish unobserved capacity, health and
 * usage from measured failure or zero. Explicit measurements survive `--json`
 * verbatim; anything without a source stays absent or null; private state and
 * free text never reach the output.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-11T00:00:00.000Z', commit: 'abc1234', lanes: [], runs: [] } })),
}));

import { cmdLanes } from '../src/cli/lanes.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

const baseStatus = {
  last_tick: '2026-11-11T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {} as Record<string, unknown>,
};

// Fixture scaffolding duplicated by both source suites, deduplicated here:
// a temporary HOME whose only run-state is `.ashlr-runs/queue/status.json`.
// No real run-state is read or written.
async function homeWithStatus(status: unknown): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lane-obs-178-'));
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
    const root = await mkdtemp(join(tmpdir(), 'lane-obs-178-empty-'));
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
