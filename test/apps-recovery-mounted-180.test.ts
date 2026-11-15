/**
 * RQ-PHX-APPSRECOVERYEXACT180 — mounted recovery route coverage.
 *
 * Boots the REAL server and the REAL verse-api mount table (no fake modules)
 * so the 'fleet-apps' entry resolves to handleFleetAppsRecoveryApi. Only the
 * retained-history reader is faked: no process probes, no app control, no
 * launches. Covers what the unit tests cannot:
 *   - GET /api/verse/fleet/apps/recovery reaches the recovery projection;
 *   - newest retained evidence wins per app regardless of projection order;
 *   - unreadable/empty history is a quiet empty reading, never a success;
 *   - unsupported writes get 405 after the mutation gate (404 without dispatch);
 *   - sibling app routes still delegate to handleFleetAppsApi.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { startServer, readAuthHeaders } from './helpers/authenticated-web-server.js';

const state = vi.hoisted(() => ({
  projection: null as unknown,
  fail: false,
}));

vi.mock('../src/core/fleet/apps-recovery-invocations.js', () => ({
  readAppsRecoveryInvocations: () => {
    if (state.fail) throw new Error('retained history unreadable');
    return state.projection;
  },
}));

function invocation(over: Record<string, unknown>) {
  return {
    invocationId: 'inv-1', latestCursor: 1, latestTime: Date.now() - 60_000,
    observedApps: null, retainedObservedState: null, retainedDiagnostics: null,
    retainedHealthy: null, recoveries: 0, consecutiveFailures: 0,
    totalFailedCycles: 0, terminalOutcome: null, ...over,
  };
}

function projection(invocations: unknown[], over: Record<string, unknown> = {}) {
  return { v: 1, availability: 'available', truncated: false, scanCursor: 0, scannedEvents: invocations.length, invocations, ...over };
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

function emptyEngine(): VerseEngineHandle {
  return {
    listSessions: () => [],
    getSession: () => null,
    getEvents: () => [],
    subscribe: () => () => {},
    close: () => {},
  } as unknown as VerseEngineHandle;
}

interface HttpResult { status: number; json: unknown }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let tmpHome: string;
let prevHome: string | undefined;
let cfg: AshlrConfig;
let handles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-apps-recovery-home-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const accountsRoot = path.join(tmpHome, '.ashlr', 'account-connections');
  fs.mkdirSync(accountsRoot, { recursive: true });
  fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
  cfg = makeConfig(accountsRoot);
  resetVerseEngine(emptyEngine());
  invalidateVerseSeatCache();
  state.projection = projection([]);
  state.fail = false;
  handles = [];
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  resetVerseEngine(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function boot(opts: Partial<WebServerOptions> = {}) {
  const handle = await startServer(cfg, { port: 0, open: false, allowDispatch: true, ...opts });
  handles.push(handle);
  return { port: handle.port, read: readAuthHeaders(handle.port), mutate: { 'x-ashlr-token': handle.token, 'content-type': 'application/json' } };
}

const RECOVERY = '/api/verse/fleet/apps/recovery';

describe('mounted fleet-apps recovery route', () => {
  it('GET reaches the recovery projection and newest retained evidence wins regardless of order', async () => {
    const { port, read } = await boot();
    const now = Date.now();
    // Oldest first on purpose: the handler must still pick the newest reading.
    state.projection = projection([
      invocation({ invocationId: 'old', latestCursor: 1, latestTime: now - 120_000, terminalOutcome: 'completed',
        retainedObservedState: [{ app: 'Codex', observedRunning: true }] }),
      invocation({ invocationId: 'mid', latestCursor: 2, latestTime: now - 60_000, terminalOutcome: 'failed',
        retainedObservedState: [{ app: 'Codex', observedRunning: false }, { app: 'Claude', observedRunning: null }] }),
      invocation({ invocationId: 'new', latestCursor: 3, latestTime: now - 10_000,
        retainedObservedState: [{ app: 'Claude', observedRunning: null }] }),
    ]);
    const res = await request(port, 'GET', RECOVERY, read);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ v: 1, apps: [
      // Claude's newest row has no terminal outcome and no observed state:
      // 'unknown' — distinct from success and from retryable failure.
      { app: 'Claude', at: now - 10_000, outcome: 'unknown' },
      // Codex's newest row failed terminally: 'gave-up', not the older 'recovered'.
      { app: 'Codex', at: now - 60_000, outcome: 'gave-up' },
    ] });
  });

  it('unreadable history is an empty quiet reading, never a success', async () => {
    const { port, read } = await boot();
    state.fail = true;
    const res = await request(port, 'GET', RECOVERY, read);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ v: 1, apps: [] });
  });

  it('unsupported writes return 405 after the mutation gate', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', RECOVERY, mutate, '{}');
    expect(res.status).toBe(405);
  });

  it('the same write is a plain 404 when dispatch is not allowed', async () => {
    const { port, mutate } = await boot({ allowDispatch: false });
    const res = await request(port, 'POST', RECOVERY, mutate, '{}');
    expect(res.status).toBe(404);
  });

  it('sibling app routes still delegate to the fleet-apps handler', async () => {
    const { port, read, mutate } = await boot();
    state.projection = projection([
      invocation({ invocationId: 'new', latestCursor: 2, latestTime: Date.now() - 30_000, terminalOutcome: 'failed',
        retainedObservedState: [{ app: 'Codex', observedRunning: false }] }),
    ]);
    // /recovery/check is owned by fleet-apps-api, not the recovery projection:
    // an invalid query proves the delegate answered, with no app probing.
    const check = await request(port, 'GET', '/api/verse/fleet/apps/recovery/check?invocation=bad&maxAgeMs=1', read);
    expect(check.status).toBe(400);
    expect(check.json).toMatchObject({ code: 'VERSE_INVALID' });
    // The guarded action endpoint still validates through fleet-apps-api:
    // an unknown app is refused before any control script runs.
    const action = await request(port, 'POST', '/api/verse/fleet/apps/action', mutate, JSON.stringify({ app: 'NotAnApp', action: 'ensure' }));
    expect(action.status).toBe(400);
    expect(action.json).toMatchObject({ code: 'VERSE_INVALID' });
  });
});
