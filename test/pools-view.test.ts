/** Fixture tests for pools.v1 (`phm pools`): synthetic ledger rows, temp runs dir, no real home. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPools } from '../src/cli/pools.js';
import { handleApi } from '../src/core/web/api.js';
import { buildPoolsView, formatPoolsText, POOLS_PATH, POOLS_STALE_AFTER_MINUTES, wasteLevel } from '../src/core/fleet/pools-view.js';
import { readResourceLedger, type ResourceLaneRow, type ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow> = {}, asOfHours: number | null = -0.1): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  ...(asOfHours === null ? {} : { observation: { source: 'claude-native-usage' as const, asOf: at(asOfHours) } }), ...patch,
});
const ledger = (...lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: at(0), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
});
const one = (row: ResourceLaneRow) => buildPoolsView(ledger(row), NOW).pools[0]!;

const FIXTURE = [
  lane('missing', { usedPct: null }),
  lane('on-pace', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }),
  lane('stale', { usedPct: 10, resetAt: at(2) }, -2),
  lane('behind-later', { usedPct: 20, resetAt: at(48), burnPctPerHour: 0.5 }),
  lane('expired', { usedPct: 90, resetAt: at(-3) }),
  lane('behind-sooner', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 }),
  lane('average', { usedPct: 40, resetAt: at(84) }),
  lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 120, resetAt: null }),
];

describe('buildPoolsView', () => {
  it('reports an on-pace pool with every field measured', () => {
    expect(one(FIXTURE[1]!)).toEqual({
      id: 'on-pace', kind: 'subscription', usedPct: 60, resetAt: at(60), hoursLeft: 60, elapsedPct: 64.3, burnPctPerHour: 0.7,
      burnBasis: 'reported', projectedUnusedPct: 0, wasteRisk: 'low', creditsRemaining: null, held: false, asOf: at(-0.1), reason: null, summary: 'on pace',
    });
  });

  it('says how much a behind pool would leave unused', () => {
    expect(one(FIXTURE[5]!)).toMatchObject({ projectedUnusedPct: 68, wasteRisk: 'high', summary: 'behind: 68% would go unused', reason: null });
  });

  it('falls back to the window average when the ledger reports no burn, and says so', () => {
    expect(one(FIXTURE[6]!)).toMatchObject({ burnPctPerHour: 0.48, burnBasis: 'window-average', projectedUnusedPct: 20, wasteRisk: 'medium', summary: 'behind: 20% would go unused' });
  });

  it('treats a held lane as spending nothing', () => {
    expect(one(lane('held', { held: true, usedPct: 30, burnPctPerHour: 2 }))).toMatchObject({ burnPctPerHour: 0, burnBasis: 'held', projectedUnusedPct: 70, wasteRisk: 'high', summary: 'behind: 70% would go unused (lane is held)' });
    expect(one(lane('spent', { held: true, usedPct: 100 }))).toMatchObject({ wasteRisk: 'low', summary: 'fully used' });
  });

  it('shows an expired window as unknown, never as the old percentage', () => {
    expect(one(FIXTURE[4]!)).toMatchObject({ usedPct: null, hoursLeft: null, projectedUnusedPct: null, wasteRisk: 'unknown',
      reason: `window reset at ${at(-3)}; no reading for the new window`, summary: `unknown: window reset at ${at(-3)}; no reading for the new window` });
  });

  it('shows a stale reading as unknown with the time of the last reading', () => {
    expect(one(FIXTURE[2]!)).toMatchObject({ usedPct: null, wasteRisk: 'unknown', asOf: at(-2), summary: `unknown: no reading since ${at(-2)}` });
    const edge = -POOLS_STALE_AFTER_MINUTES / 60;
    expect(one(lane('edge', {}, edge)).wasteRisk).not.toBe('unknown');
  });

  it('shows missing readings, capture times, reset times and percentages as unknown with a reason', () => {
    expect(one(FIXTURE[0]!)).toMatchObject({ usedPct: null, projectedUnusedPct: null, wasteRisk: 'unknown', reason: 'no reading' });
    expect(one(lane('untimed', {}, null))).toMatchObject({ usedPct: null, asOf: null, reason: 'reading has no capture time' });
    expect(one(lane('future', {}, 1))).toMatchObject({ usedPct: null, reason: `reading is dated in the future (${at(1)})` });
    expect(one(lane('no-reset', { resetAt: null }))).toMatchObject({ usedPct: 50, hoursLeft: null, wasteRisk: 'unknown', reason: 'reset time not reported' });
    expect(one(FIXTURE[7]!)).toMatchObject({ kind: 'credits', usedPct: null, creditsRemaining: 120, wasteRisk: 'unknown' });
    expect(one(lane('local', { window: 'none', usedPct: null, resetAt: null }))).toMatchObject({ kind: 'unmetered', reason: 'no usage window reported' });
    for (const row of buildPoolsView(ledger(...FIXTURE), NOW).pools) {
      if (row.wasteRisk === 'unknown') expect(row.projectedUnusedPct).toBeNull();
      expect(row.summary.startsWith('unknown: ')).toBe(row.wasteRisk === 'unknown');
    }
  });

  it('prefers the measured capture time and falls back to the status one', () => {
    const measurement = { lane: 'q', window: 'weekly' as const, usedPct: 50, resetAt: at(84), source: null };
    const evidence = { state: 'unknown' as const, reason: 'status-quota' as const, holdConflict: null, maxAgeMs: 300_000 };
    expect(one(lane('q', { quotaEvidence: { ...evidence, statusQuota: { ...measurement, observedAt: at(-0.5) }, measuredQuota: null } }, null)).asOf).toBe(at(-0.5));
    expect(one(lane('q', { quotaEvidence: { ...evidence, statusQuota: { ...measurement, observedAt: at(-9) }, measuredQuota: { ...measurement, observedAt: at(-0.2) } } }, null)).asOf).toBe(at(-0.2));
  });

  it('sorts by waste risk, then soonest reset, in a stable JSON order', () => {
    const view = buildPoolsView(ledger(...FIXTURE), NOW);
    expect(view.pools.map(row => [row.id, row.wasteRisk])).toEqual([
      ['behind-sooner', 'high'], ['behind-later', 'high'], ['average', 'medium'], ['on-pace', 'low'],
      ['expired', 'unknown'], ['stale', 'unknown'], ['missing', 'unknown'], ['devin', 'unknown'],
    ]);
    expect(JSON.stringify(buildPoolsView(ledger(...[...FIXTURE].reverse()), NOW))).toBe(JSON.stringify(view));
    expect(Object.keys(view)).toEqual(['schema', 'generatedAt', 'staleAfterMinutes', 'pools', 'gaps']);
    expect(Object.keys(view.pools[4]!)).toEqual(Object.keys(view.pools[0]!));
    expect(view).toMatchObject({ schema: 'pools.v1', generatedAt: at(0), staleAfterMinutes: 60 });
  });

  it('names what it cannot see', () => {
    const missing = { ...ledger(), sources: { status: 'missing' as const, apiSpend: 'missing' as const, jobs: 'missing' as const } };
    expect(buildPoolsView(missing, NOW).gaps).toEqual([expect.stringContaining('dispatcher status is missing'), expect.stringContaining('cloud credits')]);
    expect(buildPoolsView(ledger(), NOW).gaps).toHaveLength(1);
  });

  it('keeps one waste threshold', () => {
    expect([0, 14.9, 15, 49.9, 50, 100].map(wasteLevel)).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high']);
  });

  it('prints the same rows in the same order as text', () => {
    const text = formatPoolsText(buildPoolsView(ledger(...FIXTURE), NOW)).split('\n');
    expect(text[0]).toBe(`Pools as of ${at(0)} (most at risk of waste first)`);
    expect(text[1]).toBe('behind-sooner: behind: 68% would go unused');
    expect(text[2]).toBe(`  risk high; used 20%; resets ${at(24)} (24h left); burn 0.5%/h (reported); unused at reset 68%; as of ${at(-0.1)}`);
    expect(text).toContain('missing: unknown: no reading');
    expect(text).toContain(`  risk unknown; used unknown; resets ${at(84)} (unknown left); burn unknown; unused at reset unknown; as of ${at(-0.1)}`);
    expect(formatPoolsText(buildPoolsView(ledger(), NOW))).toContain('No resources reported.');
  });
});

describe('pools over a runs directory', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('derives rows from the dispatcher status the ledger already reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pools-view-')); dirs.push(root);
    mkdirSync(join(root, 'queue'));
    writeFileSync(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at(0),
      lanes: { 'codex-cmp': { running: 2, target: 4, held: false }, devin: { running: 0, target: 0, held: true } },
      budget: { 'codex-cmp': { weekly_used_pct: 20, reset_at: at(24), burn_pct_per_hour: 0.5, observed_at: at(-0.2) } } }));
    const view = buildPoolsView(await readResourceLedger({ runsDir: root, now: () => NOW, personalCodexHome: join(root, 'no-codex') }), NOW);
    expect(view.pools.map(row => [row.id, row.wasteRisk, row.asOf])).toEqual([['codex-cmp', 'high', at(-0.2)], ['devin', 'unknown', null]]);
  });

  it('prints JSON by default, text on request, and rejects other flags', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdPools([])).toBe(0);
    const json = JSON.parse(String(out.mock.calls[0]![0]));
    expect(json).toMatchObject({ schema: 'pools.v1', pools: [] });
    expect(json.gaps[0]).toContain('dispatcher status is missing');
    expect(await cmdPools(['--text'])).toBe(0);
    expect(String(out.mock.calls[1]![0])).toMatch(/^Pools as of .*\nNo resources reported\./);
    expect(await cmdPools(['--help'])).toBe(0);
    expect(String(out.mock.calls[2]![0])).toContain('Usage: phm pools [--text]');
    expect(await cmdPools(['--watch'])).toBe(2);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('serves the same view over GET /api/app/pools and refuses writes', async () => {
    const call = async (method: string) => {
      let body = '';
      const writeHead = vi.fn();
      const res = { writeHead, setHeader: vi.fn(), end: vi.fn((chunk?: string) => { body = chunk ?? ''; }) } as unknown as ServerResponse;
      const handled = await handleApi({ url: POOLS_PATH, method, headers: {} } as IncomingMessage, res, {} as never, { token: 'test', allowDispatch: false });
      return { handled, status: writeHead.mock.calls[0]?.[0] as number, body: body ? JSON.parse(body) as Record<string, unknown> : null };
    };
    const read = await call('GET');
    expect(read).toMatchObject({ handled: true, status: 200, body: { schema: 'pools.v1', pools: [], staleAfterMinutes: 60 } });
    expect(await call('POST')).toMatchObject({ handled: true, status: 405 });
  });
});
