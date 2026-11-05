import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetCosApi, VERSE_FLEET_COS_RECONCILE_PATH as RECONCILE } from '../src/core/verse/fleet-cos-api.js';
import { cosStatus, deliverCosResult, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';

const TOKEN = 'cos-test-token';
let runsDir = '';
let clock = Date.parse('2026-11-01T12:00:00Z');

async function call(api: ReturnType<typeof createFleetCosApi>, o: { body?: unknown; raw?: string; token?: string; method?: string }) {
  const method = o.method ?? 'POST';
  const req = Readable.from([o.raw ?? JSON.stringify(o.body ?? {})]) as unknown as IncomingMessage;
  req.url = RECONCILE;
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...(o.token === '' ? {} : { 'x-ashlr-token': o.token ?? TOKEN }) };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext;
  const handled = await api(ctx, req, res, RECONCILE, method);
  return { handled, status, wire: wire as Record<string, unknown> | null };
}

/** A desktop job with a drafted reply whose send threw, leaving delivery 'uncertain'. */
async function uncertainJob(n: number): Promise<{ id: string; digest: string }> {
  const id = await queueCosEnvelope({ channel: 'desktop', verifiedSenderId: 'verse-cos-operator', body: 'please check the build',
    receivedAt: new Date(clock).toISOString(), dedupeKey: String(n).repeat(64).slice(0, 64) }, runsDir);
  const draft = await draftCosResult(id, 'All green.', runsDir);
  await expect(deliverCosResult(id, draft.digest, async () => { throw new Error('network down'); }, runsDir)).rejects.toThrow('network down');
  expect((await cosStatus(id, runsDir)).delivery).toBe('uncertain');
  return { id, digest: draft.digest };
}
const make = () => createFleetCosApi({ runsDir, now: () => (clock += 1000) });

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'cos-reconcile-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('fleet cos reconcile api', () => {
  it('delivered marks an uncertain reply sent', async () => {
    const { id } = await uncertainJob(1);
    const r = await call(make(), { body: { id, verdict: 'delivered' } });
    expect(r.status).toBe(200);
    expect(r.wire).toEqual({ v: 1, id, delivery: 'sent' });
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
  });

  it('retry clears the claim so one more approval can send', async () => {
    const { id, digest } = await uncertainJob(2);
    const r = await call(make(), { body: { id, verdict: 'retry' } });
    expect(r.status).toBe(200);
    expect(r.wire).toEqual({ v: 1, id, delivery: null });
    expect((await cosStatus(id, runsDir)).delivery).toBeUndefined();
    await deliverCosResult(id, digest, async () => {}, runsDir);
    expect((await cosStatus(id, runsDir)).delivery).toBe('sent');
  });

  it('rejects a bad body with VERSE_INVALID', async () => {
    const api = make();
    const id = `cos-${'a'.repeat(32)}`;
    for (const body of [{}, { id }, { verdict: 'retry' }, { id, verdict: 'nope' }, { id: 'x', verdict: 'retry' },
      { id, verdict: 'retry', extra: 1 }, { id: 5, verdict: 'retry' }, []]) {
      const r = await call(api, { body });
      expect(r.status).toBe(400);
      expect(r.wire).toMatchObject({ code: 'VERSE_INVALID' });
    }
    expect((await call(api, { raw: '{nope' })).status).toBe(400);
  });

  it('refuses a missing or wrong token and changes nothing', async () => {
    const { id } = await uncertainJob(3);
    for (const token of ['', 'wrong']) {
      const r = await call(make(), { token, body: { id, verdict: 'delivered' } });
      expect(r.status).toBe(401);
    }
    expect((await cosStatus(id, runsDir)).delivery).toBe('uncertain');
    expect((await call(make(), { method: 'GET' })).status).toBe(405);
  });

  it('a fresh sending claim is 409 COS_STILL_SENDING and untouched', async () => {
    const { id } = await uncertainJob(4);
    writeFileSync(join(runsDir, 'cos', `${id}.delivery.json`), JSON.stringify({ state: 'sending' }));
    const r = await call(createFleetCosApi({ runsDir }), { body: { id, verdict: 'retry' } });
    expect(r.status).toBe(409);
    expect(r.wire).toEqual({ code: 'COS_STILL_SENDING' });
    expect((await cosStatus(id, runsDir)).delivery).toBe('sending');
  });

  it('maps nothing-to-reconcile and unknown jobs without echoing error text', async () => {
    const api = make();
    const id = await queueCosEnvelope({ channel: 'desktop', verifiedSenderId: 'verse-cos-operator', body: 'fresh',
      receivedAt: new Date(clock).toISOString(), dedupeKey: '5'.repeat(64) }, runsDir);
    const idle = await call(api, { body: { id, verdict: 'delivered' } });
    expect(idle.status).toBe(409);
    expect(idle.wire).toEqual({ code: 'COS_NOTHING_TO_RECONCILE' });
    const missing = await call(api, { body: { id: `cos-${'b'.repeat(32)}`, verdict: 'retry' } });
    expect(missing.status).toBe(404);
    expect(missing.wire).toEqual({ code: 'COS_UNKNOWN' });
  });
});
