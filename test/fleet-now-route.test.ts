import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fleet-now-'));
  vi.stubEnv('ASHLR_JOBS_STOP_FILE', join(dir, 'stops.tsv'));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
async function call(method = 'GET') {
  let status = 404, body = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  await createFleetRunsApi({ runsDir: dir })({ cfg: {} } as VerseApiContext, new PassThrough() as IncomingMessage, res, '/api/verse/fleet/runs/leader-brief', method);
  return { status, body: JSON.parse(body) };
}
it('returns the exact tick snapshot in the CLI schema from a temporary state directory', async () => {
  await mkdir(join(dir, 'metrics'));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), JSON.stringify({ job: 'work', event: 'merged', ts: '2026-11-21T12:00:00Z' }));
  const brief = await writeCompactBrief(dir, Date.parse('2026-11-21T12:00:00Z'));
  expect(await call()).toEqual({ status: 200, body: brief });
  expect((await call('POST')).status).toBe(405);
});
it('returns 200 with no data for a missing or malformed snapshot', async () => {
  const empty = { status: 200, body: { schema: 'leader.compact-brief.v1', state: 'no data' } };
  expect(await call()).toEqual(empty);
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'queue/leader-brief.json'), 'broken');
  expect(await call()).toEqual(empty);
});
