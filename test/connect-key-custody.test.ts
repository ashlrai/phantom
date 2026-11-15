/**
 * connect-key-custody.test.ts -- RQ-ONB-3-KEYS-CUSTODY security gate.
 *
 * Proves the Connect Resources key flow puts API keys into Phantom Secrets
 * custody without ever exposing the plaintext: the value reaches Phantom only
 * as stdin to `phantom add <KEY> --stdin`, exactly one `phantom exec`
 * validation call runs, and the value never lands in argv, env, a response,
 * console output, or any file under ~/.ashlr. Only the masked last-4 and a
 * validated yes/no come back.
 *
 * Hermetic: HOME is a tmp dir and `node:child_process`'s spawnSync is the
 * ONLY mock -- every phantom invocation is routed by argv and counted, so any
 * extra call (a second provider hit, a stray write) is caught.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig } from '../src/core/types.js';

// Spawn routing -- every phantom call is answered by argv, and counted.

interface SpawnCall { bin: string; args: string[]; opts: Record<string, unknown> }

const spawnCalls: SpawnCall[] = [];
let versionOk = true;
let statusInitialized = true;
let addStatus = 0;
let execStatus: number | null = 0; // null = spawn error
let vaultNames = ['OPENAI_API_KEY'];

const STATUS_JSON = JSON.stringify({
  schema_version: 1,
  initialized: true,
  inspection: 'metadata-only',
  managed_dotenv: { inspected: false },
  vault: { inspected: false },
  proxy: { lifecycle_lock: 'available', listener_authenticated: false },
  issues: [],
});

const mockSpawnSync = vi.fn((bin: string, args: string[], opts: Record<string, unknown>) => {
  spawnCalls.push({ bin, args: [...args], opts });
  const fail = (status: number | null, error?: Error) =>
    ({ status, error, stdout: '', stderr: '', signal: null, output: [null, '', ''], pid: 0 });
  if (bin !== 'phantom') return fail(1);
  if (args[0] === '--version') return versionOk ? { ...fail(0), stdout: 'phantom 0.7.9\n' } : fail(1);
  if (args.join(' ') === 'status --json') {
    return statusInitialized ? { ...fail(0), stdout: STATUS_JSON } : fail(1);
  }
  if (args.join(' ') === 'list --json') {
    return { ...fail(0), stdout: JSON.stringify(vaultNames.map((name) => ({ name }))) };
  }
  if (args[0] === '--help') {
    return { ...fail(0), stdout: 'Usage: phantom <command>\nCommands:\n  add\n  exec\n  list\n  status\n' };
  }
  if (args[0] === 'add') return fail(addStatus);
  if (args[0] === 'exec') return execStatus === null ? fail(null, new Error('spawn failed')) : fail(execStatus);
  return fail(1);
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: unknown[]) => mockSpawnSync(...(args as [string, string[], Record<string, unknown>])) };
});

// Keep buildReadiness hermetic: model endpoints and MCP registry stay local.
vi.mock('../src/core/providers.js', () => ({
  probeEndpoint: async (id: string, url: string) => ({ id, url, up: true, models: ['mock-model'] }),
}));
vi.mock('../src/core/mcp-registry.js', () => ({
  discoverMcpServers: () => ({ servers: [] }),
}));

// Import AFTER the mock is registered.
import { custodyApiKey, apiKeyCustodyStatus } from '../src/core/onboard.js';
import { handleApi } from '../src/core/web/api.js';
import { buildReadiness } from '../src/core/readiness.js';

// Deliberately not secret-shaped: if this value ever appears in a response,
// log, or file it was echoed RAW -- no scrubber could have saved it.
const KEY_VALUE = 'fakekey_probe_NOTASECRET_13579';
const KEY_LAST4 = KEY_VALUE.slice(-4);

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-onb3-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  spawnCalls.length = 0;
  versionOk = true;
  statusInitialized = true;
  addStatus = 0;
  execStatus = 0;
  vaultNames = ['OPENAI_API_KEY'];
  mockSpawnSync.mockClear();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

/** No spawned call may carry the plaintext except as `input` on `add`. */
function assertNoSpawnLeak(value: string): void {
  for (const call of spawnCalls) {
    expect(call.args.join(' ')).not.toContain(value);
    const env = call.opts['env'] as Record<string, string> | undefined;
    if (env) for (const v of Object.values(env)) expect(v).not.toBe(value);
    if (call.args[0] !== 'add') expect(call.opts['input']).toBeUndefined();
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const ent of readdirSync(d)) {
      const p = join(d, ent);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  try { walk(dir); } catch { /* missing dir */ }
  return out;
}

describe('custodyApiKey', () => {
  it('writes via `phantom add <KEY> --stdin` (stdin only), validates once via `phantom exec`', () => {
    const result = custodyApiKey('openai', KEY_VALUE);
    expect(result).toEqual({
      ok: true,
      resource: 'openai',
      envName: 'OPENAI_API_KEY',
      masked: `****${KEY_LAST4}`,
      stored: true,
      validated: true,
    });

    const adds = spawnCalls.filter((c) => c.args[0] === 'add');
    const execs = spawnCalls.filter((c) => c.args[0] === 'exec');
    expect(adds).toHaveLength(1);
    expect(adds[0]!.args).toEqual(['add', 'OPENAI_API_KEY', '--stdin']);
    expect(adds[0]!.opts['input']).toBe(KEY_VALUE);
    expect((adds[0]!.opts['stdio'] as string[])[0]).toBe('pipe');

    // Exactly ONE cheap provider call through phantom exec -- env NAME and
    // endpoint travel in argv; the value never does.
    expect(execs).toHaveLength(1);
    expect(execs[0]!.args[1]).toBe('--');
    expect(execs[0]!.args).toContain('OPENAI_API_KEY');
    expect(execs[0]!.args).toContain('https://api.openai.com/v1/models');
    assertNoSpawnLeak(KEY_VALUE);
  });

  it('maps the exec exit code to the validated verdict', () => {
    execStatus = 2;
    const rejected = custodyApiKey('anthropic', KEY_VALUE);
    expect(rejected).toMatchObject({ ok: true, envName: 'ANTHROPIC_API_KEY', validated: false });

    for (const status of [3, null, 1] as const) {
      execStatus = status;
      const r = custodyApiKey('grok', KEY_VALUE);
      expect(r.ok && r.validated).toBeNull();
    }
  });

  it('rejects unknown resources and malformed keys before any spawn', () => {
    expect(custodyApiKey('not-a-provider', KEY_VALUE)).toMatchObject({ ok: false, code: 'unknown-resource' });
    for (const bad of ['', 'short', 'has white space123', 'line\nbreak123', 'x'.repeat(513)]) {
      expect(custodyApiKey('openai', bad)).toMatchObject({ ok: false, code: 'invalid-key-shape' });
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it('fails closed when phantom is missing or the vault write fails', () => {
    versionOk = false;
    expect(custodyApiKey('openai', KEY_VALUE)).toMatchObject({ ok: false, code: 'phantom-unavailable' });
    expect(spawnCalls.filter((c) => c.args[0] === 'add')).toHaveLength(0);

    versionOk = true;
    addStatus = 1;
    expect(custodyApiKey('openai', KEY_VALUE)).toMatchObject({ ok: false, code: 'vault-write-failed' });
    expect(spawnCalls.filter((c) => c.args[0] === 'exec')).toHaveLength(0);
  });
});

describe('apiKeyCustodyStatus', () => {
  it('returns catalog apikey resources with names-only stored flags', () => {
    const entries = apiKeyCustodyStatus();
    expect(entries.length).toBeGreaterThanOrEqual(4);
    const byId = new Map(entries.map((e) => [e.resource, e]));
    expect(byId.get('openai')).toMatchObject({ envName: 'OPENAI_API_KEY', stored: true });
    expect(byId.get('anthropic')).toMatchObject({ envName: 'ANTHROPIC_API_KEY', stored: false });
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(['displayName', 'envName', 'resource', 'stored']);
    }
  });

  it('reports stored:false for everything when the status probe fails', () => {
    versionOk = false;
    for (const e of apiKeyCustodyStatus()) expect(e.stored).toBe(false);
  });
});

// POST /api/connect/key + GET /api/connect/keys through handleApi.

const TEST_TOKEN = 'test-token-onb3';
const ctx = { token: TEST_TOKEN, allowDispatch: true };

interface FakeResponse { statusCode: number; body: string; headers: Record<string, string>; ended: boolean }

function makeFakeReqRes(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): { req: IncomingMessage; res: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { statusCode: 200, body: '', headers: {}, ended: false };
  const req = new EventEmitter() as IncomingMessage;
  req.method = opts.method ?? 'POST';
  req.url = opts.url ?? '/api/connect/key';
  req.headers = opts.headers ?? { 'content-type': 'application/json', 'x-ashlr-token': TEST_TOKEN };
  process.nextTick(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(opts.body, 'utf8'));
    req.emit('end');
  });
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      this.headersSent = true;
    },
    end(data?: string) { if (data) captured.body += data; captured.ended = true; },
    write() { return true; },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

describe('POST /api/connect/key', () => {
  it('stores the key and replies with only the masked form + validated verdict', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ resource: 'openai', value: KEY_VALUE }),
    });
    await handleApi(req, res, baseConfig(), ctx);

    expect(captured.statusCode).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({
      ok: true,
      resource: 'openai',
      envName: 'OPENAI_API_KEY',
      masked: `****${KEY_LAST4}`,
      stored: true,
      validated: true,
    });
    // The only echo is the last-4 mask -- the full value is never returned.
    expect(captured.body).not.toContain(KEY_VALUE);
    expect(captured.body).toContain(`****${KEY_LAST4}`);

    expect(spawnCalls.filter((c) => c.args[0] === 'add')).toHaveLength(1);
    expect(spawnCalls.filter((c) => c.args[0] === 'exec')).toHaveLength(1);
    assertNoSpawnLeak(KEY_VALUE);

    // Never logged.
    for (const spy of spies) for (const call of spy.mock.calls) expect(call.join(' ')).not.toContain(KEY_VALUE);
    // Never persisted: nothing under the isolated HOME may contain it.
    for (const file of filesUnder(tmpHome)) expect(readFileSync(file, 'utf8')).not.toContain(KEY_VALUE);
    vi.restoreAllMocks();
  });

  it('enforces the dispatch and mutation gates before any spawn', async () => {
    for (const [gate, headers, expected] of [
      ['no-dispatch', { 'content-type': 'application/json', 'x-ashlr-token': TEST_TOKEN }, 404],
      ['no-token', { 'content-type': 'application/json' }, 401],
      ['not-json', { 'content-type': 'text/plain', 'x-ashlr-token': TEST_TOKEN }, 415],
    ] as const) {
      spawnCalls.length = 0;
      const { req, res, captured } = makeFakeReqRes({
        headers,
        body: JSON.stringify({ resource: 'openai', value: KEY_VALUE }),
      });
      const c = gate === 'no-dispatch' ? { token: TEST_TOKEN, allowDispatch: false } : ctx;
      await handleApi(req, res, baseConfig(), c);
      expect(captured.statusCode).toBe(expected);
      expect(spawnCalls).toHaveLength(0);
    }
  });

  it('returns 400 for malformed bodies and unknown resources, echoing no value', async () => {
    for (const body of [
      'not json',
      JSON.stringify(['openai', KEY_VALUE]),
      JSON.stringify({ resource: 'not-a-provider', value: KEY_VALUE }),
      JSON.stringify({ resource: 'openai', value: 'tiny' }),
      JSON.stringify({ resource: 'openai' }),
    ]) {
      spawnCalls.length = 0;
      const { req, res, captured } = makeFakeReqRes({ body });
      await handleApi(req, res, baseConfig(), ctx);
      expect(captured.statusCode).toBe(400);
      expect(captured.body).not.toContain(KEY_VALUE);
    }
    expect(spawnCalls).toHaveLength(0);
  });

  it('returns 503 when phantom is unavailable and 502 when the vault write fails', async () => {
    versionOk = false;
    let r = makeFakeReqRes({ body: JSON.stringify({ resource: 'openai', value: KEY_VALUE }) });
    await handleApi(r.req, r.res, baseConfig(), ctx);
    expect(r.captured.statusCode).toBe(503);
    expect(r.captured.body).not.toContain(KEY_VALUE);

    versionOk = true;
    addStatus = 1;
    r = makeFakeReqRes({ body: JSON.stringify({ resource: 'openai', value: KEY_VALUE }) });
    await handleApi(r.req, r.res, baseConfig(), ctx);
    expect(r.captured.statusCode).toBe(502);
    expect(r.captured.body).not.toContain(KEY_VALUE);
  });
});

describe('GET /api/connect/keys', () => {
  it('returns names-only custody status -- no value or mask fields exist', async () => {
    const { req, res, captured } = makeFakeReqRes({ method: 'GET', url: '/api/connect/keys', headers: {} });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body) as { keys: Array<Record<string, unknown>> };
    const openai = body.keys.find((k) => k['resource'] === 'openai');
    expect(openai).toMatchObject({ envName: 'OPENAI_API_KEY', stored: true });
    for (const entry of body.keys) {
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'envName', 'resource', 'stored']);
    }
  });
});

describe('readiness phantom snapshot apiKeyCustody', () => {
  it('reports eligible/stored counts from secret NAMES only', async () => {
    const report = await buildReadiness(baseConfig());
    expect(report.phantom).toBeDefined();
    expect(report.phantom!.apiKeyCustody.eligible).toBeGreaterThanOrEqual(4);
    expect(report.phantom!.apiKeyCustody.stored).toBe(1); // vaultNames: OPENAI_API_KEY
    expect(JSON.stringify(report.phantom)).not.toContain(KEY_VALUE);
  });
});
