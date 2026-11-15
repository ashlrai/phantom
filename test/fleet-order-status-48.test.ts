import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { addIntent } from '../src/core/intent/edit.js';
import { readLedger } from '../src/core/intent/store.js';
import { applyOrderStatus, OrderStatusError } from '../src/core/verse/fleet-order-status.js';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/fleet/runs/orders/status';
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
let root: string;
let id: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'order-status-'));
  id = (await addIntent({ title: 'Ship the example release', source: 'fixture', status: 'in-progress', now: '2026-11-01T00:00:00.000Z' }, root)).id;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function refused(promise: Promise<unknown>): Promise<number> {
  try { await promise; } catch (e) { if (e instanceof OrderStatusError) return e.status; throw e; }
  throw new Error('expected refusal');
}

it('closes, drops and reopens through the real ledger statuses', async () => {
  const done = await applyOrderStatus({ id, status: 'done' }, { root, now: () => NOW });
  expect(done).toMatchObject({ id, status: 'closed', lastTouchedAt: '2026-11-09T12:00:00.000Z' });
  const reopened = await applyOrderStatus({ id, status: 'queued' }, { root, now: () => NOW });
  expect(reopened.status).toBe('queued');
  const dropped = await applyOrderStatus({ id, status: 'dropped', note: 'no longer wanted' }, { root, now: () => NOW });
  expect(dropped.status).toBe('superseded');
  const item = (await readLedger(root)).items.find(i => i.id === id)!;
  expect(item.status).toBe('superseded');
  expect(item.evidence.at(-1)).toMatchObject({ note: 'no longer wanted' });
});

it('never returns evidence or provenance', async () => {
  const row = await applyOrderStatus({ id, status: 'done', note: 'secret-looking note' }, { root, now: () => NOW });
  expect(Object.keys(row).sort()).toEqual(['id', 'lastTouchedAt', 'prs', 'rq', 'stale', 'status', 'title']);
  expect(JSON.stringify(row)).not.toContain('secret-looking note');
});

it('refuses bad id and status (400), missing id (404), long note and no-op (400)', async () => {
  expect(await refused(applyOrderStatus({ id: '../x', status: 'done' }, { root }))).toBe(400);
  expect(await refused(applyOrderStatus({ id, status: 'shipped' }, { root }))).toBe(400);
  expect(await refused(applyOrderStatus({ id: 'int-0000000000000000', status: 'done' }, { root }))).toBe(404);
  expect(await refused(applyOrderStatus({ id, status: 'done', note: 'x'.repeat(301) }, { root }))).toBe(400);
  await applyOrderStatus({ id, status: 'done' }, { root });
  expect(await refused(applyOrderStatus({ id, status: 'done' }, { root }))).toBe(400);
  expect((await readLedger(root)).items[0]!.status).toBe('closed');
});

async function call(body: unknown, opts: { token?: string; allowDispatch?: boolean; method?: string } = {}) {
  const api = createFleetRunsApi({ runsDir: root, now: () => NOW });
  const method = opts.method ?? 'POST';
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: PATH, headers: { 'content-type': 'application/json', 'x-ashlr-token': opts.token ?? 'fixture-token' } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = { writeHead(c: number) { status = c; return this; }, end(c?: string) { payload = c ?? ''; return this; } } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: opts.allowDispatch ?? true } as VerseApiContext;
  await api(ctx, req, res, PATH, method);
  return { status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

it('route: refuses without the mutation gate or dispatch and leaves the ledger alone', async () => {
  expect((await call({ id, status: 'done' }, { token: '' })).status).toBe(401);
  expect((await call({ id, status: 'done' }, { token: 'wrong' })).status).toBe(401);
  expect((await call({ id, status: 'done' }, { allowDispatch: false })).status).toBe(404);
  expect((await call(undefined, { method: 'GET' })).status).toBe(405);
  expect((await readLedger(root)).items[0]!.status).toBe('in-progress');
});

it('route: 200 with the row, 400 for bad bodies, 404 for a missing order', async () => {
  const ok = await call({ id, status: 'done' });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ id, status: 'closed' });
  expect(ok.body).not.toHaveProperty('evidence');
  expect(ok.body).not.toHaveProperty('provenance');
  expect((await call({ id, status: 'done' })).status).toBe(400);
  expect((await call({ id: 'bad id', status: 'done' })).status).toBe(400);
  expect((await call({ id, status: 'done', extra: 1 })).status).toBe(400);
  expect((await call({ id: 'int-0000000000000000', status: 'done' })).status).toBe(404);
});
