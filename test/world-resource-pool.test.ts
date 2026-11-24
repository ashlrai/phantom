import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readResourcePool } from '../src/core/world/read.js';

const previous = process.env['ASHLR_RUNS_DIR'];
let root = '';
afterEach(async () => {
  if (previous === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = previous;
  if (root) await rm(root, { recursive: true, force: true });
});

it('reads only display fields from the configured pool and refuses symlinks', async () => {
  root = await mkdtemp(join(tmpdir(), 'world-pool-'));
  process.env['ASHLR_RUNS_DIR'] = root;
  await mkdir(join(root, 'state'));
  const path = join(root, 'state', 'resource-pool.json');
  await writeFile(path, JSON.stringify({ entries: { dot: { usage: 2, billing_type: 'api', private: 'not exported' } },
    live: { readings: { dot: { used: 2, source: 'official' } } }, private: 'not exported' }));
  expect(await readResourcePool()).toEqual({ entries: [{ id: 'dot', usage: 2, billing_type: 'api' }],
    live: { readings: [{ id: 'dot', used: 2, source: 'official' }] } });
  await rm(path);
  await symlink(join(root, 'missing'), path);
  expect(await readResourcePool()).toBeNull();
});
