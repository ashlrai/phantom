import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readMetricsPanel } from '../src/core/fleet/metrics-panel.js';

it('joins the dispatcher rollup to lane capacity and preserves missing readings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'metrics-panel-'));
  try {
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({
      last_tick: '2026-11-09T12:00:00Z', paused: false, mem_free_pct: 50,
      lanes: { work: { running: 2, target: 4, queued: 0, held: false }, other: { running: 0, target: 1, queued: 0, held: false } },
      rollup_24h: { by_lane: { work: { merged: 12, median_ttm_s: 120, empty_rate: 0.25 } } },
    }));
    const report = await readMetricsPanel(root);
    expect(report.hourlyMerges).toBeNull();
    expect(report.lanes).toEqual([
      { lane: 'other', mergesPerHour: null, medianOpenToMergeSeconds: null, emptyRate: null, running: 0, target: 1 },
      { lane: 'work', mergesPerHour: 0.5, medianOpenToMergeSeconds: 120, emptyRate: 0.25, running: 2, target: 4 },
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
