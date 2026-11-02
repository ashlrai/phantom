/**
 * health-api.recut-loop.test.ts — the recut-loop mount on the health route:
 * the state JSON on /api/verse/health/recut-loop, and the guarantee that the
 * loop never arms under Vitest even when dispatch is allowed.
 *
 * Hermetic: HOME is the per-worker tmp home; the health service is primed
 * with an injected discovery and probes; the loop state is in-process only.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AshlrConfig } from '../types.js';
import type { VerseApiContext } from './verse-api.js';
import type { SeatHealthProbes } from './account-health.js';
import {
  handleHealthApi,
  startVerseHealth,
  stopVerseHealth,
} from './health-api.js';
import { getRecutLoopState, stopRecutLoopForTest } from '../fleet/recut-loop.js';

interface Captured { status: number; body: unknown }

function cfg(): AshlrConfig {
  return {
    version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {}, tools: {},
  } as AshlrConfig;
}

const probes: SeatHealthProbes = {
  claudeLogin: async () => ({ loggedIn: true, reason: 'status-login-observed' }),
  codexLogin: async () => ({ loggedIn: true, reason: 'status-login-observed' }),
  grokLogin: async () => ({ loggedIn: true, reason: 'probe-observed' }),
  claudeKeychainRefreshedAt: async () => null,
  cliVersion: async () => null,
  ollamaVersion: async () => null,
};

function call(
  ctx: VerseApiContext,
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ handled: boolean; res: Captured }> {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  (req as { method?: string }).method = method;
  (req as { url?: string }).url = urlPath;
  (req as { headers: Record<string, string> }).headers = {
    'x-ashlr-token': ctx.token, 'content-type': 'application/json', ...headers,
  };
  const captured: Captured = { status: 0, body: undefined };
  const state = { headersSent: false };
  const res = {
    get headersSent() { return state.headersSent; },
    writeHead(status: number) { captured.status = status; state.headersSent = true; return res; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : undefined; return res; },
  } as unknown as ServerResponse;
  const done = handleHealthApi(ctx, req, res, urlPath, method);
  (req as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body));
  return done.then((handled) => ({ handled, res: captured }));
}

describe('health-api recut loop mount', () => {
  let ctx: VerseApiContext;

  beforeEach(() => {
    ctx = { cfg: cfg(), token: 'TOKEN', allowDispatch: true };
    startVerseHealth(ctx.cfg, {
      probes,
      initialDelayMs: 60_000,
      discover: async () => ({ seats: [], launches: new Map(), localRuntime: { ollama: { reachable: false, baseUrl: '', models: [] } } }),
    });
  });

  afterEach(() => {
    stopRecutLoopForTest();
    stopVerseHealth();
  });

  it('GET /api/verse/health/recut-loop returns the loop state JSON', async () => {
    const { handled, res } = await call(ctx, 'GET', '/api/verse/health/recut-loop');

    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      v: 1,
      armed: false,
      lastTickAt: null,
      lastOutcome: null,
      written: [],
      hourCount: 0,
      off: false,
    });
    expect(res.body).toEqual(getRecutLoopState());
  });

  it('GET /api/verse/health under Vitest does not arm the loop', async () => {
    expect(process.env.VITEST).toBeTruthy();
    const { res } = await call(ctx, 'GET', '/api/verse/health');

    expect(res.status).toBe(200);
    expect(getRecutLoopState().armed).toBe(false);
  });

  it('POST /api/verse/health/recut-loop is 405 and an unknown subpath is still 404', async () => {
    expect((await call(ctx, 'POST', '/api/verse/health/recut-loop', {})).res.status).toBe(405);
    expect((await call(ctx, 'GET', '/api/verse/health/nope')).res.status).toBe(404);
    expect(getRecutLoopState().armed).toBe(false);
  });
});
