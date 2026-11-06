/**
 * usage-resources.test.ts — RQ-NIGHT-USAGE-1: the twelve-resource registry
 * and the GET /api/verse/usage-resources boundary. Every row is real or an
 * explicit empty state; reader failures and secrets never reach the wire.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { readUsageResources, usageResourceReaders } from '../src/core/usage/resource-usage.js';
import { USAGE_RESOURCES, type UsageResourceReading } from '../src/core/usage/resource-usage-types.js';
import { handleUsageResourcesApi, setUsageResourcesReadForTest, USAGE_RESOURCES_PATH } from '../src/core/verse/usage-resources-api.js';
import { handleApi } from '../src/core/web/api.js';
import { handleVerseApi } from '../src/core/verse/verse-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { CodexSessionUsage } from '../src/core/fleet/codex-session-usage.js';
import type { DevinUsage, DevinUsageUnknown } from '../src/core/fabric/readers/devin-usage.js';
import type { GrokUltraRunway } from '../src/core/fleet/grok-ultra-types.js';
import type { ClaudeApiUsageResult } from '../src/core/fabric/usage-api.js';
import type { ClaudeApiGrantReadView } from '../src/core/resources/claude-api-grant-types.js';
import type { UsageResourcesSnapshot } from '../src/core/usage/resource-usage-types.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const now = () => NOW;

/** All real readers silenced, so a test sees the registry's own states only. */
const quietDeps = {
  now,
  env: {} as NodeJS.ProcessEnv,
  accountsRoot: '/fixture/accounts',
  collectCodex: vi.fn(() => [] as CodexSessionUsage[]),
  readDevin: vi.fn(async () => ({ status: 'unknown', reason: 'unavailable' }) as DevinUsageUnknown),
  readUltra: vi.fn(async () => ({ state: 'unavailable', targetAt: '', latest: null }) as unknown as GrokUltraRunway),
  readClaude: vi.fn(async () => null as ClaudeApiUsageResult | null),
  readGrants: vi.fn(async () => ({ v: 1, state: 'missing', rows: [] }) as unknown as ClaudeApiGrantReadView),
};

const EMPTY_STATES = new Set(['no-reader', 'no-reading', 'unavailable']);

function emptyRowChecks(row: { used: number | null; limit: number | null; resetsAt: string | null; source: string | null; asOf: string | null }): void {
  // A row without a real reading must not pretend one: every measured
  // column is null — no 0%, no fabricated limit, no invented reset.
  expect(row.used).toBeNull();
  expect(row.limit).toBeNull();
  expect(row.resetsAt).toBeNull();
  expect(row.asOf).toBeNull();
}

describe('readUsageResources', () => {
  it('always returns the twelve resources, in roster order', async () => {
    const snapshot = await readUsageResources({ ...quietDeps });
    expect(snapshot.v).toBe(1);
    expect(snapshot.generatedAt).toBe(new Date(NOW).toISOString());
    expect(snapshot.resources.map((row) => row.id)).toEqual(USAGE_RESOURCES.map((r) => r.id));
    expect(snapshot.resources).toHaveLength(12);
  });

  it('marks resources with no reader as no-reader, never a fake number', async () => {
    const snapshot = await readUsageResources({ ...quietDeps });
    const noReader = snapshot.resources.filter((row) => row.state === 'no-reader');
    expect(noReader.map((row) => row.id)).toEqual(['zai', 'agy', 'gemini-workspace', 'local', 'stacksync']);
    for (const row of noReader) emptyRowChecks(row);
    // Readers that ran but measured nothing are a different, honest state.
    for (const row of snapshot.resources.filter((r) => EMPTY_STATES.has(r.state))) emptyRowChecks(row);
  });

  it('feeds the codex rows from session-log windows (cmp + personal)', async () => {
    const collectCodex = vi.fn(() => [
      { accountId: 'codex-cmp', observedAt: '2026-11-02T11:00:00.000Z',
        primary: { usedPercent: 30, windowMinutes: 300, resetsAt: 1762600000 },
        secondary: { usedPercent: 62, windowMinutes: 10080, resetsAt: 1763000000 } } as CodexSessionUsage,
      { accountId: 'codex-personal', observedAt: '2026-11-02T11:30:00.000Z',
        primary: { usedPercent: 5, windowMinutes: 300, resetsAt: 1762600000 },
        secondary: null } as unknown as CodexSessionUsage,
    ]);
    const snapshot = await readUsageResources({ ...quietDeps, collectCodex });
    const cmp = snapshot.resources.find((row) => row.id === 'codex-cmp')!;
    expect(cmp.state).toBe('ok');
    // The most-saturated window governs: secondary 62% beats primary 30%.
    expect(cmp.used).toBe(62);
    expect(cmp.limit).toBe(100);
    expect(cmp.unit).toBe('percent');
    expect(cmp.resetsAt).toBe(new Date(1763000000 * 1000).toISOString());
    expect(cmp.source).toBe('codex-session-logs');
    expect(cmp.asOf).toBe('2026-11-02T11:00:00.000Z');
    const personal = snapshot.resources.find((row) => row.id === 'codex-personal')!;
    expect(personal.state).toBe('ok');
    expect(personal.used).toBe(5);
    expect(collectCodex).toHaveBeenCalledExactlyOnceWith({ env: quietDeps.env, homeDir: undefined });
  });

  it('feeds the Devin row from the org-cycle reader', async () => {
    const devin: DevinUsage = {
      pool: 'devin', acuUsed: 1240, acuLimit: 2000, pctUsed: 62,
      resetAt: '2026-12-01T00:00:00.000Z', source: 'devin-api-v3-org-cycle',
      fetchedAt: '2026-11-02T11:59:00.000Z',
    };
    const snapshot = await readUsageResources({ ...quietDeps, readDevin: vi.fn(async () => devin) });
    const row = snapshot.resources.find((r) => r.id === 'devin')!;
    expect(row).toMatchObject({ state: 'ok', used: 1240, limit: 2000, unit: 'acu',
      resetsAt: '2026-12-01T00:00:00.000Z', source: 'devin-api-v3-org-cycle', asOf: '2026-11-02T11:59:00.000Z' });
  });

  it('keeps codex/devin honest when their readers report nothing', async () => {
    const snapshot = await readUsageResources({ ...quietDeps });
    expect(snapshot.resources.find((r) => r.id === 'codex-cmp')!.state).toBe('no-reading');
    expect(snapshot.resources.find((r) => r.id === 'codex-personal')!.state).toBe('no-reading');
    expect(snapshot.resources.find((r) => r.id === 'devin')!.state).toBe('no-reading');
  });

  it('reads Ultra points from the grok-ultra runway store', async () => {
    const runway = { state: 'current', targetAt: '2026-11-30T00:00:00.000Z',
      latest: { source: 'manual', timestamp: '2026-11-02T10:00:00.000Z', remainingPoints: 37_660, totalPoints: 50_000 } } as unknown as GrokUltraRunway;
    const snapshot = await readUsageResources({ ...quietDeps, readUltra: vi.fn(async () => runway) });
    const ultra = snapshot.resources.find((r) => r.id === 'ultra')!;
    expect(ultra).toMatchObject({ state: 'ok', used: 12_340, limit: 50_000, unit: 'points',
      resetsAt: '2026-11-30T00:00:00.000Z', source: 'grok-ultra-manual', asOf: '2026-11-02T10:00:00.000Z' });
  });

  it('reads Claude Max and claude-api monthly from the OAuth usage endpoint', async () => {
    const claude: ClaudeApiUsageResult = {
      fiveHourPct: 20, fiveHourResetAt: 1762700000,
      weeklyPct: 55, weeklyResetAt: 1763300000,
      extraUsage: { isEnabled: true, usedCredits: 4.2, monthlyLimit: 25 },
    };
    const readClaude = vi.fn(async () => claude);
    const snapshot = await readUsageResources({ ...quietDeps, readClaude });
    const max = snapshot.resources.find((r) => r.id === 'claude-max')!;
    expect(max).toMatchObject({ state: 'ok', used: 55, limit: 100, unit: 'percent',
      resetsAt: new Date(1763300000 * 1000).toISOString(), source: 'claude-oauth-usage' });
    const monthly = snapshot.resources.find((r) => r.id === 'claude-api-monthly')!;
    expect(monthly).toMatchObject({ state: 'ok', used: 4.2, limit: 25, unit: 'usd',
      resetsAt: null, source: 'claude-oauth-usage' });
    expect(readClaude).toHaveBeenCalledTimes(2); // one read per row; the module's own cache dedupes the HTTP call
  });

  it('reads the claude-api gift balance from the recorded promotion store', async () => {
    const view = { v: 1, state: 'healthy', rows: [
      { v: 1, state: 'recorded', remainingUsdMicros: '200000000', totalUsdMicros: '250000000',
        capturedAt: '2026-11-02T09:00:00.000Z', expiryDate: '2026-12-24',
        admissionCutoff: '2026-12-24T00:00:00.000Z', cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held' },
      { v: 1, state: 'recorded', remainingUsdMicros: '50000000', totalUsdMicros: '100000000',
        capturedAt: '2026-11-01T09:00:00.000Z', expiryDate: '2026-11-24',
        admissionCutoff: '2026-11-24T00:00:00.000Z', cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held' },
    ] } as unknown as ClaudeApiGrantReadView;
    const snapshot = await readUsageResources({ ...quietDeps, readGrants: vi.fn(async () => view) });
    const gift = snapshot.resources.find((r) => r.id === 'claude-api-gift')!;
    // The newest recorded observation: $250 total, $200 remaining → $50 used.
    expect(gift).toMatchObject({ state: 'ok', used: 50, limit: 250, unit: 'usd',
      resetsAt: '2026-12-24T00:00:00.000Z', source: 'claude-api-grant-store', asOf: '2026-11-02T09:00:00.000Z' });
  });

  it('reports a thrown reader as unavailable and never leaks its message', async () => {
    const readers = { zai: () => { throw new Error('private-billing-token-abc123'); } };
    const snapshot = await readUsageResources({ ...quietDeps, readers });
    const row = snapshot.resources.find((r) => r.id === 'zai')!;
    expect(row.state).toBe('unavailable');
    expect(row.reason).toBe('reader-error');
    emptyRowChecks(row);
    expect(JSON.stringify(snapshot)).not.toContain('private-billing-token-abc123');
  });

  it('rejects a malformed or secret-shaped reading instead of forwarding it', async () => {
    // Assembled at runtime so no credential-shaped literal sits in source;
    // the validator still sees the same secret-shaped value.
    const fakeSource = 'sk-' + 'ant-' + 'oat01-' + 'abcdefghij';
    const readers = {
      agy: () => ({ used: 10, limit: 100, unit: 'percent', resetsAt: null, source: fakeSource, asOf: new Date(NOW).toISOString(), extra: 'token-value' }) as unknown as UsageResourceReading,
      local: () => ({ used: 'lots', limit: 100, unit: 'percent', resetsAt: null, source: 'x', asOf: 'now' }) as unknown as UsageResourceReading,
    };
    const snapshot = await readUsageResources({ ...quietDeps, readers });
    for (const id of ['agy', 'local'] as const) {
      const row = snapshot.resources.find((r) => r.id === id)!;
      expect(row.state).toBe('unavailable');
      expect(row.reason).toBe('invalid-reading');
      emptyRowChecks(row);
    }
    expect(JSON.stringify(snapshot)).not.toContain(fakeSource);
  });

  it('bounds a hung reader and reports reader-timeout', async () => {
    const readers = { stacksync: () => new Promise<UsageResourceReading | null>(() => {}) };
    const snapshot = await readUsageResources({ ...quietDeps, readers, deadlineMs: 10 });
    const row = snapshot.resources.find((r) => r.id === 'stacksync')!;
    expect(row.state).toBe('unavailable');
    expect(row.reason).toBe('reader-timeout');
    emptyRowChecks(row);
  });
});

describe('usageResourceReaders registry', () => {
  it('maps every resource; only the five uncovered pools are null', () => {
    const readers = usageResourceReaders(quietDeps);
    expect(Object.keys(readers).sort()).toEqual(USAGE_RESOURCES.map((r) => r.id).sort());
    expect(Object.entries(readers).filter(([, reader]) => reader === null).map(([id]) => id))
      .toEqual(['zai', 'agy', 'gemini-workspace', 'local', 'stacksync']);
  });
});

describe('handleUsageResourcesApi', () => {
  function cfg(): AshlrConfig {
    return { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
      models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {} } as AshlrConfig;
  }
  const ctx = (): VerseApiContext => ({ cfg: cfg(), token: 'fixture', allowDispatch: false });
  async function request(method = 'GET', query = '', path = USAGE_RESOURCES_PATH) {
    let status = 0; let body = '';
    const res = { writeHead(code: number) { status = code; }, end(v: string) { body = v; } } as unknown as ServerResponse;
    const handled = await handleUsageResourcesApi(ctx(), { url: path + query } as IncomingMessage, res, path, method);
    return { status, handled, body: body ? JSON.parse(body) : null };
  }

  it('forwards the server-injected route through the HTTP API', async () => {
    const snapshot = await readUsageResources(quietDeps);
    setUsageResourcesReadForTest(async () => snapshot);
    let status = 0;
    let body = '';
    const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse;
    try {
      expect(await handleApi({ url: USAGE_RESOURCES_PATH, method: 'GET' } as IncomingMessage,
        res, cfg(), { ...ctx(), usageResourcesApi: handleUsageResourcesApi })).toBe(true);
      expect(status).toBe(200);
      expect(JSON.parse(body)).toEqual(snapshot);
    } finally {
      setUsageResourcesReadForTest(null);
    }
  });

  it('rejects missing composition and unknown children without invoking the reader', async () => {
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
    const req = { url: USAGE_RESOURCES_PATH } as IncomingMessage;
    expect(await handleVerseApi(ctx(), req, res, USAGE_RESOURCES_PATH, 'GET')).toBe(true);
    expect(status).toBe(503);
    const handler = vi.fn(handleUsageResourcesApi);
    expect(await handleVerseApi({ ...ctx(), usageResourcesApi: handler }, req, res,
      USAGE_RESOURCES_PATH + '/extra', 'GET')).toBe(true);
    expect(status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it('serves the aggregate on GET and rejects everything else', async () => {
    const snapshot: UsageResourcesSnapshot = { v: 1, generatedAt: new Date(NOW).toISOString(),
      resources: USAGE_RESOURCES.map(({ id, label }) => ({ id, label, state: 'no-reader', used: null,
        limit: null, unit: null, resetsAt: null, source: null, asOf: null, reason: null })) };
    setUsageResourcesReadForTest(async () => snapshot);
    try {
      const ok = await request();
      expect(ok.handled).toBe(true);
      expect(ok.status).toBe(200);
      expect(ok.body.resources).toHaveLength(12);
      expect((await request('POST')).status).toBe(404);
      expect((await request('GET', '?pool=zai')).status).toBe(400);
      expect((await request('GET', '', '/api/verse/usage-resources/extra')).handled).toBe(false);
    } finally {
      setUsageResourcesReadForTest(null);
    }
  });
});
