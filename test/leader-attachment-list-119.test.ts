import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listLeaderAttachments } from '../src/core/verse/leader-attachment-list.js';

it('orders, clamps, and excludes links and invalid names', async () => {
  const dir = join(process.env.ASHLR_RUNS_DIR!, 'inbox-attachments');
  mkdirSync(dir);
  for (let i = 0; i < 102; i++) {
    const file = join(dir, `${i.toString(16).padStart(16, '0')}.png`);
    writeFileSync(file, Buffer.from([137,80,78,71,13,10,26,10]));
    utimesSync(file, i + 1, i + 1);
  }
  writeFileSync(join(dir, 'bad.png'), 'x');
  symlinkSync(join(dir, 'bad.png'), join(dir, 'ffffffffffffffff.png'));
  const result = await listLeaderAttachments({ limit: 200 });
  expect(result.state).toBe('ok');
  expect(result.items).toHaveLength(100);
  expect(result.items[0]?.name).toBe('0000000000000065.png');
  expect((await listLeaderAttachments({ limit: 1 })).items).toHaveLength(1);
});
it('reports an absent directory', async () => {
  expect(await listLeaderAttachments()).toEqual({ state: 'absent', items: [] });
});
const old = process.env.ASHLR_RUNS_DIR;
const runs = mkdtempSync(join(tmpdir(), 'media-test-'));
process.env.ASHLR_RUNS_DIR = runs;
afterEach(() => { rmSync(join(runs, 'inbox-attachments'), { recursive: true, force: true }); });
import { afterAll } from 'vitest';
afterAll(() => { if (old === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = old; rmSync(runs, { recursive: true, force: true }); });
