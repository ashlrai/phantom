import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anthropicCostSource } from '../src/core/fabric/readers/anthropic-cost.js';
import { ANTHROPIC_COST_WORKER } from '../src/core/fabric/readers/anthropic-cost-worker.js';
import { loadConfigAt } from '../src/core/config.js';
import { anthropicVersionHeaders } from '../src/core/run/model-catalog.js';
import { capacitySource } from '../src/core/usage/resource-live/capacity-source.js';
import { liveSourceOptions } from '../src/core/usage/resource-live/config.js';
import { defaultResourceLiveSources } from '../src/core/usage/resource-live/sources.js';
import { runResourceLiveTick } from '../src/core/usage/resource-live/engine.js';
import { projectResourceLiveFeed } from '../src/core/usage/resource-live/feed.js';
import { presentUsageSensors } from '../src/core/usage/sensor-reading.js';
import type { CapacitySnapshot } from '../src/core/routing/budget-store.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const observedAt = new Date(NOW - 60_000).toISOString();
const reset = '2026-11-20T12:00:00.000Z';
const credit = { adminKeyHandle: 'ANTHROPIC_ADMIN_KEY', creditUsd: 50, windowStart: '2026-11-16T00:00:00Z' };
const roots: string[] = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'usage-readers-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const seat = (seatId: string, engine: 'claude' | 'codex'): SeatCapacity => ({ seatId, engine, label: seatId, free: false,
  signedOut: false, reachable: true, contextWindow: null, observedAt, spentTodayUsd: null,
  windows: [{ id: engine === 'claude' ? 'seven_day' : 'codex_codex_primary', usedPercent: 25,
    resetsAt: reset, resetDescription: null, limitReached: false }] });
const snapshot = (...seats: SeatCapacity[]): CapacitySnapshot => ({ v: 1, publishedAt: new Date(NOW).toISOString(), seats });

describe('capacity snapshot rail source', () => {
  it('bridges fresh native seats into verified rail readings, retaining their original expiration', async () => {
    const claude = { ...seat('max-seat', 'claude'), staleAfter: new Date(NOW + 1000).toISOString() };
    const sources = defaultResourceLiveSources({ runsDir: scratch(), codexSeatMap: { personal: 'codex-personal' },
      readCapacity: () => snapshot(claude, seat('personal', 'codex'), seat('company', 'codex')),
      readClaudeQuota: async () => null, readClaudeEvent: () => null });
    const selected = Object.fromEntries(Object.entries(sources).map(([id, list]) => [id,
      ['claude-weekly', 'codex-personal'].includes(id) ? list : []])) as typeof sources;
    const { sidecar } = await runResourceLiveTick({ runsDir: scratch(), sources: selected, nowMs: NOW, activeLanes: () => new Set() });
    for (const id of ['claude-weekly', 'codex-personal']) {
      expect(sidecar.readings.find(r => r.id === id)).toMatchObject({ verified: true, used: 25, remaining: 75, confidence: 'high', observed_at: observedAt });
    }
    const rows = projectResourceLiveFeed(sidecar, NOW).readings;
    expect(rows).toHaveLength(2);
    expect(sidecar.readings.some(r => r.id === 'codex-cmp')).toBe(false);
    expect(rows.find(r => r.lane === 'claude-max')?.staleAfter).toBe(claude.staleAfter);
    expect(presentUsageSensors(rows, NOW + 1000).lanes.find(r => r.lane === 'claude-max')?.headroom).toBeNull();
  });
  it('refuses missing, ambiguous, signed-out, stale and null-window evidence without guessing identities', async () => {
    const good = seat('personal', 'codex');
    for (const seats of [[], [good, good], [{ ...good, signedOut: true }], [{ ...good, staleAfter: new Date(NOW).toISOString() }],
      [{ ...good, observedAt: new Date(NOW - 16 * 60_000).toISOString() }],
      [{ ...good, observedAt: new Date(NOW - 16 * 60_000).toISOString(), staleAfter: reset }],
      [{ ...good, observedAt: new Date(NOW + 1).toISOString() }],
      [{ ...good, windows: [{ ...good.windows[0]!, usedPercent: null }] }]]) {
      expect(await capacitySource('codex-personal', { personal: 'codex-personal' }, () => snapshot(...seats)).read(NOW)).toBeNull();
    }
    expect(await capacitySource('codex-personal', {}, () => snapshot(good)).read(NOW)).toBeNull();
    expect(await capacitySource('claude-weekly', {}, () => null).read(NOW)).toBeNull();
    const partial = { ...good, windows: [...good.windows, { ...good.windows[0]!, id: 'codex_codex_secondary', usedPercent: null }] };
    expect(await capacitySource('codex-personal', { personal: 'codex-personal' }, () => snapshot(partial)).read(NOW)).toMatchObject({ used: 25 });
  });
  it('does not replace a fresh direct Claude reading with the snapshot', async () => {
    const sources = defaultResourceLiveSources({ runsDir: scratch(), readCapacity: () => snapshot(seat('max', 'claude')),
      readClaudeQuota: async () => ({ v: 1, observedAt, reason: 'ok', fresh: true, windows: [{ id: 'seven_day', usedPct: 71, resetAt: reset }] }) });
    expect(await sources['claude-weekly'][0]!.read(NOW)).toMatchObject({ used: 71 });
  });
});

describe('custodied Anthropic cost reader', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/anthropic-cost-report.json', import.meta.url), 'utf8'));
  async function worker(pages: unknown[], status = 200, config = credit) {
    let output = '';
    const fetch = vi.fn(async (_url: URL, _options: unknown) => ({ ok: status === 200, text: async () => JSON.stringify(pages.shift()) }));
    await runInNewContext(ANTHROPIC_COST_WORKER, { process: { argv: ['node', JSON.stringify({ ...config, observedAt: new Date(NOW).toISOString() })], env: { ANTHROPIC_ADMIN_KEY: 'fixture-only' },
      stdout: { write: (s: string) => { output += s; } } }, fetch, URL, AbortSignal, Date: class extends Date { static now() { return NOW + 1000; } } });
    return { output, fetch };
  }
  it('requests the documented daily report, converts decimal cents and publishes only allowed fields', async () => {
    const { output, fetch } = await worker([structuredClone(fixture)]);
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toContain('/v1/organizations/cost_report?starting_at=');
    expect(url).toContain('bucket_width=1d');
    expect(new URL(url).searchParams.get('ending_at')).toBe('2026-11-17T00:00:00.000Z');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: anthropicVersionHeaders('anthropic') });
    const run = vi.fn(async () => output);
    expect(await anthropicCostSource(credit, run).read(NOW)).toEqual({ used: 1.2378912, limit: 50, unit: 'usd',
      reset_at: null, source: 'anthropic-admin-cost', observed_at: new Date(NOW).toISOString() });
    expect(output).not.toContain('fixture-only');
    expect(run).toHaveBeenCalledWith(NOW);
  });
  it('paginates and refuses incomplete pagination, bad amounts/currency and provider failures', async () => {
    const first = { ...structuredClone(fixture), has_more: true, next_page: 'next' };
    first.data[0].starting_at = '2026-11-15T00:00:00Z';
    first.data[0].ending_at = '2026-11-16T00:00:00Z';
    // A mismatched window is not attributed to the configured credit.
    expect((await worker([first, fixture])).output).toBe('null');
    const paged = await worker([first, fixture], 200, { ...credit, windowStart: first.data[0].starting_at });
    expect(JSON.parse(paged.output).used).toBeCloseTo(2.4757824);
    expect(String(paged.fetch.mock.calls[1]?.[0])).toContain('page=next');
    expect(JSON.parse((await worker([{ ...fixture, data: [{ ...fixture.data[0], results: [] }] }])).output).used).toBe(0);
    for (const bad of [{ ...fixture, has_more: true, next_page: null }, { ...fixture, data: [] },
      { ...fixture, data: [{ ...fixture.data[0], results: [{ amount: '-1', currency: 'USD' }] }] },
      { ...fixture, data: [{ ...fixture.data[0], results: [{ amount: '1', currency: 'EUR' }] }] }]) {
      expect((await worker([bad])).output).toBe('null');
    }
    expect((await worker([fixture], 401)).output).toBe('null');
    expect((await worker([fixture], 429)).output).toBe('null');
  });
  it('returns no reading on missing configuration, malformed/sensitive output, or runner failure', async () => {
    for (const text of ['null', 'not-json', '{"used":-1}', '{"used":0,"observed_at":"tomorrow"}']) {
      expect(await anthropicCostSource(credit, async () => text).read(NOW)).toBeNull();
    }
    const run = vi.fn(async () => { throw new Error('private diagnostics'); });
    expect(await anthropicCostSource({ ...credit, creditUsd: 0 }, run).read(NOW)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(await anthropicCostSource(credit, run).read(NOW)).toBeNull();
  });
});

describe('source config and operator fallback', () => {
  it('defaults off, includes only an opted-in stub and never fabricates its reading', async () => {
    const without = defaultResourceLiveSources({ runsDir: scratch() });
    const withStub = defaultResourceLiveSources({ runsDir: scratch(), operatorPageFallback: true });
    expect(without['claude-weekly'].filter(s => s.tier === 'visible-window')).toHaveLength(0);
    expect(withStub['claude-weekly'].filter(s => s.tier === 'visible-window')).toHaveLength(1);
    expect(await withStub['claude-weekly'].at(-1)!.read(NOW)).toBeNull();
  });
  it('validates persisted names-only settings and preserves env overrides', () => {
    const root = scratch();
    const liveSources = { anthropicCost: credit, codexSeatMap: { company: 'codex-cmp', personal: 'codex-personal' },
      codexCmpHome: '/fixture/company', codexPersonalHome: '/fixture/company', operatorPageFallback: true, accountsRoot: '/fixture/accounts' };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ usage: { liveSources } }));
    expect(loadConfigAt(root).usage?.liveSources).toEqual({ anthropicCost: credit, codexSeatMap: { personal: 'codex-personal' },
      operatorPageFallback: true, accountsRoot: '/fixture/accounts' });
    expect(liveSourceOptions(loadConfigAt(root), { PHANTOM_RESOURCE_LIVE_ACCOUNTS_ROOT: '/override' }).accountsRoot).toBe('/override');
    writeFileSync(join(root, 'config.json'), JSON.stringify({ usage: { liveSources: { anthropicCost: { ...credit, adminKeyHandle: 'not a handle' } } } }));
    expect(loadConfigAt(root).usage).toEqual({});
  });
});
