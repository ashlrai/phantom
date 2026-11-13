import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-11T00:00:00.000Z', commit: 'f311c00', lanes: [], runs: [] } })),
}));

import { cmdLanes } from '../src/cli/lanes.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function homeWithStatus(status: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-f311-'));
  dirs.push(root);
  await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
  await writeFile(
    join(root, '.ashlr-runs/queue/status.json'),
    typeof status === 'string' ? status : JSON.stringify(status),
  );
  vi.stubEnv('HOME', root);
  return root;
}

const baseStatus = {
  last_tick: '2026-11-11T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {} as Record<string, unknown>,
};

describe('reconcile-range-f311: lanes --json observation honesty (carried from #5300)', () => {
  it('carries measured fields verbatim and leaves unmeasured figures absent or null', async () => {
    await homeWithStatus({ ...baseStatus, lanes: {
      'f311-observed': { running: 2, target: 6, queued: 3, floor: 1, ceiling: 8, held: false, healthy: true },
      'f311-unobserved': { running: 1, target: 2, queued: 0, held: false },
    } });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    const text = out.mock.calls[0]![0] as string;
    const report = JSON.parse(text);
    expect(report.schema).toBe('lanes.dispatchd.v1');
    expect(report.lastTick).toBe('2026-11-11T12:00:00Z');
    expect(report.sourceState).toBe('healthy');
    const lanes = Object.fromEntries(report.lanes.map((l: { lane: string }) => [l.lane, l]));
    expect(lanes['f311-observed']).toMatchObject({ running: 2, target: 6, queued: 3, floor: 1, ceiling: 8, held: false, healthy: true });
    expect('healthy' in lanes['f311-unobserved']).toBe(false);
    expect(lanes['f311-unobserved'].tokensLastHour).toBeNull();
    expect(text).not.toMatch(/"f311-unobserved"[^}]*"healthy"/);
  });

  it('keeps a hold but scrubs the absolute path and private fields inside its reason', async () => {
    await homeWithStatus({ ...baseStatus,
      operator_secret: 'F311-PRIVATE-MARKER',
      lanes: {
        'f311-held': {
          running: 0, target: 1, queued: 0, held: true,
          held_reason: 'hold until /Users/somebody/private/quota resets',
          api_token: 'F311-PRIVATE-MARKER',
          healthy: 'yes',
        },
      } });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    const text = out.mock.calls[0]![0] as string;
    const report = JSON.parse(text);
    expect(report.lanes[0]).toMatchObject({ lane: 'f311-held', held: true });
    expect(report.lanes[0].heldReason).not.toContain('/Users/somebody');
    expect(text).not.toContain('/Users/somebody');
    expect(text).not.toContain('F311-PRIVATE-MARKER');
    expect('healthy' in report.lanes[0]).toBe(false);
  });

  it('reports degraded for malformed status.json and missing when the runs dir is absent', async () => {
    await homeWithStatus('{not json');
    let out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    let report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('degraded');

    vi.restoreAllMocks();
    const root = await mkdtemp(join(tmpdir(), 'reconcile-f311-empty-'));
    dirs.push(root);
    vi.stubEnv('HOME', root);
    out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    report = JSON.parse(out.mock.calls[0]![0]);
    expect(report.lanes).toEqual([]);
    expect(report.lastTick).toBeNull();
    expect(report.sourceState).toBe('missing');
  });
});
