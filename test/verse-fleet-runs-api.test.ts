import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('serves the goal scorecard read-only, unknown when the runs dir is empty', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'goal-scorecard-'));
    const api = createFleetRunsApi(deps({ runsDir }));
    const { status, wire } = await request(api, { path: '/api/verse/fleet/runs/goal-scorecard' });
    expect(status).toBe(200);
    expect(wire).toMatchObject({ schema: 'fleet.goal-scorecard.v3', version: 3, generatedAt: new Date(NOW).toISOString() });
    const goals = (wire as unknown as { goals: { status: string; current: unknown }[] }).goals;
    expect(goals.length).toBe(6);
    expect(goals.every(g => g.status === 'unknown' && g.current === null)).toBe(true);
    expect((await request(api, { path: '/api/verse/fleet/runs/goal-scorecard', method: 'POST' })).status).toBe(405);
  });
  it('serves the inventory read-only: every kind, one kind with ?kind=, 400 for an unknown kind', async () => {
    const { buildInventory, INVENTORY_PATH } = await import('../src/core/fleet/inventory.js');
    const inventory = buildInventory({
      now: new Date(NOW), channels: null, plugins: null, skills: null, tools: null, registry: [], roster: ['claude'],
      connectors: [{ id: 'docs', kind: 'mcp-stdio', description: null, lanes: ['claude'], credentials: 1, availability: 'available' }],
    });
    const readInventory = vi.fn(async () => inventory);
    const api = createFleetRunsApi(deps({ readInventory }));
    const all = await request(api, { path: INVENTORY_PATH });
    expect(all.status).toBe(200);
    expect(all.wire).toEqual(JSON.parse(JSON.stringify(inventory)));
    expect(all.wire).toMatchObject({ schema: 'phantom.inventory.v1', version: 1, kind: null, parity: { compared: 1, widestGap: 0 } });
    const one = (await request(api, { path: `${INVENTORY_PATH}?kind=connectors` })).wire as unknown as typeof inventory;
    expect(one).toMatchObject({ kind: 'connector', counts: { ready: 1, unknown: 0 }, kinds: [{ kind: 'connector', total: 1 }] });
    expect(one.items.map(i => i.id)).toEqual(['connector:docs']);
    expect(one.parity).toEqual(inventory.parity);
    const bad = await request(api, { path: `${INVENTORY_PATH}?kind=secrets` });
    expect(bad.status).toBe(400);
    expect(bad.wire).toEqual({ code: 'INVENTORY_KIND', error: 'kind must be one of: channel, connector, plugin, skill, tool' });
    expect(readInventory).toHaveBeenCalledTimes(2);
    expect((await request(api, { path: INVENTORY_PATH, method: 'POST' })).status).toBe(405);
  });
  it('reads the real inventory sources by default and never throws on an empty machine', async () => {
    const { INVENTORY_PATH } = await import('../src/core/fleet/inventory.js');
    const runsDir = mkdtempSync(join(tmpdir(), 'inventory-'));
    const { status, wire } = await request(createFleetRunsApi(deps({ runsDir })), { path: `${INVENTORY_PATH}?kind=tool` });
    expect(status).toBe(200);
    expect(wire).toMatchObject({ schema: 'phantom.inventory.v1', kind: 'tool', at: new Date(NOW).toISOString() });
    // No lane-tools.json: only the router's built-in declarations are known, the rest stay unknown.
    const items = (wire as unknown as { items: { id: string; state: string }[] }).items;
    expect(items.find(i => i.id === 'tool:shell')).toMatchObject({ state: 'unknown' });
    // The router declares that claude workers have no gh, so no known lane has it.
    expect(items.find(i => i.id === 'tool:github-read')).toMatchObject({ state: 'needs setup' });
  });
  it('serves the Tools matrix read-only, one lane with ?lane=, 404 for an unknown lane', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'tools-matrix-'));
    const api = createFleetRunsApi(deps({ runsDir }));
    const all = await request(api, { path: '/api/verse/fleet/runs/tools' });
    expect(all.status).toBe(200);
    // No slots or lane-tools.json: only the router's built-in claude declaration is known.
    expect(all.wire).toMatchObject({ schema: 'tools.matrix.v1', parity: 'gaps', lanes: ['claude'] });
    expect((all.wire as unknown as { topGaps: { need: string }[] }).topGaps[0]!.need).toBe('github-read');
    expect((await request(api, { path: '/api/verse/fleet/runs/tools?lane=claude' })).wire).toMatchObject({ lanes: ['claude'] });
    expect((await request(api, { path: '/api/verse/fleet/runs/tools?lane=nope' })).status).toBe(404);
    expect((await request(api, { path: '/api/verse/fleet/runs/tools', method: 'POST' })).status).toBe(405);
  });
  it('serves tool parity read-only: every org lane by tool family, one lane with ?lane=, 404 for an unknown lane', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'tools-parity-'));
    mkdirSync(join(runsDir, 'queue'));
    writeFileSync(join(runsDir, 'queue', 'lane-tools.json'), JSON.stringify({ v: 1, lanes: { claude: { mcp: ['docs'], browser: true }, 'codex-local': { mcp: [] } } }));
    const api = createFleetRunsApi(deps({ runsDir }));
    const all = await request(api, { path: '/api/verse/fleet/runs/tools/parity' });
    expect(all.status).toBe(200);
    const wire = all.wire as unknown as import('../src/core/fleet/tool-parity.js').LaneParityMatrix;
    expect(wire).toMatchObject({ schema: 'tools.parity.v2', version: 2, parity: 'gaps', counts: { present: 2, missing: 2, unknown: 76 } });
    expect(wire.families.map(f => f.id)).toEqual(['mcp', 'cli', 'skills', 'plugins', 'web-search', 'browser', 'computer-use', 'gh']);
    expect(wire.lanes.map(l => l.lane)).toEqual(['codex-personal', 'claude', 'claude-api', 'devin', 'devin-flash', 'codex-local', 'zai', 'gemini', 'grok', 'cursor']);
    const one = (await request(api, { path: '/api/verse/fleet/runs/tools/parity?lane=codex-local' })).wire as unknown as typeof wire;
    expect(one.lanes.map(l => l.lane)).toEqual(['codex-local']);
    expect(one.lanes[0]!.cells.mcp).toEqual({
      state: 'missing', source: 'lane-tools.json', has: [], lacks: ['docs'],
      fix: 'Give codex-local MCP server docs, then add "mcp": ["docs"] under "codex-local" in <runs>/queue/lane-tools.json.',
    });
    expect((await request(api, { path: '/api/verse/fleet/runs/tools/parity?lane=nope' })).status).toBe(404);
    expect((await request(api, { path: '/api/verse/fleet/runs/tools/parity', method: 'POST' })).status).toBe(405);
  });
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
  it('projects claims without forwarding other fields and rejects malformed claims', async () => {
    const claim = { job: 'RQ-PHX-QUEUE', lane: 'codex-personal', tier: 'mid', at: new Date(NOW).toISOString() };
    const good = await request(createFleetRunsApi(deps({ readRunsDir: async () => ({ ...runs, claimed: [{ ...claim, prompt: 'private' }] }) })), { path: PATH });
    expect(good.wire).toMatchObject({ claimed: [claim], sources: { runsDir: 'healthy' } });
    expect(JSON.stringify(good.wire)).not.toContain('private');
    const bad = await request(createFleetRunsApi(deps({ readRunsDir: async () => ({ ...runs, claimed: [{ ...claim, job: '/Users/private' }] }) })), { path: PATH });
    expect(bad.wire).toMatchObject({ sources: { runsDir: 'degraded' }, lanes: [] });
  });
  it('carries the not actually running list, empty for older readers, and rejects malformed rows', async () => {
    const row = { job_or_lane: 'grok-one', kind: 'held_launch', reason: 'ultra reading older than 8h', since: null, unblock: 'Record a current Grok usage percent' };
    const good = await request(createFleetRunsApi(deps({ readRunsDir: async () => ({ ...runs, notRunning: [{ ...row, prompt: 'private' }] }) })), { path: PATH });
    expect(good.wire).toMatchObject({ notRunning: [row], sources: { runsDir: 'healthy' } });
    expect(JSON.stringify(good.wire)).not.toContain('private');
    expect((await request(createFleetRunsApi(deps()), { path: PATH })).wire).toMatchObject({ notRunning: [], sources: { runsDir: 'healthy' } });
    const bad = await request(createFleetRunsApi(deps({ readRunsDir: async () => ({ ...runs, notRunning: [{ ...row, unblock: 7 }] }) })), { path: PATH });
    expect(bad.wire).toMatchObject({ sources: { runsDir: 'degraded' }, lanes: [] });
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

describe('drift route (Home Running build line)', () => {
  const DRIFT = '/api/verse/fleet/runs/drift';
  const report = { schema: 'phantom.self-drift.v1', version: 1, behindReleases: 2, line: '2 releases behind, 0 fleet features not live yet' };
  it('serves the phm self drift report, reads at most once per 10 minutes, retries after a failure and is GET only', async () => {
    let tick = NOW;
    const read = vi.fn().mockRejectedValueOnce(new Error('/private/path')).mockResolvedValue(report);
    const api = createFleetRunsApi(deps({ now: () => tick, readDrift: read }));
    expect(await request(api, { path: DRIFT })).toMatchObject({ status: 503, wire: { code: 'DRIFT_UNAVAILABLE' } });
    expect(await request(api, { path: DRIFT })).toMatchObject({ handled: true, status: 200, wire: report });
    tick += 300_000;
    await request(api, { path: DRIFT });
    expect(read).toHaveBeenCalledTimes(2);
    tick += 301_000;
    await request(api, { path: DRIFT });
    expect(read).toHaveBeenCalledTimes(3);
    expect((await request(api, { path: DRIFT, method: 'POST', body: {} })).status).toBe(405);
  });
});

describe('worktrees route (Home Disk card)', () => {
  const WORKTREES = '/api/verse/fleet/runs/worktrees';
  const report = { schema: 'worktrees.v1', counts: { total: 3, safe: 1 }, rows: [] };
  it('serves the phm worktrees report, reads at most once a minute and is GET only', async () => {
    let tick = NOW;
    const read = vi.fn(async () => report as never);
    const api = createFleetRunsApi(deps({ now: () => tick, readWorktrees: read }));
    expect(await request(api, { path: WORKTREES })).toMatchObject({ handled: true, status: 200, wire: report });
    tick += 30_000;
    await request(api, { path: WORKTREES });
    expect(read).toHaveBeenCalledTimes(1);
    tick += 61_000;
    await request(api, { path: WORKTREES });
    expect(read).toHaveBeenCalledTimes(2);
    expect((await request(api, { path: WORKTREES, method: 'POST', body: {} })).status).toBe(405);
  });
  it('answers 503 with a fixed code when the read fails, then retries on the next call', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('/private/path')).mockResolvedValue(report);
    const api = createFleetRunsApi(deps({ readWorktrees: read }));
    expect(await request(api, { path: WORKTREES })).toMatchObject({ status: 503, wire: { code: 'WORKTREES_UNAVAILABLE' } });
    expect((await request(api, { path: WORKTREES })).status).toBe(200);
  });
});
