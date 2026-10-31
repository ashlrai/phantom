/**
 * wb-read-api.test.ts — GET /api/wb/v1/{snapshot,gh,budget} coverage.
 *
 * The versioned loopback read surface for the desktop native shell
 * (desktop/src-tauri fleet_ops.rs):
 *
 *   - 401 without a token: these are /api/* GETs, so the read-session
 *     boundary in server.ts denies them before handleApi is reached.
 *   - Snapshot honesty: a stale or malformed capacity fixture
 *     (~/.ashlr/routing/capacity.json) answers `state:'unknown'` with a
 *     named reason — never old/malformed data presented as current.
 *   - GitHub cache + backoff: the gh read is single-flight cached (second
 *     poll within the TTL never re-invokes the fetch), and a failing fetch
 *     opens a backoff window in which polls are answered without retrying.
 *   - Loopback-only: the handle's url is 127.0.0.1, never 0.0.0.0.
 *   - Redaction: a secret-shaped string inside fixture data is scrubbed to
 *     [REDACTED] by sanitizePublicJson — never echoed verbatim.
 *
 * Hermetic: one real loopback server per test over a tmp HOME; the GitHub
 * reader is the only module mocked (the gh subprocess seam).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerHandle, WebServerOptions } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// gh reader seam — the only mocked module. The wb gh route composes
// readVerseGithubSnapshotAsync; tests control it directly to prove the cache
// (call-count) and the backoff window (no retry while it is open).
// ---------------------------------------------------------------------------

const ghReadMock = vi.fn<() => Promise<unknown>>();

vi.mock('../src/core/verse/github-repo.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/verse/github-repo.js')>();
  return {
    ...orig,
    readVerseGithubSnapshotAsync: (...args: unknown[]) => ghReadMock(...args),
  };
});

import { startServer as startRealServer } from '../src/core/web/server.js';
import {
  capacitySnapshotPath,
  writeCapacitySnapshot,
} from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_PROBE = ['sk', '-FAKE', '-wbProbe', 'Secret9', '0123456789', 'abcdef'].join('');

function makeSeat(overrides: Partial<SeatCapacity> = {}): SeatCapacity {
  return {
    seatId: 'seat-claude-1',
    engine: 'claude',
    label: 'Claude seat',
    free: false,
    windows: [],
    signedOut: false,
    reachable: true,
    contextWindow: null,
    observedAt: new Date().toISOString(),
    spentTodayUsd: 1.5,
    ...overrides,
  };
}

const FAKE_GH_SNAPSHOT = {
  repos: [
    {
      path: '/tmp/repo',
      name: 'repo',
      remote: { state: 'github', nameWithOwner: 'ashlrai/phantom' },
      prs: [],
      issues: [],
      listsRequested: true,
      prsAvailable: true,
      issuesAvailable: true,
      observedAt: '2026-10-28T00:00:00.000Z',
      detail: '0 open pull requests, 0 open issues',
    },
  ],
  observedAt: '2026-10-28T00:00:00.000Z',
};

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
    req.end();
  });
}

const hostOf = (h: WebServerHandle) => `127.0.0.1:${h.port}`;
const authHeaders = (h: WebServerHandle) => ({ Host: hostOf(h), 'x-ashlr-token': h.readToken });

// ---------------------------------------------------------------------------
// Server lifecycle (readProjections: null keeps in-process readers — same
// boundary, no worker thread)
// ---------------------------------------------------------------------------

let openHandles: WebServerHandle[] = [];
let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  openHandles = [];
  ghReadMock.mockReset();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wb-api-'));
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

async function serve(overrides: Partial<WebServerOptions> = {}): Promise<WebServerHandle> {
  const h = await startRealServer(makeConfig(), { port: 0, open: false, allowDispatch: false, ...overrides },
    { readProjections: null });
  openHandles.push(h);
  return h;
}

// ---------------------------------------------------------------------------
// Loopback bind + unauthenticated boundary
// ---------------------------------------------------------------------------

describe('bind + auth boundary', () => {
  it('binds 127.0.0.1 only — the handle url is never 0.0.0.0 or a hostname', async () => {
    const h = await serve();
    expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('GET /api/wb/v1/* without a token → 401 on all three routes', async () => {
    const h = await serve();
    for (const route of ['/api/wb/v1/snapshot', '/api/wb/v1/gh', '/api/wb/v1/budget']) {
      const res = await httpRequest('GET', `${h.url}${route}`, { Host: hostOf(h) });
      expect(res.statusCode, `${route} without a token`).toBe(401);
      expect(res.body).not.toContain(h.readToken);
      expect(res.body).not.toContain(h.token);
    }
  });

  it('GET /api/wb/v1/* with the read token → 200s with a v:1 contract', async () => {
    const h = await serve();
    ghReadMock.mockResolvedValue(FAKE_GH_SNAPSHOT);
    for (const route of ['/api/wb/v1/snapshot', '/api/wb/v1/gh', '/api/wb/v1/budget']) {
      const res = await httpRequest('GET', `${h.url}${route}`, authHeaders(h));
      expect(res.statusCode, route).toBe(200);
      expect(JSON.parse(res.body).v).toBe(1);
    }
  });

  it('POST /api/wb/v1/snapshot → 405; unknown subpath → 404', async () => {
    const h = await serve();
    const post = await httpRequest('POST', `${h.url}/api/wb/v1/snapshot`, authHeaders(h));
    expect(post.statusCode).toBe(405);
    const miss = await httpRequest('GET', `${h.url}/api/wb/v1/nope`, authHeaders(h));
    expect(miss.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wb/v1/snapshot — capacity snapshot honesty
// ---------------------------------------------------------------------------

describe('GET /api/wb/v1/snapshot', () => {
  it('missing fixture → state unknown, reason missing', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/wb/v1/snapshot`, authHeaders(h));
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.state).toBe('unknown');
    expect(body.reason).toBe('missing');
    expect(body.seats).toEqual([]);
  });

  it('invalid (malformed) fixture → state unknown, reason invalid', async () => {
    fs.mkdirSync(path.dirname(capacitySnapshotPath()), { recursive: true });
    fs.writeFileSync(capacitySnapshotPath(), '{not-json\n', { mode: 0o600 });
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/wb/v1/snapshot`, authHeaders(h));
    const body = JSON.parse(res.body);
    expect(body.state).toBe('unknown');
    expect(body.reason).toBe('invalid');
    expect(body.seats).toEqual([]);
  });

  it('stale fixture (published 30 min ago) → state unknown, reason stale', async () => {
    writeCapacitySnapshot([makeSeat()], new Date(Date.now() - 30 * 60_000));
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/wb/v1/snapshot`, authHeaders(h));
    const body = JSON.parse(res.body);
    expect(body.state).toBe('unknown');
    expect(body.reason).toBe('stale');
    expect(body.seats).toEqual([]);
    expect(body.publishedAt).toBeTruthy();
  });

  it('fresh fixture → state ok with the projected seats', async () => {
    writeCapacitySnapshot([makeSeat()], new Date());
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/wb/v1/snapshot`, authHeaders(h));
    const body = JSON.parse(res.body);
    expect(body.state).toBe('ok');
    expect(body.reason).toBeNull();
    expect(body.seats).toHaveLength(1);
    expect(body.seats[0].seatId).toBe('seat-claude-1');
    expect(body.seats[0].engine).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// GET /api/wb/v1/gh — single-flight cache + failure backoff
// ---------------------------------------------------------------------------

describe('GET /api/wb/v1/gh', () => {
  it('two polls inside the TTL share one fetch (cache)', async () => {
    const h = await serve();
    ghReadMock.mockResolvedValue(FAKE_GH_SNAPSHOT);

    const first = await httpRequest('GET', `${h.url}/api/wb/v1/gh`, authHeaders(h));
    const second = await httpRequest('GET', `${h.url}/api/wb/v1/gh`, authHeaders(h));

    expect(ghReadMock).toHaveBeenCalledTimes(1);
    for (const res of [first, second]) {
      const body = JSON.parse(res.body);
      expect(body.state).toBe('ok');
      expect(body.stale).toBe(false);
      expect(body.repos).toHaveLength(1);
    }
  });

  it('a failing fetch answers unknown and opens backoff — the next poll does not retry', async () => {
    const h = await serve();
    ghReadMock.mockRejectedValue(new Error('gh is down'));

    const first = await httpRequest('GET', `${h.url}/api/wb/v1/gh`, authHeaders(h));
    const body1 = JSON.parse(first.body);
    expect(first.statusCode).toBe(200);
    expect(body1.state).toBe('unknown');
    expect(body1.reason).toBe('unavailable');
    expect(ghReadMock).toHaveBeenCalledTimes(1);

    // Inside the backoff window: answered without another fetch attempt.
    const second = await httpRequest('GET', `${h.url}/api/wb/v1/gh`, authHeaders(h));
    const body2 = JSON.parse(second.body);
    expect(ghReadMock).toHaveBeenCalledTimes(1);
    expect(body2.state).toBe('unknown');
    expect(body2.backoff).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/wb/v1/budget — policy + seat usage projection
// ---------------------------------------------------------------------------

describe('GET /api/wb/v1/budget', () => {
  it('fresh fixture → policy + seats + total spentTodayUsd', async () => {
    writeCapacitySnapshot([makeSeat({ spentTodayUsd: 2 }), makeSeat({ seatId: 'seat-2', spentTodayUsd: 0.5 })], new Date());
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/wb/v1/budget`, authHeaders(h));
    const body = JSON.parse(res.body);
    expect(body.state).toBe('ok');
    expect(body.policy).toBeTruthy();
    expect(typeof body.policy.mode).toBe('string');
    expect(body.seats).toHaveLength(2);
    expect(body.spentTodayUsd).toBeCloseTo(2.5);
  });

  it('missing fixture → policy still answers, seat state is unknown', async () => {
    const h = await serve();
    const res = await httpRequest('GET', `${h.url}/api/wb/v1/budget`, authHeaders(h));
    const body = JSON.parse(res.body);
    expect(body.state).toBe('unknown');
    expect(body.reason).toBe('missing');
    expect(body.policy).toBeTruthy(); // config is not collected evidence
    expect(body.seats).toEqual([]);
    expect(body.spentTodayUsd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Redaction — secret-shaped fixture data never comes back verbatim
// ---------------------------------------------------------------------------

describe('redaction of secret-shaped input', () => {
  it('a secret-shaped seat label is scrubbed to [REDACTED], never echoed', async () => {
    writeCapacitySnapshot([makeSeat({ label: `seat key ${SECRET_PROBE}` })], new Date());
    const h = await serve();
    for (const route of ['/api/wb/v1/snapshot', '/api/wb/v1/budget']) {
      const res = await httpRequest('GET', `${h.url}${route}`, authHeaders(h));
      expect(res.statusCode).toBe(200);
      expect(res.body, route).not.toContain(SECRET_PROBE);
      expect(res.body, route).toContain('[REDACTED]');
    }
  });

  it('a secret-shaped gh detail string is scrubbed the same way', async () => {
    const h = await serve();
    ghReadMock.mockResolvedValue({
      ...FAKE_GH_SNAPSHOT,
      repos: [{ ...FAKE_GH_SNAPSHOT.repos[0], detail: `token ${SECRET_PROBE}` }],
    });
    const res = await httpRequest('GET', `${h.url}/api/wb/v1/gh`, authHeaders(h));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET_PROBE);
    expect(res.body).toContain('[REDACTED]');
  });
});
