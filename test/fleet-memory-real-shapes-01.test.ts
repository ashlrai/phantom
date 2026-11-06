/** The real ~/.ashlr-runs files on the Mac: memstat.json stamps epoch SECONDS
 *  and .memguard2.json holds stopped as a process-group→job-id map with calm
 *  and omlx_down — no level field. (RQ-PHX-MEMORYGUARDHOSTCARD01) */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFleetMemoryFiles } from '../src/core/fleet/memory-files.js';
import { memoryView } from '../src/core/fleet/memory-view.js';

const TS_SECONDS = 1793589510;
const SAMPLED_AT = new Date(TS_SECONDS * 1000).toISOString();
const NOW = TS_SECONDS * 1000 + 30_000;
const MEMSTAT = {
  schema: 'ashlr.memstat.v1',
  ts: TS_SECONDS,
  free_pct: 58,
  swap_gb: 0,
  swapouts_total: 0,
  swapouts_per_min: 0,
  disk_gb: 601,
  inode_free_pct: 99,
};
const MEMGUARD = { stopped: {}, calm: 8, omlx_down: false };
const GUARD_HOLDING = { stopped: { '4242': 'RQ-PHX-A' }, calm: 8, omlx_down: false };

describe('the real bridge files on the Mac', () => {
  it('reads epoch-seconds ts, the stopped map, omlx_down and calm', () => {
    const view = memoryView(MEMSTAT, GUARD_HOLDING, NOW);
    expect(view.sample).toMatchObject({
      free_pct: 58, swap_gb: 0, swapouts_per_min: 0, disk_gb: 601,
      sampled_at: SAMPLED_AT, age_ms: 30_000, stale: false,
    });
    expect(view.memguard).toEqual({ level: null, stopped: ['RQ-PHX-A'], omlx_down: false, calm: 8 });
  });

  it('reports an empty stopped map as unknown, not none, and drops absent fields', () => {
    expect(memoryView(MEMSTAT, MEMGUARD, NOW).memguard).toEqual({ level: null, stopped: null, omlx_down: false, calm: 8 });
    expect(memoryView(null, null, NOW).memguard).toEqual({ level: null, stopped: null });
  });

  it('flags a real sample stale once it passes five minutes', () => {
    const view = memoryView(MEMSTAT, MEMGUARD, TS_SECONDS * 1000 + 300_001);
    expect(view.sample).toMatchObject({ age_ms: 300_001, stale: true });
  });

  it('keeps only identifier values from the stopped map', () => {
    const stopped = memoryView(null, { stopped: { '1': 'RQ-PHX-A', '2': 'bad id!', '3': 42, '4': 'RQ-PHX-B' } }, NOW).memguard.stopped;
    expect(stopped).toEqual(['RQ-PHX-A', 'RQ-PHX-B']);
  });

  it('round-trips the real file bytes through readFleetMemoryFiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-memory-real-'));
    try {
      await writeFile(join(root, 'memstat.json'), JSON.stringify(MEMSTAT));
      await writeFile(join(root, '.memguard2.json'), JSON.stringify(GUARD_HOLDING));
      const files = await readFleetMemoryFiles(root);
      const view = memoryView(files.memstat, files.memguard, NOW);
      expect(view.sample.sampled_at).toBe(SAMPLED_AT);
      expect(view.sample.stale).toBe(false);
      expect(view.memguard).toEqual({ level: null, stopped: ['RQ-PHX-A'], omlx_down: false, calm: 8 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats numbers below 1e11 as seconds and at/above as milliseconds', () => {
    expect(memoryView({ ts: 1e11 - 1 }, null, 0).sample.sampled_at).toBe(new Date((1e11 - 1) * 1000).toISOString());
    expect(memoryView({ ts: 1e11 }, null, 0).sample.sampled_at).toBe(new Date(1e11).toISOString());
    expect(memoryView({ ts: NOW + 60_000 }, null, NOW).sample.age_ms).toBe(-60_000);
  });
});
