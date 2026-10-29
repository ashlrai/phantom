import type { Stats } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { buildHostSummary, HOST_SUMMARY_PATH } from '../src/core/web/host-summary.js';
import { handleApi } from '../src/core/web/api.js';

afterEach(() => vi.unstubAllEnvs());

const socket = { localAddress: '127.0.0.1', localPort: 4312 };
const missing = async (): Promise<Stats> => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const metadata = (overrides: Partial<Stats> = {}): Stats => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  nlink: 1,
  uid: process.getuid?.() ?? 0,
  mode: 0o100600,
  ...overrides,
} as Stats);

describe('host summary', () => {
  it('reports the console socket and resolved local inference setting without probing', async () => {
    vi.stubEnv('ASHLR_LOCAL_RUNTIME_HOST', '127.0.0.1');
    const summary = await buildHostSummary(defaultConfig(), socket, { lstat: missing });
    expect(summary.console).toEqual({ bindHost: '127.0.0.1', url: 'http://127.0.0.1:4312', loopback: true });
    expect(summary.localInference).toEqual({ bindHost: '127.0.0.1' });
    expect(summary.killSwitch.state).toBe('inactive');
    expect(Number.isFinite(Date.parse(summary.observedAt))).toBe(true);
    expect(Object.keys(summary)).toEqual(['observedAt', 'console', 'localInference', 'killSwitch']);
  });

  it.each([
    ['127.0.0.2', true, 'http://127.0.0.2:4312'],
    ['::1', true, 'http://[::1]:4312'],
    ['::ffff:127.0.0.1', true, 'http://[::ffff:127.0.0.1]:4312'],
    ['192.0.2.1', false, 'http://192.0.2.1:4312'],
  ])('identifies socket bind %s honestly', async (localAddress, loopback, url) => {
    const summary = await buildHostSummary(defaultConfig(), { ...socket, localAddress }, { lstat: missing });
    expect(summary.console).toEqual({ bindHost: localAddress, url, loopback });
  });

  it('keeps missing socket identity and invalid ports unknown', async () => {
    const missingSocket = await buildHostSummary(defaultConfig(), {}, { lstat: missing });
    expect(missingSocket.console).toEqual({ bindHost: null, url: null, loopback: null });
    const invalidPort = await buildHostSummary(defaultConfig(), { ...socket, localPort: 65_536 }, { lstat: missing });
    expect(invalidPort.console.url).toBeNull();
  });

  it('preserves the persisted non-loopback inference opt-in gate', async () => {
    vi.stubEnv('ASHLR_LOCAL_RUNTIME_HOST', '0.0.0.0');
    const cfg = defaultConfig();
    expect((await buildHostSummary(cfg, socket, { lstat: missing })).localInference.bindHost).toBe('127.0.0.1');
    cfg.models = { ...cfg.models, llamaServer: { host: '0.0.0.0', allowNonLoopback: true } };
    expect((await buildHostSummary(cfg, socket, { lstat: missing })).localInference.bindHost).toBe('0.0.0.0');
  });

  it('reads only KILL metadata in the isolated home', async () => {
    const path = join(homedir(), '.ashlr', 'KILL');
    await mkdir(join(homedir(), '.ashlr'), { recursive: true, mode: 0o700 });
    await writeFile(path, 'never returned sentinel content', { mode: 0o600 });
    const summary = await buildHostSummary(defaultConfig(), socket);
    expect(summary.killSwitch.state).toBe('active');
    expect(JSON.stringify(summary)).not.toContain('never returned sentinel content');
    expect(JSON.stringify(summary)).not.toContain(homedir());
  });

  it.each([
    { isFile: () => false },
    { isSymbolicLink: () => true },
    { nlink: 2 },
    ...(process.platform === 'win32' ? [] : [{ mode: 0o100622 }]),
    ...(typeof process.getuid === 'function' ? [{ uid: process.getuid() + 1 }] : []),
  ])('keeps unsafe KILL metadata unknown: %j', async (overrides) => {
    const summary = await buildHostSummary(defaultConfig(), socket, { lstat: async () => metadata(overrides) });
    expect(summary.killSwitch.state).toBe('unknown');
  });

  it.each(['EACCES', 'EIO', 'ENOTDIR'])('keeps KILL inspection failure %s unknown', async (code) => {
    const summary = await buildHostSummary(defaultConfig(), socket, {
      lstat: async () => { throw Object.assign(new Error('private error details'), { code }); },
    });
    expect(summary.killSwitch.state).toBe('unknown');
    expect(JSON.stringify(summary)).not.toContain('private error details');
  });
});

function response() {
  let status = 0;
  let body = '';
  const headers: Record<string, unknown> = {};
  const res = {
    writeHead: (code: number, values: Record<string, unknown>) => { status = code; Object.assign(headers, values); },
    end: (value: string) => { body = value; },
    setHeader: (name: string, value: unknown) => { headers[name] = value; },
  } as unknown as ServerResponse;
  return { res, result: () => ({ status, headers, body: JSON.parse(body) as unknown }) };
}

describe('host summary route', () => {
  it('uses socket facts rather than client-controlled headers', async () => {
    const req = { url: HOST_SUMMARY_PATH, method: 'GET', socket,
      headers: { host: 'example.com:99', origin: 'https://example.com', 'x-forwarded-host': 'example.com' } } as unknown as IncomingMessage;
    const out = response();
    expect(await handleApi(req, out.res, defaultConfig(), { token: 'test-only', allowDispatch: false })).toBe(true);
    expect(out.result()).toMatchObject({ status: 200, body: { console: { url: 'http://127.0.0.1:4312', loopback: true } } });
    expect(JSON.stringify(out.result())).not.toContain('example.com');
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('refuses %s even with a mutation token', async (method) => {
    const req = { url: HOST_SUMMARY_PATH, method, socket, headers: { 'x-ashlr-token': 'test-only' } } as unknown as IncomingMessage;
    const out = response();
    await handleApi(req, out.res, defaultConfig(), { token: 'test-only', allowDispatch: true });
    expect(out.result()).toMatchObject({ status: 405, headers: { Allow: 'GET' } });
  });
});
