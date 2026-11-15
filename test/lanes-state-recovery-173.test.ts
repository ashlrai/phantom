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

async function homeWithStatus(status: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-state-173-'));
  dirs.push(root);
  await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
  await writeFile(
    join(root, '.ashlr-runs/queue/status.json'),
    typeof status === 'string' ? status : JSON.stringify(status),
  );
  vi.stubEnv('HOME', root);
  return root;
}

function captureLog(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'log').mockImplementation(() => undefined);
}

const baseStatus = {
  last_tick: '2026-11-11T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {},
};

describe('phm lanes --json (RQ-PHX-LANESTATERECOVER173)', () => {
  it('preserves measured healthy true/false and leaves absent health unknown', async () => {
    await homeWithStatus({
      ...baseStatus,
      lanes: {
        'alpha-lane': { running: 1, target: 3, queued: 2, floor: 1, ceiling: 4, held: false, healthy: true },
        'beta-lane': { running: 0, target: 2, queued: 0, floor: null, ceiling: null, held: true, held_reason: 'operator hold', healthy: false },
        'gamma-lane': { running: 2, target: 4, queued: 1, held: false },
      },
    });
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

  it('does not leak private state fields or unscrubbed free text', async () => {
    await homeWithStatus({
      ...baseStatus,
      operator_secret: 'PRIVATE-MARKER-9f8e7d',
      lanes: {
        'alpha-lane': {
          running: 0, target: 1, queued: 0, held: true,
          held_reason: 'hold until /Users/someone/private/quota resets',
          api_token: 'PRIVATE-MARKER-9f8e7d',
          healthy: 'yes',
        },
      },
    });
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

  it('stays honest when status.json is malformed', async () => {
    await homeWithStatus('{not json');
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('degraded');
  });

  it('stays honest when the runs directory is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-state-173-empty-'));
    dirs.push(root);
    vi.stubEnv('HOME', root);
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('missing');
  });

  it('keeps existing verbs and rejects invalid arguments', async () => {
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
