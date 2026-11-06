import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFleetInboxAcksApi } from '../src/core/verse/fleet-inbox-acks-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inbox-acks-')); await mkdir(join(root, 'queue')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function ledger(rows: unknown[]) { await writeFile(join(root, 'queue/inbox-acks.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
async function call(method = 'GET') {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await createFleetInboxAcksApi({ runsDir: root, now: () => 0 })({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/inbox/acks', method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}
it('keeps the last valid row, drops bad ids and strips reasons', async () => {
  await ledger([{ entryId: 'a', status: 'acked' }, { entryId: 'bad id', status: 'acked' }, { entryId: 'a', status: 'skipped', reason: 'private reason' }]);
  const result = await call();
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ v: 1, generatedAt: new Date(0).toISOString(), available: true, acks: [{ entryId: 'a', status: 'skipped' }] });
  expect(result.text).not.toContain('reason');
});
it('reports a missing ledger as unavailable', async () => { expect((await call()).body).toMatchObject({ available: false, acks: [] }); });
it('returns only the newest 500 ids', async () => {
  await ledger(Array.from({ length: 600 }, (_, i) => ({ entryId: `id-${i}`, status: 'acked' })));
  const { body } = await call();
  expect(body.acks).toHaveLength(500);
  expect(body.acks[0].entryId).toBe('id-100');
});
it('bounds the read and ignores a partial first row and malformed rows', async () => {
  await writeFile(join(root, 'queue/inbox-acks.jsonl'), JSON.stringify({ entryId: 'old', status: 'acked', reason: 'x'.repeat(300_000) }) + '\ninvalid\n' + JSON.stringify({ entryId: 'new', status: 'acked' }) + '\n');
  expect((await call()).body.acks).toEqual([{ entryId: 'new', status: 'acked' }]);
});
it('returns a fixed error for an unreadable ledger', async () => {
  await mkdir(join(root, 'queue/inbox-acks.jsonl'));
  expect(await call()).toMatchObject({ status: 503, body: { error: 'inbox acks unavailable' } });
});
it('declines non-GET requests', async () => { expect(await call('POST')).toMatchObject({ handled: false, status: 0 }); });
