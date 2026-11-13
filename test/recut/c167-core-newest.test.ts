import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdLanes } from '../../src/cli/lanes.js';

// Recut of #4754 (RQ-FIX-PHANTOM-3150 / RQ-OMLX-LANE). Drives `phm lanes --json`
// through its real dispatcher caller, cmdLanes, against a fixture dispatchd
// status.json: the omlx lane's measured `healthy` flag must survive into the
// lanes.dispatchd.v1 projection.
it('projects the omlx lane health from dispatchd status through phm lanes --json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recut-c167-'));
  vi.stubEnv('HOME', root);
  try {
    await mkdir(join(root, '.ashlr-runs/queue'), { recursive: true });
    await writeFile(join(root, '.ashlr-runs/queue/status.json'), JSON.stringify({
      last_tick: '2026-11-11T12:00:00Z', paused: null, mem_free_pct: 50, schema: 'dispatchd.status.v1',
      lanes: { omlx: { running: 1, target: 2, queued: 1, held: false, healthy: false } },
    }));
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdLanes(['--json'])).toBe(0);
    const json = JSON.parse(out.mock.calls[0]![0] as string);
    expect(json).toMatchObject({ schema: 'lanes.dispatchd.v1', lastTick: '2026-11-11T12:00:00Z' });
    expect(json.lanes).toEqual([
      expect.objectContaining({ lane: 'omlx', running: 1, target: 2, queued: 1, healthy: false }),
    ]);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

it('advertises the --json readout in phm lanes usage', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdLanes(['--help'])).toBe(0);
  expect(out.mock.calls[0]![0]).toContain('phm lanes --json');
});
