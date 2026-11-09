import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ftruncateSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { collectHopEvents, hopEventsPath, MAX_HOP_EVENT_BYTES, parseHopEvent } from '../src/core/observability/hop-events.js';
import { buildHopRollup, buildRollup, buildRollupAsync } from '../src/core/observability/rollup.js';
import { cmdPulse } from '../src/cli/pulse.js';
import { loadIndex } from '../src/core/index-engine.js';

vi.mock('../src/core/observability/usage-source.js', () => ({ collectUsageEvents: vi.fn(() => []), dashNormalize: (path: string) => path }));
vi.mock('../src/core/index-engine.js', () => ({ loadIndex: vi.fn(() => null) }));
vi.mock('../src/core/observability/forecast.js', () => ({ buildForecast: vi.fn(() => null) }));
vi.mock('../src/core/observability/governance.js', () => ({ evalGovernance: vi.fn(() => null) }));
vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(), loadConfig: () => config,
}));

const config: AshlrConfig = {
  version: 1, roots: [], editor: 'vscode', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
};
const interval = { sinceMs: Date.parse('2026-10-24T00:00:00.000Z'), untilMs: Date.parse('2026-10-26T00:00:00.000Z') };
const fixture = readFileSync(new URL('./fixtures/hop-events.jsonl', import.meta.url), 'utf8');
const events: unknown[] = fixture.trim().split('\n').map((line) => JSON.parse(line) as unknown);
const hop = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id: 'hop', ts: '2026-10-25T10:00:00.000Z', repo: 'example/phantom',
  kind: 'hop.completed', tokensIn: 100, tokensOut: 50, costUsd: 2, ...overrides,
});
const merge = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id: 'merge', ts: '2026-10-25T14:00:00.000Z', repo: 'example/phantom',
  kind: 'pr.merged', prNumber: 7, ...overrides,
});

let testHome: string;
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'phantom-hop-rollup-'));
  vi.stubEnv('HOME', testHome);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(loadIndex).mockReturnValue(null);
  vi.unstubAllEnvs();
  rmSync(testHome, { recursive: true, force: true });
});
function journal(contents: string): void {
  mkdirSync(dirname(hopEventsPath()), { recursive: true });
  writeFileSync(hopEventsPath(), contents);
}

describe('hop interval efficiency', () => {
  it('rolls up fixture usage, failed work and explicit merges without double counting', () => {
    const rollup = buildHopRollup(events, interval);
    expect(rollup.status).toBe('complete');
    expect(rollup.totals).toEqual({
      hops: 4, mergedPrs: 3, tokens: 2000, costUsd: 10, hopsWithTokens: 4, hopsWithCost: 4,
      tokensPerMergedPr: 2000 / 3, mergedPrsPerDollar: 0.3,
    });
    expect(rollup.diagnostics).toEqual({ invalidEvents: 0, conflictingEvents: 0, duplicateEvents: 2, excludedEvents: 2 });
    expect(rollup.byRepo.map((repo) => repo.repo)).toEqual(['example/other', 'example/phantom']);
    expect(rollup.byRepo[1]).toMatchObject({ tokens: 1000, costUsd: 6, mergedPrs: 2, tokensPerMergedPr: 500, mergedPrsPerDollar: 1 / 3 });
  });

  it.each(['phantom', 'EXAMPLE/PHANTOM', ' example/phantom '])('filters canonical repo/name: %s', (project) => {
    expect(buildHopRollup(events, { ...interval, project }).totals).toMatchObject({ hops: 3, tokens: 1000, costUsd: 6, mergedPrs: 2 });
  });

  it('uses exact names rather than substring matches', () => {
    expect(buildHopRollup(events, { ...interval, project: 'phant' }).status).toBe('empty');
  });

  it('includes both boundaries and excludes older/future events', () => {
    const result = buildHopRollup([
      hop({ ts: new Date(interval.sinceMs).toISOString() }), merge({ ts: new Date(interval.untilMs).toISOString() }),
      hop({ id: 'past', ts: new Date(interval.sinceMs - 1).toISOString() }),
      merge({ id: 'future', prNumber: 8, ts: new Date(interval.untilMs + 1).toISOString() }),
    ], interval);
    expect(result.totals).toMatchObject({ hops: 1, mergedPrs: 1, tokensPerMergedPr: 150 });
    expect(result.diagnostics.excludedEvents).toBe(2);
  });

  it('never credits a replay of a merge from a previous interval', () => {
    const rows = [hop(), merge({ ts: '2026-10-23T10:00:00.000Z' }), merge({ id: 'replay' })];
    expect(buildHopRollup(rows, interval).totals.mergedPrs).toBe(0);
    expect(buildHopRollup([...rows].reverse(), interval)).toEqual(buildHopRollup(rows, interval));
  });

  it('excludes conflicting event ids independent of input order and marks ratios unknown', () => {
    const rows = [hop(), hop(), hop({ costUsd: 4 }), hop({ costUsd: 4 }), merge()];
    const result = buildHopRollup(rows, interval);
    expect(result).toEqual(buildHopRollup([...rows].reverse(), interval));
    expect(result).toMatchObject({ status: 'partial', diagnostics: { conflictingEvents: 1, duplicateEvents: 2 }, totals: { hops: 0, tokensPerMergedPr: null, mergedPrsPerDollar: null } });
  });

  it('keeps unknown token and cost coverage separate', () => {
    const result = buildHopRollup([hop({ costUsd: null }), hop({ id: 'unknown-tokens', tokensOut: null }), merge()], interval);
    expect(result).toMatchObject({ status: 'partial', totals: { hops: 2, tokens: 150, costUsd: 2, hopsWithTokens: 1, hopsWithCost: 1, tokensPerMergedPr: null, mergedPrsPerDollar: null } });
  });

  it('can compute token efficiency when dollars are unknown', () => {
    expect(buildHopRollup([hop({ costUsd: undefined }), merge()], interval).totals).toMatchObject({ tokensPerMergedPr: 150, mergedPrsPerDollar: null });
  });

  it('can compute dollar efficiency when tokens are unknown', () => {
    expect(buildHopRollup([hop({ tokensIn: undefined }), merge()], interval).totals).toMatchObject({ tokensPerMergedPr: null, mergedPrsPerDollar: 0.5 });
  });

  it('returns null for zero denominators and measured zero tokens for zero-token work', () => {
    expect(buildHopRollup([hop({ tokensIn: 0, tokensOut: 0, costUsd: 0 }), merge()], interval).totals).toMatchObject({ tokensPerMergedPr: 0, mergedPrsPerDollar: null });
    expect(buildHopRollup([hop()], interval).totals).toMatchObject({ tokensPerMergedPr: null, mergedPrsPerDollar: 0 });
    expect(buildHopRollup([merge()], interval)).toMatchObject({ status: 'partial', totals: { tokensPerMergedPr: null, mergedPrsPerDollar: null } });
    expect(buildHopRollup([], interval)).toMatchObject({ status: 'empty', totals: { tokensPerMergedPr: null, mergedPrsPerDollar: null } });
  });

  it.each(['missing', 'unavailable'] as const)('preserves %s input state', (sourceState) => {
    expect(buildHopRollup([], { ...interval, sourceState })).toMatchObject({ sourceState, status: sourceState, totals: { tokensPerMergedPr: null, mergedPrsPerDollar: null } });
  });

  it.each([
    { tokensIn: -1 }, { tokensOut: 0.5 }, { costUsd: -1 }, { costUsd: Infinity }, { tokensIn: NaN },
    { schemaVersion: 2 }, { ts: 'yesterday' }, { ts: '2026-02-30T10:00:00.000Z' }, { ts: '2026-10-25' },
    { id: '' }, { repo: '/private/repo' }, { kind: 'task.done' },
  ])('rejects invalid evidence %j', (bad) => {
    const result = buildHopRollup([hop(bad), hop({ id: 'valid' }), merge()], interval);
    expect(result).toMatchObject({ status: 'partial', diagnostics: { invalidEvents: 1 }, totals: { hops: 1, mergedPrsPerDollar: null, tokensPerMergedPr: null } });
  });

  it.each([0, -1, 1.5, '7'])('requires a positive integer PR number: %s', (prNumber) => {
    expect(parseHopEvent(merge({ prNumber }))).toBeNull();
  });

  it('keeps overflow and extreme ratios JSON-safe', () => {
    const rollup = buildHopRollup([hop({ tokensIn: Number.MAX_SAFE_INTEGER, tokensOut: 1, costUsd: Number.MIN_VALUE }), merge()], interval);
    expect(rollup).toMatchObject({ status: 'partial', totals: { tokens: null, tokensPerMergedPr: null, mergedPrsPerDollar: null } });
    expect(JSON.parse(JSON.stringify(rollup))).toEqual(rollup);
    expect(buildHopRollup([hop({ costUsd: Number.MAX_VALUE }), hop({ id: 'second', costUsd: Number.MAX_VALUE }), merge()], interval).totals.costUsd).toBeNull();
  });

  it('does not project arbitrary event payloads or identifiers into dashboard JSON', () => {
    const json = JSON.stringify(buildHopRollup([hop({ prompt: 'PRIVATE_CONTENT', id: 'PRIVATE_ID' }), merge()], interval));
    expect(json).not.toContain('PRIVATE_');
    expect(JSON.parse(json)).toHaveProperty('schemaVersion', 1);
  });

  it('rejects invalid intervals', () => {
    expect(() => buildHopRollup([], { sinceMs: 1, untilMs: 0 })).toThrow(RangeError);
    expect(() => buildHopRollup([], { sinceMs: NaN, untilMs: 0 })).toThrow(RangeError);
    expect(() => buildHopRollup([], { sinceMs: 0, untilMs: Number.MAX_VALUE })).toThrow(RangeError);
  });
});

describe('local hop journal and JSON surfaces', () => {
  it('distinguishes a missing journal, an empty journal and unreadable input', () => {
    expect(collectHopEvents()).toEqual({ state: 'missing', events: [] });
    journal('');
    expect(collectHopEvents()).toEqual({ state: 'available', events: [] });
    rmSync(hopEventsPath());
    mkdirSync(hopEventsPath());
    expect(collectHopEvents()).toEqual({ state: 'unavailable', events: [] });
  });

  it('reads fixture rows and preserves malformed evidence as partial', () => {
    journal(fixture + '\n{broken\n');
    const source = collectHopEvents();
    expect(source.state).toBe('available');
    expect(buildHopRollup(source.events, interval)).toMatchObject({ status: 'partial', diagnostics: { invalidEvents: 1 }, totals: { hops: 4, tokensPerMergedPr: null } });
  });

  it('refuses an oversized journal rather than silently truncating the denominator', () => {
    journal('');
    const fd = openSync(hopEventsPath(), 'w');
    try { ftruncateSync(fd, MAX_HOP_EVENT_BYTES + 1); } finally { closeSync(fd); }
    expect(collectHopEvents()).toEqual({ state: 'unavailable', events: [] });
  });

  it('resolves the journal against the current isolated home on every call', () => {
    journal(fixture);
    expect(collectHopEvents().events).toHaveLength(events.length);
    vi.stubEnv('HOME', join(testHome, 'another-home'));
    expect(collectHopEvents().state).toBe('missing');
  });

  it('includes fixture efficiency in sync/async activity JSON without inflating usage totals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(interval.untilMs);
    journal(fixture);
    const sync = buildRollup('1d', config);
    expect(sync.hopEfficiency?.totals).toMatchObject({ tokens: 2000, mergedPrs: 3, mergedPrsPerDollar: 0.3 });
    expect(sync.totals).toMatchObject({ tokensIn: 0, tokensOut: 0, estCostUsd: 0 });
    expect((await buildRollupAsync('1d', config)).hopEfficiency).toEqual(sync.hopEfficiency);
    expect(buildRollup('1d', config, { project: 'phantom' }).hopEfficiency?.totals.tokens).toBe(1000);
  });

  it('emits the real fixture rollup through pulse --json', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(interval.untilMs);
    journal(fixture);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdPulse(['--json', '--window', '1d'])).toBe(0);
    const json = JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join('')) as { hopEfficiency: { totals: unknown } };
    expect(json.hopEfficiency.totals).toMatchObject({ tokens: 2000, mergedPrs: 3, tokensPerMergedPr: 2000 / 3, mergedPrsPerDollar: 0.3 });
  });

  it('maps an indexed project path to its canonical origin instead of its checkout name', () => {
    vi.useFakeTimers();
    vi.setSystemTime(interval.untilMs);
    journal(fixture);
    const projectPath = join(testHome, 'renamed-checkout');
    vi.mocked(loadIndex).mockReturnValue({
      version: 1, generatedAt: new Date().toISOString(), root: testHome,
      items: [{ id: 'repo', name: 'renamed-checkout', path: projectPath, kind: 'repo', category: null,
        description: null, org: 'example', remote: 'git@github.com:example/phantom.git', language: null,
        lastModified: new Date().toISOString(), active: true }],
    });
    expect(buildRollup('1d', config, { project: projectPath }).hopEfficiency?.totals).toMatchObject({ tokens: 1000, mergedPrs: 2 });
  });
});
