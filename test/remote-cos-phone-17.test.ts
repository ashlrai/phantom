import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetCosApi, type FleetCosApiDeps } from '../src/core/verse/fleet-cos-api.js';
import { classifyRemoteRoute, validateRemoteMutation } from '../src/core/web/remote-gateway-policy.js';
import { remoteChannelHeaders } from '../src/core/web/remote-gateway.js';

const TOKEN = 'cos-phone-test-token';
const ASK = '/api/verse/fleet/cos/ask';
const LIST = '/api/verse/fleet/cos/list';
const STATUS = '/api/verse/fleet/cos/status';
const APPROVE = '/api/verse/fleet/cos/approve';
const JOB = `cos-${'a'.repeat(32)}`;

let runsDir = '';
let clock = Date.parse('2026-11-04T12:00:00Z');

async function call(api: ReturnType<typeof createFleetCosApi>, o: { path: string; method?: string; body?: unknown; channel?: string }) {
  const method = o.method ?? 'GET';
  const req = Readable.from(method === 'GET' ? [] : [JSON.stringify(o.body ?? {})]) as unknown as IncomingMessage;
  req.url = o.path;
  req.method = method;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
  if (o.channel !== undefined) req.headers['x-ashlr-channel'] = o.channel;
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext;
  const handled = await api(ctx, req, res, o.path.split('?')[0]!, method);
  return { handled, status, wire };
}
const make = (over: FleetCosApiDeps = {}) => createFleetCosApi({ runsDir, now: () => (clock += 1000), ...over });

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'cos-phone-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('remote gateway chief-of-staff policy', () => {
  it('classifies the ask write without step-up', () => {
    expect(classifyRemoteRoute('POST', ASK)).toEqual({ kind: 'write', path: ASK, stepUp: false });
  });

  it('classifies list bare or with a bounded limit as a read', () => {
    expect(classifyRemoteRoute('GET', LIST)).toEqual({ kind: 'read', path: LIST });
    expect(classifyRemoteRoute('GET', `${LIST}?limit=20`)).toEqual({ kind: 'read', path: LIST });
  });

  it('denies list limits outside the exact shape', () => {
    expect(classifyRemoteRoute('GET', `${LIST}?limit=51`)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('GET', `${LIST}?limit=1e1`)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('GET', `${LIST}?limit=20&source=mobile`)).toEqual({ kind: 'deny' });
  });

  it('classifies status with one cos- job id as a read', () => {
    expect(classifyRemoteRoute('GET', `${STATUS}?id=${JOB}`)).toEqual({ kind: 'read', path: STATUS });
  });

  it('denies status with a bad id or an extra param', () => {
    expect(classifyRemoteRoute('GET', `${STATUS}?id=../x`)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('GET', `${STATUS}?id=${JOB}&limit=1`)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('GET', STATUS)).toEqual({ kind: 'deny' });
  });

  it('keeps approval, memory and ask-with-query off the phone', () => {
    expect(classifyRemoteRoute('POST', APPROVE)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('POST', '/api/verse/cos/memory')).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('GET', APPROVE)).toEqual({ kind: 'deny' });
    expect(classifyRemoteRoute('POST', `${ASK}?x=1`)).toEqual({ kind: 'deny' });
  });

  it('accepts exactly {text} and refuses a client channel or oversize text', () => {
    const route = classifyRemoteRoute('POST', ASK);
    expect(validateRemoteMutation(route, { text: 'hi' })).toBe(true);
    expect(validateRemoteMutation(route, { text: 'hi', channel: 'desktop' })).toBe(false);
    expect(validateRemoteMutation(route, { text: 'x'.repeat(4001) })).toBe(false);
    expect(validateRemoteMutation(route, {})).toBe(false);
    expect(validateRemoteMutation(route, { text: '   ' })).toBe(false);
  });
});

describe('remoteChannelHeaders', () => {
  it('stamps the mobile channel on the ask and inbox paths only', () => {
    expect(remoteChannelHeaders(ASK)).toEqual({ 'x-ashlr-channel': 'mobile' });
    expect(remoteChannelHeaders('/api/verse/fleet/runs/inbox')).toEqual({ 'x-ashlr-channel': 'mobile' });
    expect(remoteChannelHeaders(LIST)).toEqual({});
    expect(remoteChannelHeaders(APPROVE)).toEqual({});
  });
});

describe('fleet cos api phone channel', () => {
  it('lists a gateway-stamped ask as channel mobile', async () => {
    const api = make();
    const ask = await call(api, { path: ASK, method: 'POST', body: { text: 'phone asks for the fleet state' }, channel: 'mobile' });
    expect(ask.status).toBe(201);
    const id = ask.wire!.id as string;
    expect(id).toMatch(/^cos-[a-f0-9]{32}$/);
    const list = await call(api, { path: `${LIST}?limit=20` });
    expect(list.status).toBe(200);
    const task = (list.wire!.tasks as { id: string; channel: string }[]).find((row) => row.id === id);
    expect(task?.channel).toBe('mobile');
    const status = await call(api, { path: `${STATUS}?id=${id}` });
    expect(status.wire).toMatchObject({ id, channel: 'mobile' });
  });

  it('keeps an ask without the header on the desktop channel', async () => {
    const api = make();
    const ask = await call(api, { path: ASK, method: 'POST', body: { text: 'desktop asks for the fleet state' } });
    expect(ask.status).toBe(201);
    const id = ask.wire!.id as string;
    const list = await call(api, { path: LIST });
    const task = (list.wire!.tasks as { id: string; channel: string }[]).find((row) => row.id === id);
    expect(task?.channel).toBe('desktop');
  });
});
