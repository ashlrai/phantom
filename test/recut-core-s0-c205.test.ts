import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueStore } from '../src/core/queue/store.js';
import { cmdQueue } from '../src/cli/queue.js';
import type { QueueJob } from '../src/core/queue/schema.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('recut RQ-PHX-RECUTCORES0C205 (PR #5204 spawn.v1 lifecycle)', () => {
  it('spawns a PROPOSED child, then the operator promotes it to claimable READY', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phantom-recut-c205-'));
    dirs.push(dir);
    const store = new QueueStore(dir);
    const parent: QueueJob = {
      id: 'RQ-PARENT', status: 'CLAIMED', priority: 'P3', pool: 'devin', tier: 'work', repo: 'phantom',
      deps: [], scope: 'Parent scope', acceptance: 'Tests pass',
      claims: [{ owner: 'worker-1', claimedAt: '2026-11-12T00:00:00Z' }],
    };
    await store.add(parent);
    const file = join(dir, 'spawn.json');
    await writeFile(file, JSON.stringify({
      schema: 'spawn.v1', parent: 'RQ-PARENT', owner: 'worker-1',
      jobs: [{ id: 'RQ-C1', scope: 'Implement the slice', acceptance: 'vitest passes' }],
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdQueue(['spawn', file, '--dir', dir, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'spawn-result.v1', applied: ['RQ-C1'] });
    const spawned = (await store.read()).jobs.find(j => j.id === 'RQ-C1')!;
    expect([spawned.status, spawned.parent, spawned.depth]).toEqual(['PROPOSED', 'RQ-PARENT', 1]);
    const journal = await readFile(join(dir, 'spawn-proposals.jsonl'), 'utf8');
    expect(JSON.parse(journal.trim())).toMatchObject({ v: 1, parent: 'RQ-PARENT', applied: 1 });
    expect(await cmdQueue(['promote', 'RQ-C1', '--dir', dir, '--json'])).toBe(0);
    expect(await cmdQueue(['claim', 'RQ-C1', '--owner', 'worker-2', '--dir', dir, '--json'])).toBe(0);
    expect((await store.read()).jobs.find(j => j.id === 'RQ-C1')!.status).toBe('CLAIMED');
  });
});
