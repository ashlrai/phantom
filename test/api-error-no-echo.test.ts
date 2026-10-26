/**
 * api-error-no-echo.test.ts — security regression suite.
 *
 * The /api/* error path must never reflect request material back to the
 * caller: no request header values (x-ashlr-token, authorization, cookie,
 * x-ashlr-read-client, custom headers), no server-held credentials (the
 * mutation token, the read token, a minted read-session cookie), and no
 * raw internal error text. Errors may echo a path segment or query value
 * for UX (e.g. `run not found: <id>`), but only after the secret scrubber
 * (sendJson → sanitizePublicJson / scrubSecrets) — a credential-shaped value
 * in one of those positions must come back as [REDACTED], never verbatim.
 *
 * Coverage:
 *   - sendJson (api.ts + read-session.ts) and passesMutationGate at unit
 *     level: error strings are bounded, secret-scrubbed, and contain neither
 *     the presented nor the expected token.
 *   - The full server pipeline (startServer) with probe values riding in
 *     every credential-bearing header, across every error class: 400/401/
 *     403/404/405/409/413/415/500.
 *   - The route-level echoes that DO exist (path id, inbox query params,
 *     `not found: METHOD PATH`) are scrubbed of secret shapes and never
 *     pull in header or query values beyond the one named in the message.
 *
 * Hermetic: one real loopback server per test over a tmp HOME; the only
 * module mocked is the run store, so the 500 path can be exercised on demand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig, WebServerHandle, WebServerOptions } from '../src/core/types.js';

// Orchestrator is mocked so (a) POST /api/run's success path can never launch
// real work in this suite and (b) a route can be made to throw a
// credential-carrying error on demand for the 500 tests.
vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => []),
  loadRun: vi.fn(() => null),
  runGoal: vi.fn(async () => ({ id: 'run-test', status: 'done' })),
}));

import { passesMutationGate, sendJson } from '../src/core/web/api.js';
import { sendJson as sendBoundaryJson } from '../src/core/web/read-session.js';
import { startServer as startRealServer } from '../src/core/web/server.js';
import { loadRun } from '../src/core/run/orchestrator.js';

// ---------------------------------------------------------------------------
// Probe values. Deliberately NOT secret-shaped where a test asserts total
// absence: if one of these ever appears in a response it was echoed raw, not
// redacted. SECRET_PROBE is the opposite — it must match a scrubber pattern so
// the redaction path itself is exercised.
// ---------------------------------------------------------------------------

const WRONG_TOKEN_PROBE = 'probe-wrong-token-b7f2c9';
const AUTH_PROBE = 'Bearer probe-authz-echo-k9m3';
const COOKIE_PROBE = 'probe_cookie=pcv-echo-x4w7';
const READ_CLIENT_PROBE = 'e3f1'.repeat(16); // exactly 64 hex — the proof's real grammar
const CUSTOM_HEADER_PROBE = 'probe-hdr-echo-z6y8';
const UA_PROBE = 'probe-agent/9.9';
const REFERER_PROBE = 'http://127.0.0.1/probe-referer-echo-q2w5';
const QUERY_PROBE = 'probe-query-echo-r1t7';
const SECRET_PROBE = 'sk-probeEchoToken0123456789abcdef';
const PATH_PROBE = 'probe-path-echo-p3l8';

function probeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-ashlr-token': WRONG_TOKEN_PROBE,
    'authorization': AUTH_PROBE,
    'cookie': COOKIE_PROBE,
    'x-ashlr-read-client': READ_CLIENT_PROBE,
    'x-probe-custom': CUSTOM_HEADER_PROBE,
    'user-agent': UA_PROBE,
    'referer': REFERER_PROBE,
    ...extra,
  };
}

const ALL_PROBES = [
  WRONG_TOKEN_PROBE, AUTH_PROBE, COOKIE_PROBE, READ_CLIENT_PROBE,
  CUSTOM_HEADER_PROBE, UA_PROBE, REFERER_PROBE, QUERY_PROBE, SECRET_PROBE,
  PATH_PROBE,
];

/**
 * The error-response contract in one place: no probe value, no server token,
 * in the body OR the response headers. `extraForbidden` covers per-request
 * values like the mutation/read tokens a route gate compares against;
 * `allowed` exempts probes a route intentionally echoes (a path segment or
 * the invalid query value named in the message).
 */
function expectNoEcho(
  res: { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string },
  extraForbidden: readonly string[] = [],
  allowed: readonly string[] = [],
): void {
  const responseText = `${JSON.stringify(res.headers)}\n${res.body}`;
  for (const probe of [...ALL_PROBES, ...extraForbidden]) {
    if (allowed.includes(probe)) continue;
    expect(
      responseText.includes(probe),
      `response ${res.statusCode} echoed forbidden value: ${probe.slice(0, 24)}…`,
    ).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Unit-level: response writers
// ---------------------------------------------------------------------------

function fakeRes(): { res: ServerResponse; out: { status: number; headers: Record<string, string>; body: string } } {
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      out.status = status;
      out.headers = headers ?? {};
      return res;
    },
    end(chunk?: unknown) {
      if (typeof chunk === 'string') out.body += chunk;
      return res;
    },
    headersSent: false,
  };
  return { res: res as unknown as ServerResponse, out };
}

function fakeReq(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('sendJson (api.ts) — error field is bounded and scrubbed', () => {
  it('redacts a secret-shaped value embedded in an error string', () => {
    const { res, out } = fakeRes();
    sendJson(res, 400, { error: `bad input: ${SECRET_PROBE}` });
    expect(out.status).toBe(400);
    expect(out.body).not.toContain(SECRET_PROBE);
    expect(out.body).toContain('[REDACTED]');
  });

  it('bounds an error string at 512 chars', () => {
    // Non-secret-shaped text — a bare alphanumeric run this long would
    // itself match a scrubber pattern, which is exactly what we don't want
    // here: this test measures the length bound, not redaction.
    const { res, out } = fakeRes();
    sendJson(res, 400, { error: `bad input: ${'lorem ipsum dolor sit amet '.repeat(60)}` });
    const parsed = JSON.parse(out.body) as { error: string };
    expect(parsed.error.length).toBe(512);
  });

  it('leaves non-error bodies untouched', () => {
    const { res, out } = fakeRes();
    sendJson(res, 404, { code: 'NOT_FOUND', detail: 'static' });
    expect(JSON.parse(out.body)).toEqual({ code: 'NOT_FOUND', detail: 'static' });
  });
});

describe('sendJson (read-session.ts boundary) — same contract', () => {
  it('redacts a secret-shaped value embedded in an error string', () => {
    const { res, out } = fakeRes();
    sendBoundaryJson(res, 401, { error: `bad ticket: ${SECRET_PROBE}` });
    expect(out.status).toBe(401);
    expect(out.body).not.toContain(SECRET_PROBE);
    expect(out.body).toContain('[REDACTED]');
  });

  it('bounds an error string at 512 chars', () => {
    const { res, out } = fakeRes();
    sendBoundaryJson(res, 400, { error: `bad input: ${'lorem ipsum dolor sit amet '.repeat(60)}` });
    const parsed = JSON.parse(out.body) as { error: string };
    expect(parsed.error.length).toBe(512);
  });

  it('keeps a 204 empty when the body is undefined', () => {
    const { res, out } = fakeRes();
    sendBoundaryJson(res, 204, undefined);
    expect(out.status).toBe(204);
    expect(out.body).toBe('');
  });
});

describe('passesMutationGate — 401/415 carry no token material', () => {
  const expected = 'f'.repeat(64); // server-side mutation token shape

  it('401 on a wrong token echoes neither the presented nor the expected token', () => {
    const { res, out } = fakeRes();
    const ok = passesMutationGate(fakeReq(probeHeaders()), res, expected);
    expect(ok).toBe(false);
    expect(out.status).toBe(401);
    expect(out.body).not.toContain(WRONG_TOKEN_PROBE);
    expect(out.body).not.toContain(expected);
    expect(JSON.parse(out.body)).toEqual({ error: 'unauthorized: missing or invalid x-ashlr-token' });
  });

  it('415 on a non-JSON Content-Type is a fixed message', () => {
    const { res, out } = fakeRes();
    const ok = passesMutationGate(
      fakeReq({ 'x-ashlr-token': expected, 'content-type': 'text/plain' }),
      res,
      expected,
    );
    expect(ok).toBe(false);
    expect(out.status).toBe(415);
    expect(JSON.parse(out.body)).toEqual({ error: 'Content-Type must be application/json' });
  });

  it('accepts the right token + JSON Content-Type without writing anything', () => {
    const { res, out } = fakeRes();
    const ok = passesMutationGate(
      fakeReq({ 'x-ashlr-token': expected, 'content-type': 'application/json' }),
      res,
      expected,
    );
    expect(ok).toBe(true);
    expect(out.status).toBe(0);
    expect(out.body).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Full-pipeline fixtures
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: data,
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

let openHandles: WebServerHandle[] = [];
let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  openHandles = [];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-api-noecho-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// readProjections: null keeps the in-process readers (no worker thread) — the
// security boundary being tested is identical either way.
async function serve(overrides: Partial<WebServerOptions> = {}): Promise<WebServerHandle> {
  const h = await startRealServer(makeConfig(), { port: 0, open: false, allowDispatch: false, ...overrides },
    { readProjections: null });
  openHandles.push(h);
  return h;
}

const hostOf = (h: WebServerHandle) => `127.0.0.1:${h.port}`;

// ---------------------------------------------------------------------------
// Unauthenticated boundary — every denial is a fixed message
// ---------------------------------------------------------------------------

describe('unauthenticated boundary — denials echo nothing', () => {
  it('GET /api/* without authority → 401 carrying none of the request headers or server tokens', async () => {
    const h = await serve();
    for (const route of ['/api/snapshot', '/api/runs', '/api/events', '/api/verse/sessions', '/api']) {
      const res = await httpRequest('GET', `${h.url}${route}`, { Host: hostOf(h), ...probeHeaders() });
      expect(res.statusCode).toBe(401);
      expectNoEcho(res, [h.token, h.readToken]);
    }
  });

  it('a token guess in the query-string client proof is not reflected', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/events?client=${READ_CLIENT_PROBE}&topics=runs`, {
      Host: hostOf(h),
      ...probeHeaders(),
    });
    expect(res.statusCode).toBe(401);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('foreign Host → 403 that never quotes the supplied Host value', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/snapshot`, {
      Host: 'probe-host.evil.test',
      ...probeHeaders(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('probe-host.evil.test');
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('POST /api/session with a wrong token → 401 with no echo', async () => {
    const h = await serve();
    const res = await httpRequest('POST', `${h.url}/api/session`, { Host: hostOf(h), ...probeHeaders() });
    expect(res.statusCode).toBe(401);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('POST /api/session with a bad client proof → 400 with no echo of either value', async () => {
    const h = await serve();
    const res = await httpRequest('POST', `${h.url}/api/session`, {
      Host: hostOf(h),
      'x-ashlr-token': h.readToken,
      'x-ashlr-read-client': 'not-hex-probe',
      cookie: COOKIE_PROBE,
      authorization: AUTH_PROBE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('not-hex-probe');
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('DELETE /api/session without a valid ticket → 401 with no echo', async () => {
    const h = await serve();
    const res = await httpRequest('DELETE', `${h.url}/api/session`, { Host: hostOf(h), ...probeHeaders() });
    expect(res.statusCode).toBe(401);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('other methods on /api/session → 405 with no echo', async () => {
    const h = await serve();
    const res = await httpRequest('PUT', `${h.url}/api/session`, { Host: hostOf(h), ...probeHeaders() });
    expect(res.statusCode).toBe(405);
    expectNoEcho(res, [h.token, h.readToken]);
  });
});

// ---------------------------------------------------------------------------
// Read-route errors — the echoes that exist are scrubbed, never raw
// ---------------------------------------------------------------------------

describe('read-route errors — secret-shaped path values come back [REDACTED]', () => {
  it('GET /api/run/<secret> → 404 echoes the id only as [REDACTED]', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/run/${SECRET_PROBE}`, {
      Host: hostOf(h),
      'x-ashlr-token': h.readToken,
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('[REDACTED]');
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('GET /api/run/<server read token> → 404 never repeats it', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/run/${h.readToken}`, {
      Host: hostOf(h),
      'x-ashlr-token': h.readToken,
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(h.readToken);
    expect(res.body).toContain('[REDACTED]');
  });

  it('GET /api/swarm/<secret> and /api/inbox/<secret> → 404s redact the id', async () => {
    const h = await serve();
    for (const route of [`/api/swarm/${SECRET_PROBE}`, `/api/inbox/${SECRET_PROBE}`, `/api/autonomy/evidence/${SECRET_PROBE}`]) {
      const res = await httpRequest('GET', `${h.url}${route}`, {
        Host: hostOf(h),
        ...probeHeaders({ 'x-ashlr-token': h.readToken }),
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('[REDACTED]');
      expectNoEcho(res, [h.token, h.readToken]);
    }
  });

  it('GET /api/run/<plain id> → 404 may echo a non-secret id but nothing else', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/run/${PATH_PROBE}`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain(PATH_PROBE); // the deliberate UX echo
    expectNoEcho(res, [h.token, h.readToken], [PATH_PROBE]); // everything else stays out
  });

  it('GET /api/run/<id>/events without a read session → 401 carrying nothing', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/run/${PATH_PROBE}/events`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(401);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('GET /api/events with header authority but no session → 401 SESSION_REQUIRED, no echo', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/events`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(401);
    expectNoEcho(res, [h.token, h.readToken]);
  });
});

// ---------------------------------------------------------------------------
// Query-param echoes — scrubbed like every other error field
// ---------------------------------------------------------------------------

describe('inbox query errors — echoed values are scrubbed', () => {
  it('?status=<secret> → 400 with [REDACTED]', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/inbox?status=${SECRET_PROBE}`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('[REDACTED]');
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('?since=<secret> and ?limit=<secret> → 400s with [REDACTED]', async () => {
    const h = await serve();
    for (const route of [`/api/inbox?since=${SECRET_PROBE}`, `/api/inbox?limit=${SECRET_PROBE}`]) {
      const res = await httpRequest('GET', `${h.url}${route}`, {
        Host: hostOf(h),
        ...probeHeaders({ 'x-ashlr-token': h.readToken }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('[REDACTED]');
      expectNoEcho(res, [h.token, h.readToken]);
    }
  });

  it('a plain invalid value may echo for UX — but headers never ride along', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/inbox?status=${PATH_PROBE}`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(PATH_PROBE);
    expectNoEcho(res, [h.token, h.readToken], [PATH_PROBE]);
  });
});

// ---------------------------------------------------------------------------
// Unknown routes — path echo is pathname-only, never the query
// ---------------------------------------------------------------------------

describe('unknown-route 404s — echo the path, never the query', () => {
  it('GET /api/<unknown>?<secret> → 404 names only the pathname', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/${PATH_PROBE}?p=${SECRET_PROBE}&q=${QUERY_PROBE}`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain(`/api/${PATH_PROBE}`);
    expect(res.body).not.toContain(SECRET_PROBE);
    expect(res.body).not.toContain(QUERY_PROBE);
    expectNoEcho(res, [h.token, h.readToken], [PATH_PROBE]);
  });

  it('GET /api/verse/<unknown> → 404 through the verse handler with no echo', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/verse/${PATH_PROBE}?p=${SECRET_PROBE}`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain(PATH_PROBE);
    expect(res.body).not.toContain(SECRET_PROBE);
    expectNoEcho(res, [h.token, h.readToken], [PATH_PROBE]);
  });

  it('a wrong method on a known read route → 404, no echo', async () => {
    const h = await serve();
    const res = await httpRequest('DELETE', `${h.url}/api/snapshot`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(404);
    expectNoEcho(res, [h.token, h.readToken]);
  });
});

// ---------------------------------------------------------------------------
// Mutation gate — the deny paths around the dispatch token
// ---------------------------------------------------------------------------

describe('mutation gate — denials never carry token material', () => {
  it('POST /api/run while dispatch is disabled → 404, no echo', async () => {
    const h = await serve(); // allowDispatch: false
    const res = await httpRequest('POST', `${h.url}/api/run`, {
      Host: hostOf(h),
      'content-type': 'application/json',
      ...probeHeaders(),
    }, JSON.stringify({ goal: 'x' }));
    expect(res.statusCode).toBe(404);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('POST /api/run with a wrong token → 401 with neither presented nor real token', async () => {
    const h = await serve({ allowDispatch: true });
    const res = await httpRequest('POST', `${h.url}/api/run`, {
      Host: hostOf(h),
      'content-type': 'application/json',
      ...probeHeaders(),
    }, JSON.stringify({ goal: 'x' }));
    expect(res.statusCode).toBe(401);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('POST /api/run with the right token but a form Content-Type → 415, no echo', async () => {
    const h = await serve({ allowDispatch: true });
    const res = await httpRequest('POST', `${h.url}/api/run`, {
      Host: hostOf(h),
      'content-type': 'application/x-www-form-urlencoded',
      ...probeHeaders({ 'x-ashlr-token': h.token }),
    }, 'goal=x');
    expect(res.statusCode).toBe(415);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('POST /api/run body-validation errors echo no body content', async () => {
    const h = await serve({ allowDispatch: true });
    const bodies = [
      `${SECRET_PROBE}{`, // malformed JSON
      '[]', // not an object
      JSON.stringify({ goal: 42, credential: SECRET_PROBE }), // goal not a string
    ];
    for (let i = 0; i < bodies.length; i++) {
      const res = await httpRequest('POST', `${h.url}/api/run`, {
        Host: hostOf(h),
        'content-type': 'application/json',
        ...probeHeaders({ 'x-ashlr-token': h.token }),
      }, bodies[i]);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(SECRET_PROBE);
      expectNoEcho(res, [h.token, h.readToken]);
    }
  });

  it('POST /api/run with an oversized body → error without echo', async () => {
    const h = await serve({ allowDispatch: true });
    const res = await httpRequest('POST', `${h.url}/api/run`, {
      Host: hostOf(h),
      'content-type': 'application/json',
      ...probeHeaders({ 'x-ashlr-token': h.token }),
    }, `{${'x'.repeat(70_000)}`);
    expect([400, 413]).toContain(res.statusCode);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('POST /api/inbox/<secret>/approve → 404 redacts the id; wrong token → 401 clean', async () => {
    const h = await serve({ allowDispatch: true });
    const denied = await httpRequest('POST', `${h.url}/api/inbox/${SECRET_PROBE}/approve`, {
      Host: hostOf(h),
      'content-type': 'application/json',
      ...probeHeaders(), // wrong token
    }, '{}');
    expect(denied.statusCode).toBe(401);
    expectNoEcho(denied, [h.token, h.readToken]);

    const missing = await httpRequest('POST', `${h.url}/api/inbox/${SECRET_PROBE}/approve`, {
      Host: hostOf(h),
      'content-type': 'application/json',
      ...probeHeaders({ 'x-ashlr-token': h.token }),
    }, '{}');
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('[REDACTED]');
    expectNoEcho(missing, [h.token, h.readToken]);
  });

  it('POST /api/open 403 does not repeat the submitted repo path', async () => {
    const h = await serve({ allowDispatch: true });
    const res = await httpRequest('POST', `${h.url}/api/open`, {
      Host: hostOf(h),
      'content-type': 'application/json',
      ...probeHeaders({ 'x-ashlr-token': h.token }),
    }, JSON.stringify({ repo: `/tmp/${PATH_PROBE}` }));
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(PATH_PROBE);
    expectNoEcho(res, [h.token, h.readToken]);
  });

  it('POST /api/fleet/pause and /api/daemon/service/repair denials carry no echo', async () => {
    const h = await serve({ allowDispatch: true });
    for (const route of ['/api/fleet/pause', '/api/fleet/resume', '/api/daemon/service/repair']) {
      const res = await httpRequest('POST', `${h.url}${route}`, {
        Host: hostOf(h),
        'content-type': 'application/json',
        ...probeHeaders(), // wrong token
      }, '{}');
      expect(res.statusCode).toBe(401);
      expectNoEcho(res, [h.token, h.readToken]);
    }
  });

  it('the same routes 404 without dispatch — never confirming existence to a token probe', async () => {
    const h = await serve(); // dispatch off
    for (const route of ['/api/fleet/pause', '/api/daemon/service/repair', '/api/open', '/api/inbox/p1/approve']) {
      const res = await httpRequest('POST', `${h.url}${route}`, {
        Host: hostOf(h),
        'content-type': 'application/json',
        ...probeHeaders(),
      }, '{}');
      expect(res.statusCode).toBe(404);
      expectNoEcho(res, [h.token, h.readToken]);
    }
  });
});

// ---------------------------------------------------------------------------
// Internal errors — a thrown credential-carrying error never reaches the wire
// ---------------------------------------------------------------------------

describe('500 path — internal error text is discarded', () => {
  it('a handler throwing a secret-laden error returns only the fixed message', async () => {
    const h = await serve();
    vi.mocked(loadRun).mockImplementationOnce(() => {
      throw new Error(`fs failed: ${SECRET_PROBE} token=${h.token} home=${tmpHome}`);
    });
    const res = await httpRequest('GET', `${h.url}/api/run/${PATH_PROBE}`, {
      Host: hostOf(h),
      ...probeHeaders({ 'x-ashlr-token': h.readToken }),
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET_PROBE);
    expect(res.body).not.toContain(h.token);
    expect(res.body).not.toContain(h.readToken);
    expect(res.body).not.toContain(tmpHome);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'INTERNAL_ERROR' });
    expectNoEcho(res, [h.token, h.readToken]);
  });
});

// ---------------------------------------------------------------------------
// Security headers on error responses
// ---------------------------------------------------------------------------

describe('error-response headers', () => {
  it('JSON errors carry no-store + nosniff and never reflect request headers', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/snapshot`, { Host: hostOf(h), ...probeHeaders() });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['cache-control'])).toContain('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const headerBlock = JSON.stringify(res.headers);
    for (const probe of ALL_PROBES) expect(headerBlock).not.toContain(probe);
    // 'Vary' may name the auth header names — names, never values.
    expect(headerBlock).not.toContain(WRONG_TOKEN_PROBE);
  });
});
