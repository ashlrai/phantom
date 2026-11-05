import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetCosApi, type FleetCosApiDeps } from '../src/core/verse/fleet-cos-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';
import { cosStatus, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import { deliverTelegramCosResult } from '../src/core/comms/telegram-inbox-bridge.js';
import type { ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';

const TOKEN = 'cos-drafts-test-token';
const DRAFTS = '/api/verse/fleet/cos/drafts';
const APPROVE = '/api/verse/fleet/cos/approve';
const CFG = { comms: { telegram: { chatId: '42' } } } as unknown as AshlrConfig;
let runsDir = '';

async function call(api: ReturnType<typeof createFleetCosApi>, o: { path: string; method?: string; body?: unknown;
  token?: string | null; headers?: Record<string, string>; allowDispatch?: boolean }) {
  const method = o.method ?? (o.path.startsWith(DRAFTS) ? 'GET' : 'POST');
  const req = Readable.from(method === 'GET' ? [] : [JSON.stringify(o.body ?? {})]) as unknown as IncomingMessage;
  req.url = o.path;
  req.method = method;
  req.headers = { 'content-type': 'application/json', ...(o.token === null ? {} : { 'x-ashlr-token': o.token ?? TOKEN }), ...o.headers };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res: { headersSent: boolean; writeHead(code: number): void; end(text: string): void } = {
    headersSent: false,
    writeHead(code: number) { status = code; res.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  };
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: o.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res as unknown as ServerResponse, o.path.split('?')[0]!, method);
  return { handled, status, wire: wire as Record<string, unknown> | null };
}

const key = (n: number) => n.toString(16).repeat(64).slice(0, 64);
async function seed(n: number, channel: ChannelEnvelope['channel'] = 'telegram', text = `Fake reply ${n}.`) {
  // Telegram delivery requires the configured owner as sender and a numeric reply-to thread.
  const id = await queueCosEnvelope({ channel, verifiedSenderId: channel === 'telegram' ? 'telegram:42' : `${channel}:fake-sender`,
    body: `fake task ${n}`, receivedAt: '2026-11-01T12:00:00.000Z', dedupeKey: key(n), threadId: `${700 + n}` }, runsDir);
  const draft = await draftCosResult(id, text, runsDir);
  const at = new Date(Date.UTC(2026, 10, 1, 12, n));
  utimesSync(join(runsDir, 'cos', `${id}.json`), at, at);
  return { id, digest: draft.digest, wire: `sha256:${draft.digest.slice(0, 24)}` };
}
// The real telegram bridge with an injected fake send: the delivery claim is real, the network is not.
// No messageId, so the thread map under HOME is never written.
function telegram(send = vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }))) {
  const deliverTelegram = vi.fn<NonNullable<FleetCosApiDeps['deliverTelegram']>>((i, d, c, x) => deliverTelegramCosResult(i, d, c, { ...x, send }));
  return { send, deliverTelegram, api: createFleetCosApi({ runsDir, loadConfig: () => CFG, deliverTelegram }) };
}

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'cos-drafts-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('GET /api/verse/fleet/cos/drafts', () => {
  it('mounts under fleet-cos and stays off the remote gateway', () => {
    expect(workbenchFamilyFor(DRAFTS)?.id).toBe('fleet-cos');
    expect(classifyRemoteRoute('GET', DRAFTS)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('POST', APPROVE)).toEqual({ kind: 'deny' });
  });

  it('lists drafts newest first with wire digests and no sender or thread ids', async () => {
    const a = await seed(1);
    const b = await seed(2, 'email');
    writeFileSync(join(runsDir, 'cos', `${a.id}.delivery.json`), JSON.stringify({ state: 'sent' }));
    const { api } = telegram();
    const r = await call(api, { path: DRAFTS });
    expect(r.status).toBe(200);
    expect(r.wire).toEqual({ v: 1, malformed: 0, withheld: 0, drafts: [
      { id: b.id, channel: 'email', text: 'Fake reply 2.', digest: b.wire, delivery: 'pending', draftedAt: '2026-11-01T12:02:00.000Z' },
      { id: a.id, channel: 'telegram', text: 'Fake reply 1.', digest: a.wire, delivery: 'sent', draftedAt: '2026-11-01T12:01:00.000Z' },
    ] });
    expect(JSON.stringify(r.wire)).not.toMatch(/[a-f0-9]{64}|senderId|threadId|fake-sender|telegram:42|"70[12]"/);
  });

  it('honors and validates limit, counts malformed, and withholds a private-path draft', async () => {
    await seed(1);
    const newest = await seed(2);
    await seed(3, 'telegram', 'See /Users/fake/notes.txt');
    writeFileSync(join(runsDir, 'cos', `cos-${'b'.repeat(32)}.json`), '{not json');
    const { api } = telegram();
    const one = await call(api, { path: `${DRAFTS}?limit=2` });
    // The private-path draft occupies a slot and is withheld, not echoed.
    expect(one.wire).toMatchObject({ malformed: 1, withheld: 1, drafts: [{ id: newest.id }] });
    expect(JSON.stringify(one.wire)).not.toContain('/Users/');
    for (const bad of ['0', '201', 'x', '-1', '1.5', '']) {
      const r = await call(api, { path: `${DRAFTS}?limit=${bad}` });
      expect(r.status).toBe(400);
      expect(r.wire).toMatchObject({ code: 'VERSE_INVALID' });
    }
  });

  it('returns an empty list before any draft exists, and is gated by allowDispatch', async () => {
    const { api } = telegram();
    expect((await call(api, { path: DRAFTS })).wire).toEqual({ v: 1, drafts: [], malformed: 0, withheld: 0 });
    expect((await call(api, { path: DRAFTS, allowDispatch: false })).status).toBe(404);
    expect((await call(api, { path: DRAFTS, method: 'POST' })).status).toBe(405);
  });
});

describe('POST /api/verse/fleet/cos/approve from the drafts list', () => {
  it('sends the listed telegram draft exactly once and then reports it claimed', async () => {
    const d = await seed(1);
    const { api, send, deliverTelegram } = telegram();
    const listed = (await call(api, { path: DRAFTS })).wire!.drafts as Array<{ id: string; digest: string }>;
    const ok = await call(api, { path: APPROVE, body: { id: listed[0]!.id, digest: listed[0]!.digest } });
    expect(ok.status).toBe(200);
    expect(ok.wire).toEqual({ v: 1, id: d.id, delivery: 'sent' });
    expect(deliverTelegram).toHaveBeenCalledWith(d.id, d.digest, CFG, expect.objectContaining({ runsDir }));
    expect(send).toHaveBeenCalledTimes(1);
    expect((await call(api, { path: DRAFTS })).wire).toMatchObject({ drafts: [{ id: d.id, delivery: 'sent' }] });

    const again = await call(api, { path: APPROVE, body: { id: d.id, digest: d.wire } });
    expect(again.status).toBe(409);
    expect(again.wire).toEqual({ code: 'COS_ALREADY_CLAIMED' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale digest without reaching the transport', async () => {
    const d = await seed(1);
    const { api, send } = telegram();
    const r = await call(api, { path: APPROVE, body: { id: d.id, digest: `sha256:${'0'.repeat(24)}` } });
    expect(r.status).toBe(409);
    expect(r.wire).toEqual({ code: 'COS_APPROVAL_STALE' });
    expect(send).not.toHaveBeenCalled();
    expect((await cosStatus(d.id, runsDir)).delivery).toBeUndefined();
  });

  it('is desktop-only: a mobile channel header is 403 even with the token', async () => {
    const d = await seed(1);
    const { api, send } = telegram();
    const r = await call(api, { path: APPROVE, body: { id: d.id, digest: d.wire }, headers: { 'x-ashlr-channel': 'mobile' } });
    expect(r.status).toBe(403);
    expect(r.wire).toEqual({ code: 'COS_APPROVE_DESKTOP_ONLY' });
    expect(send).not.toHaveBeenCalled();
    expect((await cosStatus(d.id, runsDir)).delivery).toBeUndefined();
  });

  it('refuses a missing token before anything else', async () => {
    const d = await seed(1);
    const { api, send } = telegram();
    for (const headers of [{}, { 'x-ashlr-channel': 'mobile' }] as Array<Record<string, string>>) {
      const r = await call(api, { path: APPROVE, token: null, headers, body: { id: d.id, digest: d.wire } });
      expect(r.status).toBe(401);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('has no transport for a page-origin draft', async () => {
    const d = await seed(1, 'page');
    const { api, deliverTelegram } = telegram();
    const r = await call(api, { path: APPROVE, body: { id: d.id, digest: d.wire } });
    expect(r.status).toBe(422);
    expect(r.wire).toEqual({ code: 'COS_NO_TRANSPORT', channel: 'page' });
    expect(deliverTelegram).not.toHaveBeenCalled();
  });

  it('a transport failure is 502 uncertain, is listed as uncertain, and is never resent', async () => {
    const d = await seed(1);
    const { api, send } = telegram(vi.fn(async () => { throw new Error('fake transport failure with detail'); }));
    const r = await call(api, { path: APPROVE, body: { id: d.id, digest: d.wire } });
    expect(r.status).toBe(502);
    expect(r.wire).toEqual({ code: 'COS_DELIVERY_UNCERTAIN' });
    expect(JSON.stringify(r.wire)).not.toContain('detail');
    expect((await call(api, { path: DRAFTS })).wire).toMatchObject({ drafts: [{ id: d.id, delivery: 'uncertain' }] });
    expect((await call(api, { path: APPROVE, body: { id: d.id, digest: d.wire } })).status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
