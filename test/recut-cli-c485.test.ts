import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(async () => ({ snapshot: { v: 1, generatedAt: '2026-11-16T00:00:00.000Z', commit: 'abc1234', lanes: [], runs: [] } })),
}));

import { cmdLanes } from '../src/cli/lanes.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function homeWithStatus(lanes: Record<string, unknown>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-recut-c485-'));
  dirs.push(root);
  await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
  await writeFile(join(root, '.ashlr-runs/queue/status.json'), JSON.stringify({
    last_tick: '2026-11-16T09:00:00Z',
    paused: null,
    mem_free_pct: 55,
    schema: 'dispatchd.status.v1',
    lanes,
  }));
  vi.stubEnv('HOME', root);
}

async function lanesJson(): Promise<Record<string, any>> {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdLanes(['--json'])).toBe(0);
  return JSON.parse(out.mock.calls.at(-1)![0]);
}

describe('phm lanes --json recut C485', () => {
  it('never promotes global slot keys (hard_cap, last_change_by) to lanes', async () => {
    await homeWithStatus({
      'hard_cap': { running: 9, target: 9, queued: 9, held: false },
      'last_change_by': { running: 9, target: 9, queued: 9, held: false },
      'real-lane': { running: 1, target: 2, queued: 0, held: false },
    });
    const report = await lanesJson();
    expect(report.sourceState).toBe('healthy');
    expect(report.lanes.map((l: { lane: string }) => l.lane)).toEqual(['real-lane']);
  });

  it('bounds held_reason to 200 chars and strips control characters', async () => {
    await homeWithStatus({
      'held-lane': {
        running: 0, target: 1, queued: 0, held: true,
        held_reason: `hold\n${'x'.repeat(300)}`,
      },
    });
    const report = await lanesJson();
    const lane = report.lanes.find((l: { lane: string }) => l.lane === 'held-lane');
    expect(lane.held).toBe(true);
    expect(lane.heldReason).not.toContain('\n');
    expect(lane.heldReason.length).toBeLessThanOrEqual(200);
    expect(lane.heldReason.startsWith('hold')).toBe(true);
  });
});
