import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { explainRoutes } from '../src/core/queue/route-explain.js';

it('counts only accepted moves in the trailing hour and reports unavailable state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'route-explain-'));
  try {
    expect((await explainRoutes(root, 10000))['route-moves-per-hour']).toBeNull();
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/route-state.json'), JSON.stringify({ job: {
      pool: 'claude', decided_at: 9999, moves: [6400, 6401, 9999, 10001],
    } }));
    const report = await explainRoutes(root, 10000);
    expect(report['route-moves-per-hour']).toBe(2);
    expect(report.lines[0]['route-moves-per-hour']).toBe(2);
    await writeFile(join(root, 'queue/route-state.json'), '{');
    expect((await explainRoutes(root)).available).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
