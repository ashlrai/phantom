import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetCosApi, type FleetCosApiDeps } from '../src/core/verse/fleet-cos-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';
import { QueueStore } from '../src/core/queue/store.js';
import { cosStatus, draftCosResult, queueCosEnvelope } from '../src/core/cos/intake.js';
import type { ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';

const TOKEN = 'cos-test-token';
const ASK = '/api/verse/fleet/cos/ask';
const STATUS = '/api/verse/fleet/cos/status';
const APPROVE = '/api/verse/fleet/cos/approve';
let runsDir = '';
let clock = Date.parse('2026-11-01T12:00:00Z');

async function call(api: ReturnType<typeof createFleetCosApi>, o: { path: string; method?: string; body?: unknown; raw?: string; token?: string; allowDispatch?: boolean }) {
  const method = o.method ?? (o.path.startsWith(STATUS) ? 'GET' : 'POST');
  const req = Readable.from(method === 'GET' ? [] : [o.raw ?? JSON.stringify(o.body ?? {})]) as unknown as IncomingMessage;
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
const jobIds = async () => (await new QueueStore(join(runsDir, 'queue'), 250).read()).jobs.map(j => j.id).filter(id => id.startsWith('cos-'));
const key = (n: number) => String(n).repeat(64).slice(0, 64);
async function seed(channel: ChannelEnvelope['channel'], n: number, senderId: string, threadId?: string) {
  const id = await queueCosEnvelope({ channel, verifiedSenderId: senderId, body: 'please check the build', receivedAt: new Date(clock).toISOString(),
    dedupeKey: key(n), ...(threadId ? { threadId } : {}) }, runsDir);
  return id;
}

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'cos-api-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('fleet cos api', () => {
  it('mounts under its own family and stays off the remote gateway', () => {
    expect(workbenchFamilyFor(ASK)?.id).toBe('fleet-cos');
    expect(workbenchFamilyFor(APPROVE)?.id).toBe('fleet-cos');
    expect(workbenchFamilyFor('/api/verse/fleet/runs')?.id).toBe('fleet-runs');
    expect(classifyRemoteRoute('POST', APPROVE)).toEqual({ kind: 'deny' });
  });

  it('ask queues a READY job, appends one inbox line, and dedupes a repost', async () => {
    const api = make();
    const first = await call(api, { path: ASK, body: { text: '  ship the cos api  ' } });
    expect(first.status).toBe(201);
    expect(first.wire).toMatchObject({ v: 1, status: 'queued', duplicate: false });
    const id = first.wire!.id as string;
    expect(id).toMatch(/^cos-[a-f0-9]{32}$/);
    expect(JSON.stringify(first.wire)).not.toMatch(/[a-f0-9]{64}/);
    expect(typeof first.wire!.ack).toBe('string');
    expect(await jobIds()).toHaveLength(1);
    expect((await cosStatus(id, runsDir)).job).toMatchObject({ status: 'READY', scope: 'ship the cos api' });
    const inbox = readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8');
    expect(inbox.match(/ship the cos api/g)).toHaveLength(1);
    expect(readFileSync(join(runsDir, 'dispatch-events.log'), 'utf8')).toContain('INBOX new entry from Phantom desktop task');

    const again = await call(api, { path: ASK, body: { text: 'ship the cos api' } });
    expect(again.status).toBe(200);
    expect(again.wire).toMatchObject({ id, duplicate: true });
    expect(await jobIds()).toHaveLength(1);
    expect(readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8').match(/ship the cos api/g)).toHaveLength(1);
  });

  it('ask rejects malformed bodies', async () => {
    const api = make();
    for (const body of [{}, { text: '   ' }, { text: 5 }, { text: 'x', extra: 1 }, { text: 'x'.repeat(16_001) }, []]) {
      const r = await call(api, { path: ASK, body });
      expect(r.status).toBe(400);
      expect(r.wire).toMatchObject({ code: 'VERSE_INVALID' });
    }
    expect((await call(api, { path: ASK, raw: '{nope' })).status).toBe(400);
  });

  it('ask refuses secret-shaped text', async () => {
    const r = await call(make(), { path: ASK, body: { text: 'key sk-ant-api03-' + 'a'.repeat(40) } });
    expect(r.status).toBe(422);
    expect(r.wire).toMatchObject({ code: 'COS_REFUSED' });
    expect(await jobIds()).toHaveLength(0);
  });

  it('status has no draft before a result and a prefixed digest after', async () => {
    const api = make();
    const id = (await call(api, { path: ASK, body: { text: 'status me' } })).wire!.id as string;
    const before = await call(api, { path: `${STATUS}?id=${id}` });
    expect(before.status).toBe(200);
    expect(before.wire).toEqual({ v: 1, id, jobStatus: 'READY', channel: 'desktop', draft: null, delivery: null, needsYou: false });
    const draft = await draftCosResult(id, 'All green.', runsDir);
    const after = await call(api, { path: `${STATUS}?id=${id}` });
    expect(after.wire).toMatchObject({ draft: { text: 'All green.', digest: `sha256:${draft.digest.slice(0, 24)}` }, delivery: null, needsYou: true });
    expect(JSON.stringify(after.wire)).not.toMatch(/[a-f0-9]{64}|senderId|threadId|verse-cos-operator/);
  });

  it('status validates the id and reports unknown jobs', async () => {
    const api = make();
    expect((await call(api, { path: `${STATUS}?id=nope` })).status).toBe(400);
    expect((await call(api, { path: STATUS })).status).toBe(400);
    const missing = await call(api, { path: `${STATUS}?id=cos-${'a'.repeat(32)}` });
    expect(missing.status).toBe(404);
    expect(missing.wire).toEqual({ code: 'COS_UNKNOWN' });
  });

  it('approve rejects a stale digest without calling a transport, then delivers desktop once', async () => {
    const deliverTelegram = vi.fn(); const deliverEmail = vi.fn();
    const api = make({ deliverTelegram, deliverEmail });
    const id = (await call(api, { path: ASK, body: { text: 'approve me' } })).wire!.id as string;
    const noDraft = await call(api, { path: APPROVE, body: { id, digest: `sha256:${'0'.repeat(24)}` } });
    expect(noDraft.status).toBe(409);
    expect(noDraft.wire).toEqual({ code: 'COS_APPROVAL_STALE' });
    const draft = await draftCosResult(id, 'Done.', runsDir);
    const stale = await call(api, { path: APPROVE, body: { id, digest: `sha256:${'0'.repeat(24)}` } });
    expect(stale.status).toBe(409);
    expect(stale.wire).toEqual({ code: 'COS_APPROVAL_STALE' });
    expect(deliverTelegram).not.toHaveBeenCalled();
    expect((await cosStatus(id, runsDir)).delivery).toBeUndefined();

    const ok = await call(api, { path: APPROVE, body: { id, digest: `sha256:${draft.digest.slice(0, 24)}` } });
    expect(ok.status).toBe(200);
    expect(ok.wire).toEqual({ v: 1, id, delivery: 'sent' });
    expect((await call(api, { path: `${STATUS}?id=${id}` })).wire).toMatchObject({ delivery: 'sent', needsYou: false });
    const second = await call(api, { path: APPROVE, body: { id, digest: `sha256:${draft.digest.slice(0, 24)}` } });
    expect(second.status).toBe(409);
    expect(second.wire).toEqual({ code: 'COS_ALREADY_CLAIMED' });
    expect(deliverTelegram).not.toHaveBeenCalled();
    expect(deliverEmail).not.toHaveBeenCalled();
  });

  it('approve ignores request text and rejects extra keys or bare digests', async () => {
    const api = make();
    const id = (await call(api, { path: ASK, body: { text: 'bind me' } })).wire!.id as string;
    const draft = await draftCosResult(id, 'Stored reply.', runsDir);
    const wire = `sha256:${draft.digest.slice(0, 24)}`;
    expect((await call(api, { path: APPROVE, body: { id, digest: wire, text: 'evil' } })).status).toBe(400);
    expect((await call(api, { path: APPROVE, body: { id, digest: draft.digest } })).status).toBe(400);
    expect((await call(api, { path: APPROVE, body: { id: 'x', digest: wire } })).status).toBe(400);
    expect((await cosStatus(id, runsDir)).delivery).toBeUndefined();
  });

  it('approve sends a telegram-origin draft once with the full digest; a failure is uncertain and final', async () => {
    const id = await seed('telegram', 1, 'telegram:42', '7');
    const draft = await draftCosResult(id, 'Telegram reply.', runsDir);
    const cfg = { comms: { telegram: { chatId: '42' } } } as unknown as AshlrConfig;
    const deliverTelegram = vi.fn(async () => { throw new Error('network down'); });
    const api = make({ deliverTelegram, loadConfig: () => cfg });
    const body = { id, digest: `sha256:${draft.digest.slice(0, 24)}` };
    const failed = await call(api, { path: APPROVE, body });
    expect(failed.status).toBe(502);
    expect(failed.wire).toEqual({ code: 'COS_DELIVERY_UNCERTAIN' });
    expect(deliverTelegram).toHaveBeenCalledTimes(1);
    expect(deliverTelegram).toHaveBeenCalledWith(id, draft.digest, cfg, expect.objectContaining({ runsDir }));
    // The mock never claims, so a retry reaches the transport again; the real-claim test below covers finality.
    const retry = await call(api, { path: APPROVE, body });
    expect(retry.status).toBe(502);
  });

  it('a real claim failure leaves status uncertain and blocks retries', async () => {
    const id = await seed('telegram', 2, 'telegram:42', '8');
    const draft = await draftCosResult(id, 'Telegram reply.', runsDir);
    const { deliverTelegramCosResult } = await import('../src/core/comms/telegram-inbox-bridge.js');
    const cfg = { comms: { telegram: { chatId: '42' } } } as unknown as AshlrConfig;
    const send = vi.fn(async () => ({ ok: false as const }));
    const api = make({ loadConfig: () => cfg, deliverTelegram: (i, d, c, x) => deliverTelegramCosResult(i, d, c, { ...x, send }) });
    const body = { id, digest: `sha256:${draft.digest.slice(0, 24)}` };
    expect((await call(api, { path: APPROVE, body })).status).toBe(502);
    expect((await call(api, { path: `${STATUS}?id=${id}` })).wire).toMatchObject({ delivery: 'uncertain', channel: 'telegram' });
    expect((await call(api, { path: APPROVE, body })).status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('approve sends an email-origin draft through the injected outbox and refuses page/mobile', async () => {
    const eid = await seed('email', 3, 'email:mason@example.com', 'msg123@example.com');
    const edraft = await draftCosResult(eid, 'Email reply.', runsDir);
    const deliverEmail = vi.fn(async () => {});
    const api = make({ deliverEmail, outboxDir: join(runsDir, 'outbox') });
    // The mocked transport bypasses the claim, so only the call contract is asserted here.
    const ok = await call(api, { path: APPROVE, body: { id: eid, digest: `sha256:${edraft.digest.slice(0, 24)}` } });
    expect(ok.status).toBe(200);
    expect(deliverEmail).toHaveBeenCalledWith(eid, edraft.digest, { runsDir, outboxDir: join(runsDir, 'outbox') });

    for (const [n, channel] of [[4, 'mobile'], [5, 'page']] as const) {
      const id = await seed(channel, n, 'verse-operator@mobile');
      const d = await draftCosResult(id, 'Reply.', runsDir);
      const r = await call(api, { path: APPROVE, body: { id, digest: `sha256:${d.digest.slice(0, 24)}` } });
      expect(r.status).toBe(422);
      expect(r.wire).toEqual({ code: 'COS_NO_TRANSPORT', channel });
    }
  });

  it('maps an existing delivery claim race to COS_ALREADY_CLAIMED', async () => {
    const id = await seed('email', 6, 'email:mason@example.com', 'msg9@example.com');
    const d = await draftCosResult(id, 'Reply.', runsDir);
    const eexist = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const api = make({ deliverEmail: async () => { throw eexist; }, outboxDir: join(runsDir, 'outbox') });
    const r = await call(api, { path: APPROVE, body: { id, digest: `sha256:${d.digest.slice(0, 24)}` } });
    expect(r.status).toBe(409);
    expect(r.wire).toEqual({ code: 'COS_ALREADY_CLAIMED' });
  });

  it('gates every route: allowDispatch false is 404, a bad token is 401', async () => {
    const api = make();
    for (const path of [ASK, `${STATUS}?id=cos-${'a'.repeat(32)}`, APPROVE]) {
      const r = await call(api, { path, allowDispatch: false, body: { text: 'x' } });
      expect(r.status).toBe(404);
    }
    for (const path of [ASK, APPROVE]) {
      const r = await call(api, { path, token: 'wrong', body: { text: 'x' } });
      expect(r.status).toBe(401);
    }
    expect(await jobIds()).toHaveLength(0);
    expect(await call(api, { path: '/api/verse/fleet/cos/other' })).toMatchObject({ handled: false });
    expect((await call(api, { path: ASK, method: 'GET' })).status).toBe(405);
  });
});
