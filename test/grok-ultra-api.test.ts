import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleGrokUltraApi, GROK_ULTRA_PATH } from '../src/core/verse/grok-ultra-api.js';
import { classifyRemoteRoute } from '../src/core/web/remote-gateway-policy.js';
import { createReadSessionBoundary } from '../src/core/web/read-session.js';
import { handleVerseApi, type VerseApiContext } from '../src/core/verse/verse-api.js';

let root: string;
let file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'grok-api-test-')));
  file = join(root, 'fleet.json');
  vi.stubEnv('PHANTOM_FLEET_FILE', file);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function response() {
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(body: string) { captured.body = body; return this; },
  } as unknown as ServerResponse;
  return { captured, res };
}
function request(method = 'GET', url = GROK_ULTRA_PATH): IncomingMessage {
  return { method, url, headers: { host: 'localhost' } } as IncomingMessage;
}

describe('Grok runway read route', () => {
  it('returns only usage projections and never emits telemetry or mutates fleet data', async () => {
    const raw = JSON.stringify({ schema: 'fleet.v1', claims: ['claim-private'], messages: ['message-private'],
      auth: 'credential-shaped-private-data', localPath: root,
      grokUltra: { v: 1, readings: [{ source: 'manual', timestamp: new Date().toISOString(), remainingPoints: 800, totalPoints: 1000 }] } });
    writeFileSync(file, raw, { mode: 0o600 });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { captured, res } = response();
    expect(await handleGrokUltraApi(request(), res, GROK_ULTRA_PATH, 'GET')).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).latest.remainingPoints).toBe(800);
    expect(captured.body).not.toMatch(/claim-private|message-private|credential-shaped|localPath|auth|fleet\.v1/);
    expect(captured.body).not.toContain(root);
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports unknown manual history and unavailable corrupt history', async () => {
    const missing = response();
    await handleGrokUltraApi(request(), missing.res, GROK_ULTRA_PATH, 'GET');
    expect(JSON.parse(missing.captured.body)).toMatchObject({ state: 'manual-required', latest: null });
    writeFileSync(file, '{invalid', { mode: 0o600 });
    const invalid = response();
    await handleGrokUltraApi(request(), invalid.res, GROK_ULTRA_PATH, 'GET');
    expect(JSON.parse(invalid.captured.body)).toMatchObject({ state: 'unavailable', latest: null });
  });

  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('refuses %s without touching history', async (method) => {
    const { captured, res } = response();
    expect(await handleGrokUltraApi(request(method), res, GROK_ULTRA_PATH, method)).toBe(true);
    expect(captured.status).toBe(404);
  });

  it('refuses query-supplied paths and unknown route children', async () => {
    const { captured, res } = response();
    await handleGrokUltraApi(request('GET', GROK_ULTRA_PATH + '?file=/private/data'), res, GROK_ULTRA_PATH, 'GET');
    expect(captured.status).toBe(400);
    const unknown = response();
    expect(await handleGrokUltraApi(request(), unknown.res, GROK_ULTRA_PATH + '/other', 'GET')).toBe(false);
  });

  it('mounts the exact route before any scheduler-owning legacy modules', async () => {
    const { captured, res } = response();
    expect(await handleVerseApi({} as VerseApiContext, request(), res, GROK_ULTRA_PATH, 'GET')).toBe(true);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).state).toBe('manual-required');
    const unknown = response();
    await handleVerseApi({} as VerseApiContext, request(), unknown.res, GROK_ULTRA_PATH + '/other', 'GET');
    expect(unknown.captured.status).toBe(404);
  });

  it('requires existing read authority and remote allowance is exact and GET only', () => {
    const sessions = createReadSessionBoundary();
    expect(sessions.authority(request(), new URL('http://localhost' + GROK_ULTRA_PATH))).toBeNull();
    expect(classifyRemoteRoute('GET', GROK_ULTRA_PATH)).toEqual({ kind: 'read', path: GROK_ULTRA_PATH });
    for (const method of ['POST', 'DELETE', 'HEAD']) expect(classifyRemoteRoute(method, GROK_ULTRA_PATH)).toEqual({ kind: 'deny' });
    for (const suffix of ['?file=other', '?', '/other', '/', '%2fother']) {
      expect(classifyRemoteRoute('GET', GROK_ULTRA_PATH + suffix)).toEqual({ kind: 'deny' });
    }
  });
});
