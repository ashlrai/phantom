import { mkdtemp, mkdir, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fleetGhosts } from '../src/core/fleet/ghosts.js';

it('reads base-only attempts, filters finished and reaping attempts, and never writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-original-'));
  try {
    const run = join(root, 'queue/run'); await mkdir(run, { recursive: true });
    const past = new Date(Date.now() - 4 * 3600000);
    for (const id of ['orphan', 'finished', 'reaping', 'other']) {
      const base = join(root, `${id}.base`); await writeFile(base, 'repo branch path codex-local'); await utimes(base, past, past);
    }
    await writeFile(join(run, 'finished.fin'), String(Math.floor(past.getTime() / 1000)));
    await writeFile(join(run, 'other.fin'), '1');
    await mkdir(join(run, 'reaping.reaping'));
    const before = await readdir(run);
    const report = await fleetGhosts({ runsDir: root, now: () => Date.now(), alive: () => false });
    expect(report.known).toBe(true);
    expect(report.jobs.map(j => j.id).sort()).toEqual(['orphan', 'other']);
    expect(report.jobs.every(j => j.lane === 'codex-local' && j.state === 'ghost')).toBe(true);
    expect(await readdir(run)).toEqual(before);
    expect((await fleetGhosts({ runsDir: join(root, 'missing') })).known).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
