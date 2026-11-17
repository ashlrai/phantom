import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('re-reads measured rollups after source loss and repair without retaining stale values or writing state', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'recut-corefleet-c531-'));
  roots.push(runsDir);
  await mkdir(join(runsDir, 'queue'));
  await mkdir(join(runsDir, 'metrics'));
  const path = join(runsDir, 'queue/status.json');
  const metricsPath = join(runsDir, 'metrics/jobs.jsonl');
  const status = (free: number, merged: number) => JSON.stringify({
    schema: 'dispatchd.status.v1', last_tick: '2026-11-16T11:59:00Z', paused: null,
    mem_free_pct: 55, autopilot: { disk: { free_gb: free } },
    lanes: { 'lane-a': { running: 0, target: 1, queued: 0, held: false } },
    rollup_24h: { by_lane: { 'lane-a': { merged, merge_rate: 0 } } },
  });
  const options = { runsDir, now: () => Date.parse('2026-11-16T12:00:00Z') };
  await writeFile(path, status(128, 7));
  await writeFile(metricsPath, '');
  const initial = await readFleetRunsDirState(options);
  expect(initial.diskFreeGb).toBe(128);
  expect(initial.lanes[0]).toMatchObject({ merged24h: 7, mergeRate24h: 0, tokensLastHour: 0 });

  await writeFile(path, '{broken');
  await rm(metricsPath);
  const damaged = await readFleetRunsDirState(options);
  expect(damaged.sources).toMatchObject({ status: 'degraded', metrics: 'missing' });
  expect(damaged.lanes).toEqual([]);
  expect(damaged.diskFreeGb).toBeNull();
  expect(await readFile(path, 'utf8')).toBe('{broken');

  const repaired = status(0, 0);
  await writeFile(path, repaired);
  const recovered = await readFleetRunsDirState(options);
  expect(recovered.sources).toMatchObject({ status: 'healthy', metrics: 'missing' });
  expect(recovered.diskFreeGb).toBe(0);
  expect(recovered.lanes[0]).toMatchObject({ merged24h: 0, mergeRate24h: 0, tokensLastHour: null });
  expect(await readFile(path, 'utf8')).toBe(repaired);
  await expect(readFile(metricsPath)).rejects.toMatchObject({ code: 'ENOENT' });
});
