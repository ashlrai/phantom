import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetVitals, readFleetVitalsView, readHostVitals } from '../src/cli/fleet-vitals.js';
import { MEMORY_GUARD } from '../src/core/resources/lane-autopilot.js';
import {
  parseSwapoutSample, readSwapoutRateEvidence, syncSwapoutSamples,
  SWAPOUT_SAMPLE_SCHEMA, SWAPOUT_RATE_LEDGER_RELATIVE,
} from '../src/core/fleet/swapout-sync.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const TS_SECONDS = 1793589510;
const SAMPLED_AT = new Date(TS_SECONDS * 1000).toISOString();
const NOW = TS_SECONDS * 1000 + 30_000;
const MEMSTAT = { schema: 'ashlr.memstat.v1', ts: TS_SECONDS, free_pct: 58, swap_gb: 1.5, swapouts_total: 900, swapouts_per_min: 0.25, disk_gb: 601 };

async function fixture(memstat: unknown = MEMSTAT) {
  const root = await mkdtemp(join(tmpdir(), 'swapout-rate-')); roots.push(root);
  await mkdir(join(root, 'metrics'), { recursive: true });
  if (memstat !== null) await writeFile(join(root, 'memstat.json'), typeof memstat === 'string' ? memstat : JSON.stringify(memstat));
  return root;
}

const sampleRow = (over: Record<string, unknown> = {}) => ({
  schema: SWAPOUT_SAMPLE_SCHEMA, sampled_at: SAMPLED_AT, free_pct: 58, swap_gb: 1.5, swapouts_per_min: 0.25, ...over,
});

it('parses memstat samples across the producer timestamp dialects', () => {
  expect(parseSwapoutSample(MEMSTAT, NOW)).toEqual({ sampledAt: SAMPLED_AT, freePct: 58, swapGb: 1.5, swapoutsPerMin: 0.25 });
  expect(parseSwapoutSample({ ...MEMSTAT, ts: TS_SECONDS * 1000 }, NOW)?.sampledAt).toBe(SAMPLED_AT);
  expect(parseSwapoutSample({ ...MEMSTAT, ts: SAMPLED_AT }, NOW)?.sampledAt).toBe(SAMPLED_AT);
  // Per-field degradation mirrors memory-view: a bad figure nulls, never rejects the sample.
  expect(parseSwapoutSample({ ...MEMSTAT, free_pct: 140, swapouts_per_min: -2 }, NOW))
    .toEqual({ sampledAt: SAMPLED_AT, freePct: null, swapGb: 1.5, swapoutsPerMin: null });
});

it('rejects samples with no usable timestamp, no measurement, or a future date', () => {
  expect(parseSwapoutSample({ free_pct: 58 }, NOW)).toBeNull();
  expect(parseSwapoutSample({ ts: 'not a date', free_pct: 58 }, NOW)).toBeNull();
  expect(parseSwapoutSample({ ts: TS_SECONDS, free_pct: null, swap_gb: null, swapouts_per_min: null }, NOW)).toBeNull();
  expect(parseSwapoutSample({ ...MEMSTAT, ts: TS_SECONDS + 120 }, NOW)).toBeNull();
  // A stamp ahead of NOW but inside the skew allowance still records.
  expect(parseSwapoutSample({ ...MEMSTAT, ts: TS_SECONDS + 60 }, NOW)?.sampledAt)
    .toBe(new Date((TS_SECONDS + 60) * 1000).toISOString());
});

it('appends one ledger row per new sample and dedups by sampled_at', async () => {
  const root = await fixture();
  const first = await syncSwapoutSamples({ runsDir: root, now: () => NOW });
  expect(first).toMatchObject({ state: 'ok', memstatState: 'healthy', ledgerState: 'missing', sampledAt: SAMPLED_AT, appended: 1, duplicate: false });
  const ledger = join(root, SWAPOUT_RATE_LEDGER_RELATIVE);
  const lines = (await readFile(ledger, 'utf8')).trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual(sampleRow());
  // The same memstat.json on the next pass is already recorded.
  const second = await syncSwapoutSamples({ runsDir: root, now: () => NOW + 300_000 });
  expect(second).toMatchObject({ state: 'ok', appended: 0, duplicate: true });
  expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(1);
  // A newer bridge sample appends beside it.
  const newer = { ...MEMSTAT, ts: TS_SECONDS + 300, free_pct: 41, swapouts_per_min: 2 };
  await writeFile(join(root, 'memstat.json'), JSON.stringify(newer));
  const third = await syncSwapoutSamples({ runsDir: root, now: () => NOW + 600_000 });
  expect(third).toMatchObject({ state: 'ok', appended: 1, sampledAt: new Date((TS_SECONDS + 300) * 1000).toISOString() });
  expect((await readFile(ledger, 'utf8')).trim().split('\n')).toHaveLength(2);
});

it('reports no-sample for missing, degraded or measurement-free memstat.json', async () => {
  const root = await fixture(null);
  expect(await syncSwapoutSamples({ runsDir: root, now: () => NOW }))
    .toMatchObject({ state: 'no-sample', memstatState: 'missing', appended: 0 });
  await writeFile(join(root, 'memstat.json'), '{not json');
  expect(await syncSwapoutSamples({ runsDir: root, now: () => NOW }))
    .toMatchObject({ state: 'no-sample', memstatState: 'degraded' });
  await writeFile(join(root, 'memstat.json'), JSON.stringify({ ts: TS_SECONDS }));
  expect(await syncSwapoutSamples({ runsDir: root, now: () => NOW }))
    .toMatchObject({ state: 'no-sample', memstatState: 'healthy' });
});

it('blocks the append when the ledger cannot be read, rather than risk a duplicate', async () => {
  const root = await fixture();
  await mkdir(join(root, 'metrics', 'swapout-rate.jsonl'));
  expect(await syncSwapoutSamples({ runsDir: root, now: () => NOW }))
    .toMatchObject({ state: 'ledger-blocked', ledgerState: 'not-file', sampledAt: SAMPLED_AT, appended: 0 });
});

it('honours injected sources and the append cap', async () => {
  const root = await fixture(null);
  const memstatText = JSON.stringify(MEMSTAT);
  expect(await syncSwapoutSamples({ runsDir: root, now: () => NOW, memstatText, ledgerText: '', maxAppend: 0 }))
    .toMatchObject({ state: 'ok', appended: 0, ledgerState: 'read', duplicate: false });
  expect(await syncSwapoutSamples({ runsDir: root, now: () => NOW, memstatText, ledgerText: `${JSON.stringify(sampleRow())}\n` }))
    .toMatchObject({ state: 'ok', appended: 0, duplicate: true });
});

it('reads the ledger back into the sample distribution fleet vitals tunes against', async () => {
  const root = await fixture();
  await mkdir(join(root, 'metrics'), { recursive: true });
  const rows = [
    JSON.stringify(sampleRow()),
    JSON.stringify(sampleRow({ sampled_at: new Date((TS_SECONDS + 300) * 1000).toISOString(), free_pct: 41, swap_gb: 3, swapouts_per_min: 2 })),
    JSON.stringify(sampleRow({ sampled_at: new Date((TS_SECONDS + 600) * 1000).toISOString(), free_pct: null, swap_gb: null, swapouts_per_min: null })),
    'not json',
    JSON.stringify({ schema: SWAPOUT_SAMPLE_SCHEMA, sampled_at: 'bad-date' }),
    JSON.stringify(sampleRow({ free_pct: 140 })),
  ];
  await writeFile(join(root, SWAPOUT_RATE_LEDGER_RELATIVE), rows.join('\n') + '\n');
  const evidence = await readSwapoutRateEvidence(root, { guard: MEMORY_GUARD });
  expect(evidence).toMatchObject({
    source: 'degraded', state: 'known', samples: 3, invalidRows: 3,
    oldestAt: SAMPLED_AT, newestAt: new Date((TS_SECONDS + 600) * 1000).toISOString(),
    freePctKnown: 2, freePctMin: 41, freePctMean: 49.5,
    swapGbKnown: 2, swapGbMax: 3,
    swapoutsKnown: 2, swapoutsMean: 1.13, swapoutsMax: 2, swapoutsPositive: 2,
    // Both recorded free_pct values sit above lowFreePct and raiseFreePct;
    // neither swap figure reaches its guard threshold.
    memoryGuard: {
      constants: MEMORY_GUARD,
      freePctKnown: 2, swapGbKnown: 2, swapoutsKnown: 2,
      freeBelowLowShare: 0, freeAboveRaiseShare: 1,
      swapoutsGrowingShare: 0, swapAboveBackstopShare: 0,
    },
  });
});

it('reports the share of samples where each MEMORY_GUARD condition fires', async () => {
  const root = await fixture(null);
  await mkdir(join(root, 'metrics'), { recursive: true });
  const at = (offset: number) => new Date((TS_SECONDS + offset) * 1000).toISOString();
  const rows = [
    // free 20 fires both free guards; swapouts 150 and swap 60 fire theirs.
    sampleRow({ sampled_at: at(0), free_pct: 20, swap_gb: 60, swapouts_per_min: 150 }),
    // free 55 clears both free guards; swapouts 0.5 and swap 10 clear theirs.
    sampleRow({ sampled_at: at(300), free_pct: 55, swap_gb: 10, swapouts_per_min: 0.5 }),
    // A sample carrying only swapouts still counts toward that field's denominator.
    sampleRow({ sampled_at: at(600), free_pct: null, swap_gb: null, swapouts_per_min: 200 }),
  ];
  await writeFile(join(root, SWAPOUT_RATE_LEDGER_RELATIVE), rows.map(JSON.stringify).join('\n') + '\n');
  const evidence = await readSwapoutRateEvidence(root, { guard: MEMORY_GUARD });
  expect(evidence.memoryGuard).toEqual({
    constants: { ...MEMORY_GUARD },
    freePctKnown: 2, swapGbKnown: 2, swapoutsKnown: 3,
    freeBelowLowShare: 0.5, freeAboveRaiseShare: 0.5,
    swapoutsGrowingShare: 0.6667, swapAboveBackstopShare: 0.5,
  });
});

it('reports unknown evidence when the ledger is absent, empty or unreadable', async () => {
  const root = await fixture(null);
  expect(await readSwapoutRateEvidence(root, { guard: MEMORY_GUARD })).toMatchObject({
    source: 'missing', state: 'unknown', samples: 0, invalidRows: 0,
    oldestAt: null, newestAt: null, swapoutsMean: null, swapoutsMax: null,
    memoryGuard: null,
  });
  await mkdir(join(root, 'metrics'), { recursive: true });
  await writeFile(join(root, SWAPOUT_RATE_LEDGER_RELATIVE), '');
  expect(await readSwapoutRateEvidence(root)).toMatchObject({ source: 'healthy', state: 'unknown', samples: 0 });
  await rm(join(root, SWAPOUT_RATE_LEDGER_RELATIVE));
  await mkdir(join(root, SWAPOUT_RATE_LEDGER_RELATIVE));
  expect(await readSwapoutRateEvidence(root)).toMatchObject({ source: 'degraded', state: 'unknown', samples: 0 });
});

it('round-trips a synced sample into known evidence', async () => {
  const root = await fixture();
  await syncSwapoutSamples({ runsDir: root, now: () => NOW });
  const evidence = await readSwapoutRateEvidence(root);
  expect(evidence).toMatchObject({
    source: 'healthy', state: 'known', samples: 1, invalidRows: 0,
    oldestAt: SAMPLED_AT, newestAt: SAMPLED_AT,
    freePctKnown: 1, freePctMin: 58, freePctMean: 58,
    swapGbKnown: 1, swapGbMax: 1.5,
    swapoutsKnown: 1, swapoutsMean: 0.25, swapoutsMax: 0.25, swapoutsPositive: 1,
  });
  // Without injected thresholds the guard assessment stays absent, never guessed.
  expect(evidence.memoryGuard).toBeNull();
});

it('adds swapout_rate to the vitals view without touching the HostVitals shape', async () => {
  const root = await fixture();
  await syncSwapoutSamples({ runsDir: root, now: () => NOW });
  const view = await readFleetVitalsView(root, NOW);
  expect(view.swapout_rate).toMatchObject({ state: 'known', samples: 1 });
  expect(Object.keys(await readHostVitals(root, NOW)).sort())
    .toEqual(['disk', 'emptyCauses', 'launch', 'launchCost', 'local_models', 'schema', 'status', 'stuck']);
});

it('prints the memory-samples line and emits swapout_rate in --json output', async () => {
  const root = await fixture();
  await syncSwapoutSamples({ runsDir: root, now: () => NOW });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root, '--json'])).toBe(0);
  const json = JSON.parse(String(log.mock.calls[0]![0]));
  expect(json.swapout_rate).toMatchObject({
    state: 'known', samples: 1, swapoutsMean: 0.25,
    memoryGuard: { freeAboveRaiseShare: 1, swapoutsGrowingShare: 0 },
  });
  log.mockClear();
  expect(await cmdFleetVitals(['--runs-dir', root])).toBe(0);
  const lines = log.mock.calls.map(call => String(call[0]));
  expect(lines.some(line => line.startsWith('Memory samples: 1 recorded'))).toBe(true);
  expect(lines.some(line => line.includes('swapouts/min mean 0.25'))).toBe(true);
  expect(lines.some(line => line.startsWith('Memory guard:') && line.includes('free>30% 100%'))).toBe(true);
});

it('prints unknown, never a zeroed guess, when no ledger exists', async () => {
  const root = await fixture(null);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetVitals(['--runs-dir', root])).toBe(0);
  expect(log.mock.calls.map(call => String(call[0]))).toContain('Memory samples: unknown (source missing)');
});
