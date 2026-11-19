import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

// Distinct from recut-corefleet-c539 (valid -> damaged -> repaired): here the
// sources start missing and are created later, on the same runs directory.
it('recovers from missing sources to created status and a measured-zero metric', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'lanes-recovery-624s-'));
  const runsDir = join(parent, 'runs');
  const tick = '2026-11-18T12:00:00Z';
  const read = () => readFleetRunsDirState({ runsDir, now: () => Date.parse(tick) });
  try {
    const absent = await read();
    expect(absent).toMatchObject({ runsDirPresent: false, lastTick: null, lanes: [] });
    expect(absent.sources.status).toBe('missing');

    await mkdir(join(runsDir, 'queue'), { recursive: true });
    const empty = await read();
    expect(empty.runsDirPresent).toBe(true);
    expect(empty.sources.status).toBe('missing');
    expect(empty.lanes).toEqual([]);

    const statusPath = join(runsDir, 'queue/status.json');
    const status = JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: tick, paused: null, mem_free_pct: 50,
      lanes: { 'fake-lane': { running: 0, target: 1, queued: 0, held: false, healthy: false } },
    });
    await writeFile(statusPath, status);
    const created = await read();
    expect(created.sources.status).toBe('healthy');
    expect(created.lanes[0]).toMatchObject({ lane: 'fake-lane', healthy: false, tokensLastHour: null });

    await mkdir(join(runsDir, 'metrics'));
    const metricsPath = join(runsDir, 'metrics/jobs.jsonl');
    const metric = JSON.stringify({ job: 'fake-job', lane: 'fake-lane', ts: tick, event: 'finish', tokens_total: 0 });
    await writeFile(metricsPath, metric);
    const measured = await read();
    expect(measured.sources).toMatchObject({ status: 'healthy', metrics: 'healthy' });
    expect(measured.lanes[0]).toMatchObject({ healthy: false, tokensLastHour: 0 });

    // Earlier snapshots keep what they observed; inputs were never rewritten.
    expect(absent.lanes).toEqual([]);
    expect(created.lanes[0]!.tokensLastHour).toBeNull();
    expect(await readFile(statusPath, 'utf8')).toBe(status);
    expect(await readFile(metricsPath, 'utf8')).toBe(metric);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
