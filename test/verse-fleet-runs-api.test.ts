import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_PATH as PATH, VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
const TOKEN = 'fleet-test-token';
const NOW = Date.parse('2026-10-31T12:00:00Z');
const runs = { lastTick: new Date(NOW).toISOString(), paused: false, memFreePct: 40, diskFreeGb: 20, switches: ['on'], claudeLane: 'claude',
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: false, heldReason: null, tokensLastHour: 50, merged24h: 2, mergeRate24h: 0.5 }],
  publishesLastHour: [], events: [], drop: { pending: [{ lane: 'codex', file: 'job.md' }], done: 2 } };
function deps(over: Partial<FleetRunsApiDeps> = {}): FleetRunsApiDeps {
  return { now: () => NOW, readRunsDir: async () => runs,
    listWorkers: async () => ({ workers: [{ job: 'job', repo: 'ashlrai/phantom', lane: 'codex', tier: 'mid', ageSeconds: 3 }], leaders: [], orchestratorAgents: 2 }),
    readInbox: async () => [{ at: new Date(NOW).toISOString(), source: 'Mason', text: 'hello' }],
    appendInbox: async () => ({ ok: true }), codexPersonal: async () => ({ usedPct: 40, resetsAt: null, asOf: null }),
    mergedLastHour: async () => ({ count: 1, items: [{ repo: 'ashlrai/phantom', number: 42, title: 'Fix' }] }), ...over };
}
async function request(api: ReturnType<typeof createFleetRunsApi>, options: { path: string; method?: string; body?: unknown; token?: string; allowDispatch?: boolean; raw?: string }): Promise<{ handled: boolean; status: number; wire: Record<string, unknown> | null }> {
  const req = Readable.from(options.method === 'GET' || !options.method ? [] : [options.raw ?? JSON.stringify(options.body ?? {})]) as unknown as IncomingMessage;
  req.url = options.path;
  req.method = options.method ?? 'GET';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: options.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, options.path.split('?')[0]!, options.method ?? 'GET');
  return { handled, status, wire };
}

describe('fleet runs api', () => {
  it('mounts runs and live as separate families', () => {
    expect(workbenchFamilyFor(PATH)?.id).toBe('fleet-runs');
    expect(workbenchFamilyFor(INBOX)?.id).toBe('fleet-runs');
    expect(workbenchFamilyFor('/api/verse/fleet/live')?.id).toBe('fleet-live');
    expect(workbenchFamilyFor(PATH + 'extra')).toBeNull();
  });
  it('projects a healthy composite without extra fields', async () => {
    const { status, wire } = await request(createFleetRunsApi(deps({ readRunsDir: async () => ({ ...runs, cwd: '/private', prompt: 'private' }) })), { path: PATH });
    expect(status).toBe(200);
    expect(wire).toMatchObject({ v: 1, lanes: runs.lanes, drop: runs.drop, mergesLastHour: { count: 1 }, codexPersonal: { usedPct: 40 } });
    expect(Object.values(wire!.sources as object)).toEqual(Array(5).fill('healthy'));
    expect(JSON.stringify(wire)).not.toMatch(/cwd|prompt|private/);
  });
  it('rejects malformed nested rows and private paths without partially applying runs', async () => {
    for (const bad of [{ ...runs, lanes: [{ lane: 'codex' }] }, { ...runs, events: [{ at: 'now', kind: 'debug', text: '/Users/private/work' }] }]) {
      const { wire } = await request(createFleetRunsApi(deps({ readRunsDir: async () => bad })), { path: PATH });
      expect(wire).toMatchObject({ sources: { runsDir: 'degraded', workers: 'healthy' }, lanes: [], lastTick: null });
      expect(JSON.stringify(wire)).not.toContain('/Users/');
    }
  });
  const readers = [['readRunsDir', 'runsDir'], ['listWorkers', 'workers'], ['readInbox', 'inbox'], ['codexPersonal', 'codex'], ['mergedLastHour', 'merges']] as const;
  for (const [dep, source] of readers) {
    for (const mode of ['throw', 'shape', 'import'] as const) it(`${dep} isolates ${mode} failures`, async () => {
      const read = async () => {
        if (mode === 'shape') return { bad: true };
        throw mode === 'import' ? Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }) : new Error('bad reader');
      };
      const { wire } = await request(createFleetRunsApi(deps({ [dep]: read })), { path: PATH });
      const sources = wire!.sources as Record<string, string>;
      expect(sources[source]).toBe(mode === 'import' ? 'not-landed' : 'degraded');
      expect(Object.entries(sources).filter(([k]) => k !== source).map(([, v]) => v)).toEqual(Array(4).fill('healthy'));
    });
  }
  it('coalesces concurrent requests and expires the two second cache', async () => {
    let tick = NOW;
    const read = vi.fn(async () => runs);
    const api = createFleetRunsApi(deps({ now: () => tick, readRunsDir: read }));
    await Promise.all([request(api, { path: PATH }), request(api, { path: PATH })]);
    await request(api, { path: PATH });
    expect(read).toHaveBeenCalledTimes(1);
    tick += 2000;
    await request(api, { path: PATH });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('enforces dispatch and token gates before writing', async () => {
    const append = vi.fn(async () => ({ ok: true }));
    const api = createFleetRunsApi(deps({ appendInbox: append }));
    expect((await request(api, { path: INBOX, method: 'POST', allowDispatch: false })).status).toBe(404);
    expect([401, 403]).toContain((await request(api, { path: INBOX, method: 'POST', token: 'wrong' })).status);
    expect(append).not.toHaveBeenCalled();
  });
  for (const body of [{ text: 'hi', extra: 1 }, { text: ' ' }, { text: 'x'.repeat(6001) }, { text: 'hi', source: '/' }, [], { text: 2 }]) {
    it(`rejects invalid body ${JSON.stringify(body).slice(0, 40)}`, async () => {
      const append = vi.fn(async () => ({ ok: true }));
      expect((await request(createFleetRunsApi(deps({ appendInbox: append })), { path: INBOX, method: 'POST', body })).status).toBe(400);
      expect(append).not.toHaveBeenCalled();
    });
  }
  it('appends trimmed text and default source', async () => {
    const append = vi.fn(async () => ({ ok: true }));
    const result = await request(createFleetRunsApi(deps({ appendInbox: append })), { path: INBOX, method: 'POST', body: { text: ' hi ' } });
    expect(result).toMatchObject({ status: 201, wire: { ok: true, at: new Date(NOW).toISOString() } });
    expect(append).toHaveBeenCalledWith('hi', 'Phantom desktop');
  });
  it('reports refusal and unavailable appends honestly', async () => {
    for (const [appendInbox, status] of [
      [async () => ({ ok: false, reason: 'refused' }), 422],
      [async () => { throw Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }); }, 503],
      [async () => ({ nonsense: true }), 503],
    ] as const) {
      const result = await request(createFleetRunsApi(deps({ appendInbox })), { path: INBOX, method: 'POST', body: { text: 'hi' } });
      expect(result.status).toBe(status);
      expect(result.wire!.code).toBe(status === 422 ? 'INBOX_REFUSED' : 'INBOX_UNAVAILABLE');
    }
  });
});
