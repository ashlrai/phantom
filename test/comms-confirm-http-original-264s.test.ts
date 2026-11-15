import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCommsLimits } from '../src/core/comms/comms-confirm.js';
import { handleApi } from '../src/core/web/api.js';
import { handleCommsConfirmRoute, COMMS_CONFIRM_PATH } from '../src/core/web/comms-confirm-route.js';

const token = 'plainly-fake-mutation-token';
const host = '127.0.0.1:4317';
const COMMS = 'confirmedByMason = false\n';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comms-confirm-route-'));
  writeFileSync(join(dir, 'comms.toml'), COMMS, { mode: 0o600 });
  writeFileSync(join(dir, 'agent-network.toml'), '[team]\nidentities = [{ channel = "imessage", id = "imessage:0123456789abcdef" }]\n', { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function call(method: string, headers: Record<string, string>, body: unknown = {}, allowDispatch = true) {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.url = COMMS_CONFIRM_PATH;
  req.method = method;
  req.headers = headers;
  const result = { status: 0, value: {} as Record<string, unknown> };
  const res = { writeHead(status: number) { result.status = status; }, end(text: string) { result.value = JSON.parse(text); } } as unknown as ServerResponse;
  expect(await handleCommsConfirmRoute({ token, allowDispatch, configDir: dir, now: () => new Date('2026-11-09T12:00:00.000Z') }, req, res, method)).toBe(true);
  return result;
}

const desktop = { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-ashlr-token': token };
const digest = () => readCommsLimits(dir).digest;
const unchanged = () => expect(readFileSync(join(dir, 'comms.toml'), 'utf8')).toBe(COMMS);

describe('POST /api/verse/comms/confirm', () => {
  it('requires the owner mutation gate', async () => {
    const { 'x-ashlr-token': _, ...noToken } = desktop;
    expect((await call('POST', noToken, { limitsDigest: digest() })).status).toBe(401);
    expect((await call('POST', { ...desktop, 'x-ashlr-token': 'wrong' }, { limitsDigest: digest() })).status).toBe(401);
    expect((await call('POST', desktop, { limitsDigest: digest() }, false)).status).toBe(404);
    unchanged();
  });

  it('refuses an agent bearer even alongside a valid mutation token', async () => {
    const bearer = `Bearer ${'A'.repeat(43)}`;
    expect((await call('POST', { ...desktop, authorization: bearer }, { limitsDigest: digest() })).status).toBe(403);
    unchanged();
  });

  it('refuses cross-origin and origin-less requests', async () => {
    const { origin: _, ...noOrigin } = desktop;
    expect((await call('POST', noOrigin, { limitsDigest: digest() })).status).toBe(403);
    expect((await call('POST', { ...desktop, origin: 'http://evil.example.invalid' }, { limitsDigest: digest() })).status).toBe(403);
    expect((await call('POST', { ...desktop, 'sec-fetch-site': 'cross-site' }, { limitsDigest: digest() })).status).toBe(403);
    unchanged();
  });

  it('refuses a stale or missing digest', async () => {
    expect((await call('POST', desktop, {})).status).toBe(400);
    expect((await call('POST', desktop, { limitsDigest: `sha256:${'0'.repeat(64)}` })).value).toMatchObject({ code: 'digest-mismatch' });
    unchanged();
  });

  it('flips the state on a gated, same-origin POST', async () => {
    const result = await call('POST', desktop, { limitsDigest: digest() });
    expect(result).toMatchObject({ status: 200, value: { state: 'confirmed', confirmedAt: '2026-11-09T12:00:00.000Z' } });
    expect(readCommsLimits(dir).state).toBe('confirmed');
  });
});

describe('GET /api/verse/comms/confirm', () => {
  it('is read-only', async () => {
    const before = readdirSync(dir).sort();
    const result = await call('GET', { host });
    expect(result).toMatchObject({ status: 200, value: { state: 'unconfirmed', digest: digest() } });
    unchanged();
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});

describe('human-only writer', () => {
  it('has exactly one caller of confirmCommsLimits outside tests: the owner-gated route', () => {
    const hits = execFileSync('git', ['grep', '--untracked', '-l', 'confirmCommsLimits', '--', 'src'], { encoding: 'utf8' }).trim().split('\n').sort();
    expect(hits).toEqual(['src/core/comms/comms-confirm.ts', 'src/core/web/comms-confirm-route.ts']);
  });
});

// The same route through the real handleApi mount in src/core/web/api.ts. The
// mounted ctx carries no configDir seam, so the route resolves the worker's
// fake home (`<HOME>/.ashlr`, relocated by test/setup/home.ts) exactly as the
// desktop server does — and the POST timestamp comes from the server clock.
describe('mounted route through handleApi', () => {
  const ashDir = join(homedir(), '.ashlr');
  const commsPath = join(ashDir, 'comms.toml');
  const networkPath = join(ashDir, 'agent-network.toml');

  beforeEach(() => {
    mkdirSync(ashDir, { recursive: true });
    writeFileSync(commsPath, COMMS, { mode: 0o600 });
    writeFileSync(networkPath, '[team]\nidentities = [{ channel = "imessage", id = "imessage:0123456789abcdef" }]\n', { mode: 0o600 });
  });
  afterEach(() => {
    rmSync(commsPath, { force: true });
    rmSync(networkPath, { force: true });
  });

  async function mounted(method: string, headers: Record<string, string>, body: unknown = {}) {
    const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
    req.url = COMMS_CONFIRM_PATH;
    req.method = method;
    req.headers = headers;
    const result = { status: 0, value: {} as Record<string, unknown>, handled: false };
    const res = {
      writeHead(status: number) { result.status = status; },
      end(text: string) { result.value = JSON.parse(text); },
    } as unknown as ServerResponse;
    result.handled = await handleApi(req, res, {} as never, { token, allowDispatch: true });
    return result;
  }

  const mountedDigest = () => readCommsLimits(ashDir).digest;

  it('GET reports the seeded limits without writing', async () => {
    const before = readFileSync(commsPath, 'utf8');
    const result = await mounted('GET', { host });
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ state: 'unconfirmed', digest: mountedDigest() });
    expect(readFileSync(commsPath, 'utf8')).toBe(before);
    expect(existsSync(`${commsPath}.bak`)).toBe(false);
  });

  it('GET reports unknown when comms.toml is absent and never creates it', async () => {
    rmSync(commsPath);
    const result = await mounted('GET', { host });
    expect(result.status).toBe(200);
    expect(result.value).toEqual({ state: 'unknown', limits: null, digest: null, confirmedAt: null });
    expect(existsSync(commsPath)).toBe(false);
  });

  it('POST flips the confirmation with the same owner-only gates', async () => {
    const missing = await mounted('POST', { ...desktop, 'x-ashlr-token': 'wrong' }, { limitsDigest: mountedDigest() });
    expect(missing.status).toBe(401);
    const bearer = await mounted('POST', { ...desktop, authorization: `Bearer ${'A'.repeat(43)}` }, { limitsDigest: mountedDigest() });
    expect(bearer.status).toBe(403);
    expect(readFileSync(commsPath, 'utf8')).toBe(COMMS);

    const result = await mounted('POST', desktop, { limitsDigest: mountedDigest() });
    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ state: 'confirmed' });
    expect(typeof result.value['confirmedAt']).toBe('string');
    expect(readCommsLimits(ashDir).state).toBe('confirmed');
  });
});
