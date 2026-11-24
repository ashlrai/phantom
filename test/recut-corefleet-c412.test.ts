import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-15T00:00:00.000Z', commit: 'def5678', lanes: [], runs: [] } })),
}));

import { cmdLanes } from '../src/cli/lanes.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function homeWithStatus(status: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recut-c412-lanes-'));
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
  last_tick: '2026-11-15T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {},
};

describe('phm lanes --json recut (RQ-PHX-RECUTCOREFLEETC412)', () => {
  it('keeps measured lanes while flagging malformed entries and drops global slot keys quietly', async () => {
    await homeWithStatus({
      ...baseStatus,
      lanes: {
        hard_cap: { running: 99, bogus: true },
        last_change_by: 'operator',
        'ok-lane': { running: 1, target: 2, queued: 0, floor: 0, ceiling: 5, held: true, healthy: false },
        'Bad_Lane': { running: 0, target: 1, queued: 0, held: false },
        'neg-lane': { running: -1, target: 1, queued: 0, held: false },
      },
      rollup_24h: { by_lane: { 'ok-lane': { merged: 4, merge_rate: 0.5 } } },
    });
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.schema).toBe('lanes.dispatchd.v1');
    // Malformed lane entries degrade the status source but do not sink the valid lane.
    expect(report.sourceState).toBe('degraded');
    expect(report.lanes).toHaveLength(1);
    expect(report.lanes[0]).toMatchObject({
      lane: 'ok-lane', running: 1, target: 2, queued: 0,
      floor: 0, ceiling: 5, held: true, heldReason: null, healthy: false,
      merged24h: 4, mergeRate24h: 0.5,
    });
    // No metrics/jobs.jsonl was written: hourly token totals stay unknown, not zero.
    expect(report.lanes[0].tokensLastHour).toBeNull();
    const text = out.mock.calls[0]![0];
    expect(text).not.toContain('hard_cap');
    expect(text).not.toContain('last_change_by');
    expect(text).not.toContain('Bad_Lane');
    expect(text).not.toContain('neg-lane');
  });

  it('rejects an implausible status object wholesale instead of projecting half of it', async () => {
    await homeWithStatus({ ...baseStatus, mem_free_pct: 150, lanes: { 'ok-lane': { running: 1, target: 1, queued: 0, held: false } } });
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.sourceState).toBe('degraded');
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
  });

  it('rejects a lanes array, which is not the dispatchd lanes object', async () => {
    await homeWithStatus({ ...baseStatus, lanes: [{ lane: 'ok-lane', running: 1, target: 1, queued: 0, held: false }] });
    const out = captureLog();
    expect(await cmdLanes(['--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.sourceState).toBe('degraded');
    expect(report.lanes).toEqual([]);
  });
});
