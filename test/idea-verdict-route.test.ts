/**
 * idea-verdict-route.test.ts — POST /api/ideas/verdict and the verdict
 * annotation on GET /api/backlog (RQ-PHX-IDEANOTNOW94).
 *
 * Units under test:
 *   1. POST /api/ideas/verdict — 404 without dispatch, 401 without the token,
 *      415 without JSON, 400 on an unknown verdict or empty ideaId, 200 on a
 *      valid body (and the file has a new line).
 *   2. GET /api/backlog — items carry their latest verdict after a POST.
 *
 * Mirrors m104 conventions: HOME relocated to a fresh tmp dir per test, heavy
 * transitive imports of api.ts mocked, handleApi driven with fake req/res.
 * The verdict store itself is REAL — it writes under the relocated HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// vi.mock factories — same transitive-import shielding as m104.web-goals.
// ---------------------------------------------------------------------------

vi.mock('../src/core/goals/store.js', () => ({
  listGoals: vi.fn(() => []),
  loadGoal:  vi.fn(() => null),
  saveGoal:  vi.fn(),
  createGoal: vi.fn(),
  goalsDir:  () => '/tmp/goals',
}));

vi.mock('../src/core/goals/advance.js', () => ({
  progressOf:             vi.fn(),
  advanceGoal:            vi.fn(),
  nextActionableMilestone: vi.fn(() => null),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: vi.fn(() => []),
  loadProposal:  vi.fn(() => null),
  setStatus:     vi.fn(),
}));

vi.mock('../src/core/dashboard.js',            () => ({ buildSnapshot: vi.fn(async () => ({})) }));
vi.mock('../src/core/run/orchestrator.js',      () => ({ listRuns: vi.fn(() => []), loadRun: vi.fn(() => null), runGoal: vi.fn() }));
vi.mock('../src/core/swarm/store.js',           () => ({ listSwarms: vi.fn(() => []), loadSwarm: vi.fn(() => null) }));
vi.mock('../src/core/observability/rollup.js',  () => ({ buildRollup: vi.fn(() => ({})) }));
vi.mock('../src/core/genome/store.js',          () => ({ loadGenome: vi.fn(() => []) }));
vi.mock('../src/core/genome/recall.js',         () => ({ recall: vi.fn(async () => []) }));
vi.mock('../src/core/daemon/state.js',          () => ({ loadDaemonState: vi.fn(() => ({ running: false })) }));
vi.mock('../src/core/fleet/status.js',          () => ({ buildFleetStatus: vi.fn(async () => ({})) }));
vi.mock('../src/core/web/control.js',           () => ({ buildControlSnapshot: vi.fn(async () => ({ logs: [], models: {} })), buildFleetActivity: vi.fn(async () => ({})) }));
vi.mock('../src/cli/open.js',                   () => ({ openInEditor: vi.fn(), openInFinder: vi.fn(), openInTerminal: vi.fn(), editorDeepLink: vi.fn((p: string) => p) }));
vi.mock('../src/core/sandbox/policy.js',        () => ({ listEnrolled: () => [], isEnrolled: () => false, assertMayMutate: vi.fn(), enroll: vi.fn(), unenroll: vi.fn(), killSwitchOn: () => false, enrollmentPath: () => '/tmp/e.json', killSwitchPath: () => '/tmp/KILL' }));

// The backlog the Ideas pane reads — two seeded items, declared inside the
// factory so hoisting cannot race initialization.
vi.mock('../src/core/portfolio/backlog.js', () => {
  const items = [
    { id: 'idea-1', repo: '/repos/alpha', source: 'issue', title: 'Add retries', detail: '', value: 4, effort: 2, score: 9, tags: [], ts: '2026-11-01T00:00:00.000Z' },
    { id: 'idea-2', repo: '/repos/alpha', source: 'todo', title: 'Tidy tests', detail: '', value: 3, effort: 1, score: 7, tags: [], ts: '2026-11-01T00:00:00.000Z' },
  ];
  return {
    loadBacklog: vi.fn(() => ({ generatedAt: '2026-11-09T00:00:00.000Z', repos: ['/repos/alpha'], items: items.map(i => ({ ...i })) })),
    buildBacklog: vi.fn(async () => ({ generatedAt: '', repos: [], items: [] })),
    enqueueBacklogItems: vi.fn(() => 0),
  };
});

// Import AFTER mocks are registered.
import { handleApi } from '../src/core/web/api.js';

// ---------------------------------------------------------------------------
// Helpers (m104 pattern)
// ---------------------------------------------------------------------------

function baseConfig() {
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
  };
}

const TEST_TOKEN = 'test-token-verdicts';
const writeCtx = { token: TEST_TOKEN, allowDispatch: true };
const readCtx = { token: TEST_TOKEN, allowDispatch: false };

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-verdict-route-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  vi.clearAllMocks();
});

interface FakeResponse { statusCode: number; body: string; headers: Record<string, string>; ended: boolean; }

function makeFakeReqRes(opts: { method?: string; url?: string; headers?: Record<string, string>; body?: string; }): { req: IncomingMessage; res: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { statusCode: 200, body: '', headers: {}, ended: false };
  const req = new EventEmitter() as IncomingMessage;
  req.method = opts.method ?? 'GET';
  req.url = opts.url ?? '/api/backlog';
  req.headers = opts.headers ?? {};
  process.nextTick(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(opts.body, 'utf8'));
    req.emit('end');
  });
  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status; if (headers) Object.assign(captured.headers, headers); this.headersSent = true;
    },
    end(data?: string) { if (data) captured.body += data; captured.ended = true; },
    write() { return true; },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

const parsedBody = (captured: FakeResponse): any => { try { return JSON.parse(captured.body); } catch { return null; } };
const writeHeaders = { 'x-ashlr-token': TEST_TOKEN, 'content-type': 'application/json' };
const verdictPost = (body: unknown) => makeFakeReqRes({ method: 'POST', url: '/api/ideas/verdict', headers: writeHeaders, body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// POST /api/ideas/verdict
// ---------------------------------------------------------------------------

describe('POST /api/ideas/verdict', () => {
  it('is a 404 when dispatch is disabled', async () => {
    const { req, res, captured } = verdictPost({ ideaId: 'idea-1', verdict: 'never' });
    await handleApi(req, res, baseConfig() as any, readCtx);
    expect(captured.statusCode).toBe(404);
  });

  it('is a 401 without the mutation token', async () => {
    const { req, res, captured } = makeFakeReqRes({ method: 'POST', url: '/api/ideas/verdict', headers: { 'content-type': 'application/json' }, body: '{}' });
    await handleApi(req, res, baseConfig() as any, writeCtx);
    expect(captured.statusCode).toBe(401);
  });

  it('is a 415 without a JSON content type', async () => {
    const { req, res, captured } = makeFakeReqRes({ method: 'POST', url: '/api/ideas/verdict', headers: { 'x-ashlr-token': TEST_TOKEN }, body: '{}' });
    await handleApi(req, res, baseConfig() as any, writeCtx);
    expect(captured.statusCode).toBe(415);
  });

  it('rejects an unknown verdict and an empty ideaId', async () => {
    for (const body of [
      { ideaId: 'idea-1', verdict: 'snooze' },
      { ideaId: '', verdict: 'never' },
      { verdict: 'never' },
      { ideaId: 'idea-1' },
      'text',
    ]) {
      const { req, res, captured } = verdictPost(body);
      await handleApi(req, res, baseConfig() as any, writeCtx);
      expect(captured.statusCode).toBe(400);
    }
  });

  it('accepts a valid verdict and appends it to the store', async () => {
    const { req, res, captured } = verdictPost({ ideaId: 'idea-1', verdict: 'not-now', reason: 'busy this week' });
    await handleApi(req, res, baseConfig() as any, writeCtx);
    expect(captured.statusCode).toBe(200);
    const body = parsedBody(captured);
    expect(body.ok).toBe(true);
    expect(body.entry).toMatchObject({ ideaId: 'idea-1', verdict: 'not-now', reason: 'busy this week' });
    const lines = readFileSync(join(tmpHome, '.ashlr', 'idea-verdicts.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ideaId: 'idea-1', verdict: 'not-now' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/backlog reflects recorded verdicts
// ---------------------------------------------------------------------------

describe('GET /api/backlog verdict annotation', () => {
  it('carries no verdict field before any verdict is recorded', async () => {
    const { req, res, captured } = makeFakeReqRes({ url: '/api/backlog' });
    await handleApi(req, res, baseConfig() as any, readCtx);
    expect(captured.statusCode).toBe(200);
    const items = parsedBody(captured).items as { id: string; verdict?: unknown }[];
    expect(items.every(i => i.verdict === undefined)).toBe(true);
  });

  it('annotates items with their latest verdict after a POST', async () => {
    const post = verdictPost({ ideaId: 'idea-1', verdict: 'never', reason: 'dropped on purpose' });
    await handleApi(post.req, post.res, baseConfig() as any, writeCtx);
    expect(post.captured.statusCode).toBe(200);

    const { req, res, captured } = makeFakeReqRes({ url: '/api/backlog' });
    await handleApi(req, res, baseConfig() as any, readCtx);
    expect(captured.statusCode).toBe(200);
    const items = parsedBody(captured).items as { id: string; verdict?: { verdict: string; reason: string } }[];
    expect(items.find(i => i.id === 'idea-1')?.verdict).toMatchObject({ verdict: 'never', reason: 'dropped on purpose' });
    expect(items.find(i => i.id === 'idea-2')?.verdict).toBeUndefined();
  });
});
