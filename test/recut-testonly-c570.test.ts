import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

it('forgets measured totals when metrics disappear and observes their replacement without changing status', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'recut-corefleet-c556-'));
  try {
    await mkdir(join(runsDir, 'queue'));
    await mkdir(join(runsDir, 'metrics'));
    const tick = '2026-11-17T12:00:00Z';
    const statusPath = join(runsDir, 'queue/status.json');
    const metricsPath = join(runsDir, 'metrics/jobs.jsonl');
    const status = JSON.stringify({
      schema: 'dispatchd.status.v1', last_tick: tick, paused: null, mem_free_pct: 50,
      lanes: { 'fixture-lane': { running: 0, target: 1, queued: 0, held: false, healthy: true } },
    });
    const metric = JSON.stringify({ job: 'fixture-job', lane: 'fixture-lane',
      ts: tick, event: 'finish', tokens_total: 7 });
    await writeFile(statusPath, status);
    await writeFile(metricsPath, metric);
    const read = () => readFleetRunsDirState({ runsDir, now: () => Date.parse(tick) });
    const measured = await read();
    expect(measured.lanes[0]!.tokensLastHour).toBe(7);
    await unlink(metricsPath);
    const missing = await read();
    expect(missing.sources).toMatchObject({ status: 'healthy', metrics: 'missing' });
    expect(missing.lanes[0]).toMatchObject({ healthy: true, tokensLastHour: null });
    await writeFile(metricsPath, '');
    const repaired = await read();
    expect(repaired.sources).toMatchObject({ status: 'healthy', metrics: 'healthy' });
    expect(repaired.lanes[0]).toMatchObject({ healthy: true, tokensLastHour: 0 });
    expect(measured.lanes[0]!.tokensLastHour).toBe(7);
    expect(missing.lanes[0]!.tokensLastHour).toBeNull();
    expect(await readFile(statusPath, 'utf8')).toBe(status);
    expect(await readFile(metricsPath, 'utf8')).toBe('');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
