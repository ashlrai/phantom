import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { createFleetMemoryApi, VERSE_FLEET_DISK_FORECAST_PATH as PATH, VERSE_FLEET_MEMORY_PATH } from '../src/core/verse/fleet-memory-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function call(root: string, path = PATH, method = 'GET', fails = false) {
  let status = 404, body = '';
  const api = createFleetMemoryApi({ runsDir: root, now: () => 7200000, readFiles: async () => ({ memstat: null, memguard: null }), ...(fails ? { readDiskSources: async () => { throw Error('read failed'); } } : {}) });
  const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  await api({ cfg: {} } as VerseApiContext, new PassThrough() as IncomingMessage, res, path, method);
  return { status, body: JSON.parse(body) };
}
async function root() { const dir = await mkdtemp(join(tmpdir(), 'disk-forecast-')); roots.push(dir); return dir; }
it('projects fixture history and preserves the memory route', async () => {
  const dir = await root();
  await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
  await writeFile(join(dir, 'queue/disk-growth-history.json'), JSON.stringify([{ at: 0, free_gb: 200 }, { at: 3600, free_gb: 190 }]));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), '');
  expect(await call(dir)).toMatchObject({ status: 200, body: { v: 1, forecast: { status: 'projected', hoursUntilThreshold: 4, samples: 2 } } });
  expect((await call(dir, VERSE_FLEET_MEMORY_PATH)).status).toBe(200);
});
it('returns unknown for missing or failing sources and rejects POST', async () => {
  const dir = await root();
  expect((await call(dir)).body.forecast.status).toBe('unknown');
  expect((await call(dir, PATH, 'GET', true)).body.forecast.status).toBe('unknown');
  expect((await call(dir, PATH, 'POST')).status).toBe(405);
});
