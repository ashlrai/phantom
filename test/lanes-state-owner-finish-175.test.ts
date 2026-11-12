import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Behavioral check on the real cmdLanes: a lane whose status.json entry omits
// `healthy` must stay without a health field, while an explicit false survives.
// Usage and capacity figures with no metrics source must be null, never 0.

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

async function fixtureHome(lanes: Record<string, unknown>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-state-175-'));
  dirs.push(root);
  await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
  await writeFile(join(root, '.ashlr-runs/queue/status.json'), JSON.stringify({
    last_tick: '2026-11-11T12:00:00Z', paused: null, mem_free_pct: 55, schema: 'dispatchd.status.v1', lanes,
  }));
  vi.stubEnv('HOME', root);
}

describe('phm lanes --json observed health (RQ-PHX-LANESTATEOWNERFINISH175)', () => {
  it('omits health for lanes that never reported it and keeps explicit false', async () => {
    await fixtureHome({
      'observed-false': { running: 0, target: 2, queued: 0, held: false, healthy: false },
      'unobserved': { running: 1, target: 2, queued: 0, held: false },
    });
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
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
    expect(text).not.toMatch(/"unobserved"[^}]*"healthy"/);
  });
});
