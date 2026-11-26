/** Fixture tests for pools.waste.v1 (`phm pools waste`): synthetic ledger rows, no real home. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdPools } from '../src/cli/pools.js';
import { buildPoolsView } from '../src/core/fleet/pools-view.js';
import { buildPoolsWaste, formatPoolsWasteText, wasteDigestLine, POOLS_WASTE_SCHEMA } from '../src/core/fleet/pools-waste.js';
import { buildQueueSupply } from '../src/core/fleet/queue-supply.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';

const NOW = Date.parse('2026-11-19T22:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(5),
  burnPctPerHour: 0.1, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(-0.1) }, ...patch,
});
const ledger = (...lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: at(0), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
});
const check = (rows: ResourceLaneRow[], ready: Record<string, number> | null, heldReasons: Record<string, string | null> = {}, openRows = 0) => {
  const view = buildPoolsView(ledger(...rows), NOW);
  return buildPoolsWaste({
    view,
    supply: ready === null ? null : buildQueueSupply({ view, readyByLane: ready, openRows, invalidRows: 0, startsByLane: { claude: 6 } }),
    heldReasons,
  });
};

describe('buildPoolsWaste', () => {
  it('names the one sign-in fix for a held pool with high waste risk, and it needs Mason', () => {
    const data = check([lane('gemini', { usedPct: 12, held: true })], {}, { gemini: 'needs sign-in' });
    expect(data.schema).toBe(POOLS_WASTE_SCHEMA);
    expect(data.top).toMatchObject({ pool: 'gemini', fix_kind: 'sign-in', needs_mason: true, waste_risk: 'high', projected_unused_pct: 88 });
    expect(data.top!.fix).toBe('sign in to Gemini once: run gemini in a terminal');
    expect(wasteDigestLine(data)).toBe('Gemini: 88% will go unused in 5 h. Sign in to Gemini once: run gemini in a terminal.');
  });

  it('says "lane held: <reason>" when the hold is not a sign-in, and asks no one', () => {
    const data = check([lane('zai', { usedPct: 10, held: true })], {}, { zai: 'host load' });
    expect(data.top).toMatchObject({ fix_kind: 'lane-held', fix: 'lane held: host load', needs_mason: false });
  });

  it('asks for more work when a pool is short of queued work', () => {
    const data = check([lane('claude', { usedPct: 40, burnPctPerHour: 6 })], { claude: 0 });
    expect(data.top).toMatchObject({ fix_kind: 'add-work', fix: 'queue more work for Claude', needs_mason: false });
    expect(data.top!.projected_unused_pct).toBeGreaterThanOrEqual(25);
    expect(data.top!.waste_risk).not.toBe('high');
  });

  it('still says to queue work when the queue could not be read', () => {
    expect(check([lane('claude', { usedPct: 40, burnPctPerHour: 6 })], null).top!.fix_kind).toBe('add-work');
  });

  it('flags a pool with plenty queued as a lane problem, not a queue problem', () => {
    const data = check([lane('claude', { usedPct: 40, burnPctPerHour: 6 })], { claude: 30 });
    expect(data.top).toMatchObject({ fix_kind: 'check-lane' });
  });

  it('counts lane-open rows as work the pool could take before asking for more', () => {
    // Nothing hinted to claude, but 30 lane-open rows the market may place there.
    const data = check([lane('claude', { usedPct: 40, burnPctPerHour: 6 })], {}, {}, 30);
    expect(data.top).toMatchObject({ fix_kind: 'check-lane' });
    expect(data.top!.fix).toContain('30 jobs queued');
  });

  it('raises no alert for a healthy pool', () => {
    const data = check([lane('claude', { usedPct: 70, burnPctPerHour: 5 })], { claude: 4 });
    expect(data).toMatchObject({ alerts: [], top: null, ok: ['claude'], unknown: [] });
    expect(wasteDigestLine(data)).toBeNull();
    expect(formatPoolsWasteText(data)).toContain('No pool is about to waste usage');
  });

  it('does not alert on a wasteful pool that resets more than 12 hours out', () => {
    expect(check([lane('gemini', { usedPct: 12, held: true, resetAt: at(30) })], {}).alerts).toEqual([]);
  });

  it('shows unknown usage as unknown, never as an alert or as healthy', () => {
    const data = check([lane('grok', { usedPct: null }), lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 9, resetAt: null })], {});
    expect(data.alerts).toEqual([]);
    expect(data.ok).toEqual([]);
    expect(data.unknown.map(u => u.pool).sort()).toEqual(['devin', 'grok']);
    expect(formatPoolsWasteText(data)).toContain('Grok: unknown (no reading)');
  });

  it('puts the largest projected waste on top', () => {
    const data = check([lane('claude', { usedPct: 40, burnPctPerHour: 6 }), lane('gemini', { usedPct: 12, held: true })], {});
    expect(data.alerts.map(a => a.pool)).toEqual(['gemini', 'claude']);
  });
});

describe('digest and Asks card', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'waste-')); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'NEEDS-MASON.md'), ''); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('puts the top alert in the hourly digest', () => {
    const lines = buildStatusDigest({
      installedVersion: { ok: true, value: '1' }, publishedVersion: { ok: true, value: '1' }, updatePending: false,
      mergesLastHour: { ok: true, value: 1 }, mergesLast24h: { ok: true, value: 2 }, lanes: { ok: true, value: [] },
      needsMason: { ok: true, value: 0 }, topP0: { ok: true, value: null }, wasteLine: 'Gemini: 88% will go unused in 5 h. Sign in to Gemini once: run gemini in a terminal.',
    });
    expect(lines[0]).toMatch(/^Gemini: 88% will go unused/);
  });
});

describe('phm pools waste', () => {
  it('rejects unknown flags and prints usage for --help', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdPools(['waste', '--bogus'])).toBe(2);
    expect(await cmdPools(['waste', '--help'])).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('phm pools waste [--json]');
    err.mockRestore(); log.mockRestore();
  });
});
