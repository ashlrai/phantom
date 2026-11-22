import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

it('preserves measured zero through status damage and isolates returned snapshots during repair', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'recut-corefleet-c539-'));
  try {
    await mkdir(join(runsDir, 'queue'));
    await mkdir(join(runsDir, 'metrics'));
    const statusPath = join(runsDir, 'queue/status.json');
    const metricsPath = join(runsDir, 'metrics/jobs.jsonl');
    const tick = '2026-11-17T12:00:00Z';
    const status = JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: tick, paused: null, mem_free_pct: 50,
      lanes: { 'fixture-lane': { running: 0, target: 1, queued: 0, held: false, healthy: false } },
    });
    const metric = JSON.stringify({ job: 'fixture-job', lane: 'fixture-lane',
      ts: tick, event: 'finish', tokens_total: 0 });
    await writeFile(statusPath, status);
    await writeFile(metricsPath, metric);
    const read = () => readFleetRunsDirState({ runsDir, now: () => Date.parse(tick) });
    const initial = await read();
    expect(initial.sources).toMatchObject({ status: 'healthy', metrics: 'healthy' });
    expect(initial.lanes[0]).toMatchObject({ healthy: false, tokensLastHour: 0 });
    await writeFile(statusPath, '{broken');
    const damaged = await read();
    expect(damaged.sources).toMatchObject({ status: 'degraded', metrics: 'healthy' });
    expect(damaged.lanes).toEqual([]);
    expect(damaged.lastTick).toBeNull();
    expect(initial.lanes).toHaveLength(1);
    await writeFile(statusPath, status);
    initial.lanes[0]!.running = 99;
    const repaired = await read();
    expect(repaired.lanes[0]).toMatchObject({ running: 0, healthy: false, tokensLastHour: 0 });
    expect(damaged.lanes).toEqual([]);
    expect(await readFile(statusPath, 'utf8')).toBe(status);
    expect(await readFile(metricsPath, 'utf8')).toBe(metric);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
