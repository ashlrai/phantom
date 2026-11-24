/** Recut #6051: each CLI read must reflect the current status file, including
 * recovery after whole-source rejection, without retaining earlier lanes. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/core/verse/fleet-live-api.js', () => ({
  buildFleetLiveSnapshot: vi.fn(),
}));

import { cmdLanes } from '../src/cli/lanes.js';

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

it('rejects an invalid replacement and reads a recovered status without stale lanes', async () => {
  root = await mkdtemp(join(tmpdir(), 'recut-testonly-c456-'));
  const queue = join(root, '.ashlr-runs', 'queue');
  await mkdir(queue, { recursive: true });
  vi.stubEnv('HOME', root);
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const status = {
    schema: 'dispatchd.status.v1', last_tick: '2026-11-16T12:00:00Z',
    paused: null, mem_free_pct: 50,
    lanes: { 'first-lane': { running: 1, target: 2, queued: 0, held: false, healthy: true } },
  };
  async function read(statusValue: unknown) {
    await writeFile(join(queue, 'status.json'), JSON.stringify(statusValue));
    out.mockClear();
    expect(await cmdLanes(['--json'])).toBe(0);
    expect(out).toHaveBeenCalledTimes(1);
    return JSON.parse(out.mock.calls[0]![0] as string);
  }

  const initial = await read(status);
  expect(initial.sourceState).toBe('healthy');
  expect(initial.lanes).toEqual([expect.objectContaining({ lane: 'first-lane', healthy: true })]);

  const rejected = await read({ ...status, mem_free_pct: 101 });
  expect(rejected).toEqual({
    schema: 'lanes.dispatchd.v1', sourceState: 'degraded', lastTick: null, lanes: [],
  });

  const recovered = await read({ ...status, last_tick: '2026-11-16T12:01:00Z', lanes: {
    'second-lane': { running: 0, target: 1, queued: 0, held: true, healthy: false },
  } });
  expect(recovered.sourceState).toBe('healthy');
  expect(recovered.lastTick).toBe('2026-11-16T12:01:00Z');
  expect(recovered.lanes).toEqual([expect.objectContaining({
    lane: 'second-lane', running: 0, healthy: false,
    tokensLastHour: null, merged24h: null, mergeRate24h: null,
  })]);
});
