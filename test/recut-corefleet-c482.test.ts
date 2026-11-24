/**
 * Recut RQ-PHX-RECUTCOREFLEETC482 of PR #6002 (bridge: RQ-PHX-RECUTCOREFLEETC404),
 * itself a recut of #5149 (RQ-PHX-LANESTATEOWNERFINISH175). Covers lane
 * observation angles the carried suites do not: global slot bookkeeping keys
 * are not lanes, malformed lane rows degrade the source without losing valid
 * lanes, rollup figures pass through measured or stay null, and pause state
 * stays honest. Drives readFleetRunsDirState — the module `phm lanes --json`
 * projects — and the verb itself, against temp runs directories only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-16T00:00:00.000Z', commit: 'c482abc', lanes: [], runs: [] } })),
}));

import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { cmdLanes } from '../src/cli/lanes.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function runsDirWithStatus(status: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recut-c482-'));
  dirs.push(root);
  await mkdir(join(root, 'queue'), { recursive: true });
  await writeFile(
    join(root, 'queue', 'status.json'),
    typeof status === 'string' ? status : JSON.stringify(status),
  );
  return root;
}

const baseStatus = {
  last_tick: '2026-11-16T12:00:00Z',
  paused: null,
  mem_free_pct: 60,
  schema: 'dispatchd.status.v1',
};

describe('readFleetRunsDirState lane observation (recut of #6002)', () => {
  it('drops global slot bookkeeping keys without degrading the source', async () => {
    const runsDir = await runsDirWithStatus({
      ...baseStatus,
      lanes: {
        hard_cap: { running: 99, bogus: true },
        last_change_by: 'operator',
        'real-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
      },
    });
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('healthy');
    expect(state.lanes.map(l => l.lane)).toEqual(['real-lane']);
  });

  it('flags malformed lane rows as degraded while keeping valid lanes', async () => {
    const runsDir = await runsDirWithStatus({
      ...baseStatus,
      lanes: {
        'Bad Lane': { running: 0, target: 1, queued: 0, held: false },
        'no-held': { running: 0, target: 1, queued: 0 },
        'good-lane': { running: 2, target: 3, queued: 1, floor: 0, ceiling: 4, held: true, held_reason: 'see C:\\ops\\quota.txt' },
      },
    });
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('degraded');
    expect(state.lanes.map(l => l.lane)).toEqual(['good-lane']);
    expect(state.lanes[0]!.floor).toBe(0);
    expect(state.lanes[0]!.heldReason).toContain('[path]');
    expect(state.lanes[0]!.heldReason).not.toContain('C:\\ops');
  });

  it('keeps measured rollup_24h per lane and leaves unmeasured lanes null', async () => {
    const runsDir = await runsDirWithStatus({
      ...baseStatus,
      rollup_24h: { by_lane: { 'merged-lane': { merged: 5, merge_rate: 0.5 } } },
      lanes: {
        'merged-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false },
        'quiet-lane': { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: false },
      },
    });
    const state = await readFleetRunsDirState({ runsDir });
    expect(state.sources.status).toBe('healthy');
    const lanes = Object.fromEntries(state.lanes.map(l => [l.lane, l]));
    expect(lanes['merged-lane']).toMatchObject({ merged24h: 5, mergeRate24h: 0.5 });
    expect(lanes['quiet-lane']).toMatchObject({ merged24h: null, mergeRate24h: null });
  });

  it('reads a paused reason string as paused and refuses absent paused under the v1 schema', async () => {
    const pausedDir = await runsDirWithStatus({ ...baseStatus, paused: 'operator hold for quota', lanes: {} });
    expect((await readFleetRunsDirState({ runsDir: pausedDir })).paused).toBe(true);

    const absentDir = await runsDirWithStatus({ last_tick: baseStatus.last_tick, mem_free_pct: 60, schema: 'dispatchd.status.v1', lanes: {} });
    const state = await readFleetRunsDirState({ runsDir: absentDir });
    expect(state.sources.status).toBe('degraded');
    expect(state.paused).toBeNull();
    expect(state.lastTick).toBeNull();
  });
});

describe('phm lanes --json (recut of #6002)', () => {
  it('projects only real lanes and reports degraded status honestly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recut-c482-cli-'));
    dirs.push(root);
    await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
    await writeFile(join(root, '.ashlr-runs/queue/status.json'), JSON.stringify({
      ...baseStatus,
      lanes: {
        hard_cap: 8,
        'Bad Lane': { running: 0, target: 1, queued: 0, held: false },
        'real-lane': { running: 1, target: 2, queued: 0, floor: null, ceiling: null, held: false, healthy: true },
      },
    }));
    vi.stubEnv('HOME', root);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    const text = out.mock.calls[0]![0];
    const report = JSON.parse(text);
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.sourceState).toBe('degraded');
    expect(report.lanes.map((l: { lane: string }) => l.lane)).toEqual(['real-lane']);
    expect(report.lanes[0].healthy).toBe(true);
    expect(text).not.toContain('hard_cap');
  });
});
