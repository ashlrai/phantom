import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-11T00:00:00.000Z', commit: 'def5678', lanes: [], runs: [] } })),
}));

import { cmdLanes } from '../src/cli/lanes.js';

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function homeWithStatus(status: unknown): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'recut-c218-lane-'));
  dirs.push(root);
  await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
  await writeFile(
    join(root, '.ashlr-runs/queue/status.json'),
    typeof status === 'string' ? status : JSON.stringify(status),
  );
  vi.stubEnv('HOME', root);
}

const baseStatus = {
  last_tick: '2026-11-11T12:00:00Z',
  paused: null,
  mem_free_pct: 55,
  schema: 'dispatchd.status.v1',
  lanes: {} as Record<string, unknown>,
};

describe('RQ-PHX-RECUTCORES0C218 recut of #5252: lanes --json preserves observation honesty', () => {
  it('carries measured health and counts verbatim while an unreported lane stays unobserved', async () => {
    await homeWithStatus({ ...baseStatus, lanes: {
      'c218-observed': { running: 2, target: 6, queued: 3, floor: 1, ceiling: 8, held: false, healthy: true },
      'c218-unobserved': { running: 1, target: 2, queued: 0, held: false },
    } });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    const text = out.mock.calls[0]![0] as string;
    const report = JSON.parse(text);
    const lanes = Object.fromEntries(report.lanes.map((l: { lane: string }) => [l.lane, l]));
    expect(lanes['c218-observed']).toMatchObject({ running: 2, target: 6, queued: 3, floor: 1, ceiling: 8, held: false, healthy: true });
    expect(text).toContain('"healthy":true');
    expect('healthy' in lanes['c218-unobserved']).toBe(false);
    expect(lanes['c218-unobserved'].tokensLastHour).toBeNull();
    expect(report.sourceState).toBe('healthy');
  });

  it('keeps a hold but scrubs the absolute path inside its reason', async () => {
    await homeWithStatus({ ...baseStatus, lanes: {
      'c218-held': { running: 0, target: 1, queued: 0, held: true, held_reason: 'hold until /Users/someone/private/quota resets' },
    } });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    const text = out.mock.calls[0]![0] as string;
    const report = JSON.parse(text);
    expect(report.lanes[0]).toMatchObject({ lane: 'c218-held', held: true });
    expect(report.lanes[0].heldReason).not.toContain('/Users/someone');
    expect(text).not.toContain('/Users/someone');
  });
});
