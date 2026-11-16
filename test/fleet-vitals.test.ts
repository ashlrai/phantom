import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetVitals } from '../src/cli/fleet-vitals.js';

it('reads directory deltas and distinguishes missing, partial, stale and invalid evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitals-'));
  try {
    expect((await readFleetVitals(root)).status).toBe('unknown');
    await mkdir(join(root, 'queue'));
    const disk = { sampled_at: 100, previous_sampled_at: 90, free_gb: 200, timed_out: false,
      growth_gb_per_h: null, hours_to_reuse_only: null, directories: [{ path: 'logs', size_gb: 2, delta_gb: -1 }] };
    const save = () => writeFile(join(root, 'queue/disk-growth.json'), JSON.stringify(disk));
    await save();
    expect(await readFleetVitals(root, 100_000)).toMatchObject({ status: 'ok', disk });
    expect((await readFleetVitals(root, 1_000_001)).status).toBe('stale');
    expect((await readFleetVitals(root, 99_000)).status).toBe('unknown');
    disk.timed_out = true; await save();
    expect((await readFleetVitals(root, 100_000)).status).toBe('partial');
    await writeFile(join(root, 'queue/disk-growth.json'), '{}');
    expect((await readFleetVitals(root)).disk).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
