import { handleApi } from '../src/core/web/api.js';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_ACTIONS, appConnection, appFetch, appReadings, parseAppRequest } from '../src/core/web/app-control.js';

describe('app.control.v1', () => {
  it('enumerates the supported UI controls and their CLI twins', () => {
    const api = readFileSync('src/core/web/api.ts', 'utf8');
    const cli = readFileSync('src/cli/app.ts', 'utf8');
    expect(Object.keys(APP_ACTIONS)).toEqual(['pause', 'resume', 'prefs']);
    const ui = readFileSync('src/web-ui/data/mutations.ts', 'utf8') + readFileSync('src/web-ui/routes/verse/context/context-queries.ts', 'utf8');
    const uiActions = [...new Set(ui.match(/\/api\/(?:fleet\/(?:pause|resume)|verse\/preferences)/g))].sort();
    expect(uiActions).toEqual(Object.values(APP_ACTIONS).sort());
    for (const [action, route] of Object.entries(APP_ACTIONS)) {
      expect(api.includes(route) || readFileSync('src/core/verse/verse-api.ts', 'utf8').includes(route)).toBe(true);
      expect(cli).toContain(action === 'prefs' ? "command === 'prefs'" : 'steer');
      expect(parseAppRequest({ version: 'app.control.v1', action, ...(action === 'prefs' ? { update: { memoryEnabled: false } } : {}) }).action).toBe(action);
    }
  });
  it('rejects unversioned, extra, prototype and malformed actions', () => {
    for (const input of [{ action: 'pause' }, { version: 'app.control.v1', action: 'constructor' },
      { version: 'app.control.v1', action: 'pause', update: {} },
      { version: 'app.control.v1', action: 'prefs', update: { secret: 'hidden' } },
      { version: 'app.control.v1', action: 'pause', extra: true }]) {
      expect(() => parseAppRequest(input)).toThrow();
    }
  });
  it('preserves only readings and hides secret values and invented percentages', () => {
    expect(appReadings({ token: 'hidden', password: 'hidden', usedPercent: null, totalTokens: 3, costUsd: 0.5 }))
      .toEqual({ usedPercent: 'unknown', totalTokens: 3, costUsd: 0.5 });
  });
  it('does not expose response error bodies', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('private', { status: 401 });
    try { await expect(appFetch({ url: 'http://127.0.0.1:7777', token: 'fixture' }, '/api/fleet')).rejects.toThrow('App request failed (401)'); }
    finally { globalThis.fetch = original; }
  });
  it('fails closed without a connection file', async () => {
    await expect(appConnection('/nonexistent-app-connection')).rejects.toThrow();
  });
});

it('enforces dispatch, token and JSON gates before parsing an app write', async () => {
  const { Readable } = await import('node:stream');
  for (const [dispatch, authorized, contentType, expected] of [
    [false, true, 'application/json', 404], [true, false, 'application/json', 401],
    [true, true, 'text/plain', 415], [true, true, 'application/json', 400],
    [true, true, 'application/json', 200],
  ] as const) {
    const req = Readable.from([expected === 200 ? JSON.stringify({ version: 'app.control.v1', action: 'prefs', update: { memoryEnabled: false } }) : '{}']) as import('node:http').IncomingMessage;
    req.method = 'POST'; req.url = '/api/app/v1/control';
    req.headers = { 'x-ashlr-token': authorized ? 'fixture' : '', 'content-type': contentType };
    let status = 0;
    const res = { set statusCode(code: number) { status = code; }, writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: () => {} } as unknown as import('node:http').ServerResponse;
    await handleApi(req, res, {} as import('../src/core/types.js').AshlrConfig, { token: 'fixture', allowDispatch: dispatch });
    expect(status).toBe(expected);
  }
});
