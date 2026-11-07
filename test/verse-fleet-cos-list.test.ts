import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetCosApi, VERSE_FLEET_COS_LIST_PATH, type FleetCosApiDeps } from '../src/core/verse/fleet-cos-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';
import { QueueStore } from '../src/core/queue/store.js';
import type { QueueJob } from '../src/core/queue/schema.js';
import { draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import type { ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';

const TOKEN = 'cos-list-test-token';
const LIST = VERSE_FLEET_COS_LIST_PATH;
let runsDir = '';
let clock = Date.parse('2026-11-01T12:00:00Z');

async function call(api: ReturnType<typeof createFleetCosApi>, o: { path: string; method?: string; token?: string; allowDispatch?: boolean }) {
  const method = o.method ?? 'GET';
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = o.path;
  req.method = method;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': o.token ?? TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: o.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, o.path.split('?')[0]!, method);
  return { handled, status, wire: wire as Record<string, unknown> | null };
}
const make = (over: FleetCosApiDeps = {}) => createFleetCosApi({ runsDir, now: () => (clock += 1000), ...over });
// First 32 hex chars of the dedupe key become the job id: cos-000…00<n>.
const key = (n: number) => String(n).padStart(32, '0') + '0'.repeat(32);
async function seed(body: string, n: number, channel: ChannelEnvelope['channel'] = 'telegram', senderId = 'test-sender', threadId?: string) {
  return queueCosEnvelope({ channel, verifiedSenderId: senderId, body, receivedAt: new Date(clock).toISOString(),
    dedupeKey: key(n), ...(threadId ? { threadId } : {}) }, runsDir);
}
const rawJob = (over: Partial<QueueJob> & { id: string }): QueueJob => ({
  status: 'READY', priority: 'P1', pool: 'work', tier: 'work', repo: 'ashlrai/phantom',
  scope: 'not a cos task', acceptance: '{}', deps: [], claims: [], ...over });
const delivery = (id: string, state: 'sending' | 'sent' | 'uncertain') => {
  mkdirSync(join(runsDir, 'cos'), { recursive: true });
  writeFileSync(join(runsDir, 'cos', `${id}.delivery.json`), JSON.stringify({ state }));
};

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'cos-list-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('fleet cos list api', () => {
  it('stays in the fleet-cos family and reaches the remote gateway as bounded reads only', () => {
    expect(LIST).toBe('/api/verse/fleet/cos/list');
    expect(workbenchFamilyFor(LIST)?.id).toBe('fleet-cos');
    expect(classifyRemoteRoute('GET', LIST)).toEqual({ kind: 'read', path: LIST });
    expect(classifyRemoteRoute('GET', `${LIST}?limit=5`)).toEqual({ kind: 'read', path: LIST });
    expect(classifyRemoteRoute('GET', `${LIST}?limit=51`)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('POST', LIST)).toEqual({ kind: 'deny' });
  });

  it('lists intake jobs newest first and honors limit', async () => {
    const api = make();
    const ids = [await seed('first task', 1), await seed('second task', 2), await seed('third task', 3)];
    expect(ids[0]).toBe(`cos-${'0'.repeat(31)}1`);

    const all = await call(api, { path: LIST });
    expect(all.status).toBe(200);
    expect(all.wire!.v).toBe(1);
    const tasks = all.wire!.tasks as Record<string, unknown>[];
    expect(tasks.map(t => t.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(tasks[0]).toMatchObject({ jobStatus: 'READY', channel: 'telegram', needsYou: false, delivery: null, hasDraft: false, request: 'third task' });

    const two = await call(api, { path: `${LIST}?limit=2` });
    expect((two.wire!.tasks as Record<string, unknown>[]).map(t => t.id)).toEqual([ids[2], ids[1]]);
  });

  it('ignores non-cos jobs and cos ids without intake acceptance', async () => {
    const api = make();
    const id = await seed('real intake', 4);
    const store = new QueueStore(join(runsDir, 'queue'), 250);
    await store.add(rawJob({ id: 'RQ-TEST-9' }));
    await store.add(rawJob({ id: `cos-${'f'.repeat(32)}`, acceptance: JSON.stringify({ kind: 'other', origin: { channel: 'telegram' } }) }));
    await store.add(rawJob({ id: `cos-${'e'.repeat(32)}`, acceptance: 'not json' }));
    await store.add(rawJob({ id: `cos-${'d'.repeat(32)}`, acceptance: JSON.stringify({ kind: 'cos-intake' }) }));

    const r = await call(api, { path: LIST });
    expect(r.status).toBe(200);
    expect((r.wire!.tasks as Record<string, unknown>[]).map(t => t.id)).toEqual([id]);
  });

  it('reports needsYou with a draft and no delivery, and clears it once sent', async () => {
    const api = make();
    const awaiting = await seed('draft me', 5);
    const sent = await seed('sent me', 6);
    await draftCosResult(awaiting, 'Draft reply one.', runsDir);
    await draftCosResult(sent, 'Draft reply two.', runsDir);
    delivery(sent, 'sent');

    const r = await call(api, { path: LIST });
    const tasks = r.wire!.tasks as Record<string, unknown>[];
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    expect(byId[awaiting]).toMatchObject({ needsYou: true, delivery: null, hasDraft: true });
    expect(byId[sent]).toMatchObject({ needsYou: false, delivery: 'sent', hasDraft: true });
  });

  it('collapses the request to one line and truncates at 140 characters', async () => {
    const api = make();
    const long = 'x'.repeat(200);
    const longId = await seed(long, 7);
    const multiId = await seed('line one\nline two\r\nline three', 8);

    const tasks = (await call(api, { path: LIST })).wire!.tasks as Record<string, unknown>[];
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    expect(byId[longId]!.request).toBe('x'.repeat(140));
    expect(byId[multiId]!.request).toBe('line one line two line three');
  });

  it('lists a private-path request as the empty string', async () => {
    const api = make();
    const id = await seed('inspect /Users/mason/Documents/secret.txt please', 9);
    const tasks = (await call(api, { path: LIST })).wire!.tasks as Record<string, unknown>[];
    expect(tasks[0]!.id).toBe(id);
    expect(tasks[0]!.request).toBe('');
  });

  it('never returns senderId, threadId, draft text or digest', async () => {
    const api = make();
    const id = await seed('private intake', 10, 'email', 'test-sender', 'test-thread');
    await draftCosResult(id, 'UNIQUE-DRAFT-BODY-TEXT', runsDir);
    const r = await call(api, { path: LIST });
    expect(r.status).toBe(200);
    const json = JSON.stringify(r.wire);
    expect(json).not.toContain('senderId');
    expect(json).not.toContain('threadId');
    expect(json).not.toContain('test-sender');
    expect(json).not.toContain('test-thread');
    expect(json).not.toContain('UNIQUE-DRAFT-BODY-TEXT');
    expect(json).not.toContain('digest');
  });

  it('is 404 without allowDispatch, 405 on POST, and read-only without a token', async () => {
    const api = make();
    expect((await call(api, { path: LIST, allowDispatch: false })).status).toBe(404);
    expect((await call(api, { path: LIST, method: 'POST' })).status).toBe(405);
    expect((await call(api, { path: LIST, token: 'wrong' })).status).toBe(200);
  });

  it('rejects bad limits', async () => {
    const api = make();
    for (const limit of ['0', 'abc', '-1', '51', '1.5', '']) {
      const r = await call(api, { path: `${LIST}?limit=${limit}` });
      expect(r.status).toBe(400);
      expect(r.wire).toMatchObject({ code: 'VERSE_INVALID' });
    }
    expect((await call(api, { path: `${LIST}?limit=50` })).status).toBe(200);
  });

  it('is 503 when the queue is unreadable', async () => {
    const api = make();
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'queue.v1.json'), 'not json');
    const r = await call(api, { path: LIST });
    expect(r.status).toBe(503);
    expect(r.wire).toMatchObject({ code: 'COS_UNAVAILABLE' });
  });
});
