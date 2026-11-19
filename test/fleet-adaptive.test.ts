import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdFleetAdaptive } from '../src/cli/fleet-adaptive.js';
import {
  ADAPTIVE_FRESH_SECONDS, ADAPTIVE_SCHEMA, adaptiveSignals, readAdaptiveSignals, unknownAdaptive,
} from '../src/core/fleet/adaptive-signals.js';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const HOURS = 24;
const iso = (ms: number) => new Date(ms).toISOString();
const launch = (job: string, lane: string, at: number) =>
  JSON.stringify({ event: 'launch', job, lane, tier: 'work', repo: 'phantom', ts: iso(at) });
const finish = (job: string, lane: string, at: number, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ event: 'finish', job, lane, wall_s: 100, exit_code: 0, ts: iso(at), ...fields });
const publishPr = (job: string, at: number) =>
  JSON.stringify({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${job}`, ts: iso(at) });
const outcome = (job: string, state: string, at: number) =>
  JSON.stringify({ event: 'outcome', job, state, ts: iso(at) });

/**
 * claude: 4 launches (1 merged, 1 empty, 1 plain finish, 1 still running).
 * codex-cmp: 2 launches, both finished, 1 merged, model_s 30 and 60.
 * devin: 1 launch still running. old-lane: launched before the window.
 * `now` is the observation instant; every row is relative to it.
 */
function ledger(now: number): string {
  const ago = (ms: number) => now - ms;
  return [
    launch('RQ-C1', 'claude', ago(3600_000)), finish('RQ-C1', 'claude', ago(3500_000), { model_s: 50 }),
    publishPr('RQ-C1', ago(3400_000)), outcome('RQ-C1', 'MERGED', ago(3300_000)),
    launch('RQ-C2', 'claude', ago(3200_000)), finish('RQ-C2', 'claude', ago(3100_000), { empty: true }),
    outcome('RQ-C2', 'CLOSED', ago(3000_000)),
    launch('RQ-C3', 'claude', ago(2900_000)), finish('RQ-C3', 'claude', ago(2800_000)),
    launch('RQ-C4', 'claude', ago(2700_000)),
    launch('RQ-M1', 'codex-cmp', ago(2600_000)), finish('RQ-M1', 'codex-cmp', ago(2500_000), { model_s: 30 }),
    publishPr('RQ-M1', ago(2400_000)), outcome('RQ-M1', 'MERGED', ago(2300_000)),
    launch('RQ-M2', 'codex-cmp', ago(2200_000)), finish('RQ-M2', 'codex-cmp', ago(2100_000), { model_s: 60 }),
    launch('RQ-D1', 'devin', ago(2000_000)),
    launch('RQ-OLD', 'old-lane', ago(25 * 3600_000)), finish('RQ-OLD', 'old-lane', ago(24 * 3600_000), { model_s: 5 }),
    // model_s probes that must be ignored: non-finish event, bad lane, bad value.
    JSON.stringify({ event: 'outcome', job: 'RQ-C1', state: 'MERGED', model_s: 999, ts: iso(ago(1000)) }),
    finish('RQ-C3', 'claude', ago(900_000), { model_s: -4 }),
    finish('RQ-C3', 'not a lane!!', ago(800_000), { model_s: 7 }),
    'not json at all',
  ].join('\n');
}

const LEDGER = ledger(NOW);

describe('adaptiveSignals', () => {
  it('computes per-lane market signals from the job ledger', () => {
    const report = adaptiveSignals(LEDGER.split('\n'), NOW, HOURS);
    expect(report.schema).toBe(ADAPTIVE_SCHEMA);
    expect(report.known).toBe(true);
    expect(report.window_hours).toBe(HOURS);
    expect(report.generated_at).toBe(iso(NOW));
    // Busiest lane first; the pre-window lane is absent entirely.
    expect(Object.keys(report.lanes)).toEqual(['claude', 'codex-cmp', 'devin']);
    expect(report.lanes.claude).toEqual({
      launches: 4, finished: 3, empty: 1, merged: 1,
      empty_rate: 1 / 3, yield_rate: 0.25, model_latency_s: 50, model_latency_samples: 1, backoff: null,
    });
    expect(report.lanes['codex-cmp']).toMatchObject({
      launches: 2, finished: 2, empty: 0, merged: 1,
      empty_rate: 0, yield_rate: 0.5, model_latency_s: 45, model_latency_samples: 2,
    });
    // A lane with launches but no finished run: the rates it can measure are real,
    // the rest stay unknown — never zero.
    expect(report.lanes.devin).toEqual({
      launches: 1, finished: 0, empty: 0, merged: 0,
      empty_rate: null, yield_rate: 0, model_latency_s: null, model_latency_samples: 0, backoff: null,
    });
  });

  it('publishes exactly the queue/adaptive.json shape with a fresh epoch-seconds ts', () => {
    const report = adaptiveSignals(LEDGER.split('\n'), NOW, HOURS);
    expect(report.publish).toEqual({
      ts: Math.floor(NOW / 1000),
      lanes: {
        claude: { empty_rate: 1 / 3, yield_rate: 0.25, model_latency_s: 50, backoff: null },
        'codex-cmp': { empty_rate: 0, yield_rate: 0.5, model_latency_s: 45, backoff: null },
        devin: { empty_rate: null, yield_rate: 0, model_latency_s: null, backoff: null },
      },
    });
    expect(ADAPTIVE_FRESH_SECONDS).toBe(300);
  });

  it('reports an empty projection when the window has no launches', () => {
    const report = adaptiveSignals([launch('RQ-X', 'claude', NOW - 25 * 3600_000)], NOW, HOURS);
    expect(report.known).toBe(true);
    expect(report.lanes).toEqual({});
    expect(report.publish).toEqual({ ts: Math.floor(NOW / 1000), lanes: {} });
  });

  it('marks an unreadable ledger unknown with no publish payload', () => {
    const report = unknownAdaptive(HOURS, NOW);
    expect(report).toMatchObject({ schema: ADAPTIVE_SCHEMA, known: false, window_hours: HOURS, lanes: {}, publish: null });
    expect(report.generated_at).toBe(iso(NOW));
  });
});

describe('readAdaptiveSignals', () => {
  it('streams the file through the tally and returns unknown on read failure', async () => {
    const ok = await readAdaptiveSignals('unused', HOURS, NOW, async (_path, onLine) => {
      for (const line of LEDGER.split('\n')) onLine(line);
      return true;
    });
    expect(ok.lanes.claude?.yield_rate).toBe(0.25);
    const missing = await readAdaptiveSignals('unused', HOURS, NOW, async () => false);
    expect(missing).toMatchObject({ known: false, publish: null });
  });
});

let dir: string;
const saved = process.env.ASHLR_RUNS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-adaptive-'));
  mkdirSync(join(dir, 'queue'));
  mkdirSync(join(dir, 'metrics'));
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[] = ['--json']) {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const code = await cmdFleetAdaptive(args);
  return { code, lines: out.mock.calls.map(c => String(c[0])), errors: err.mock.calls.length };
}

describe('phm fleet adaptive', () => {
  it('is registered as a fleet verb', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS.adaptive!();
    expect(mod.cmdFleetAdaptive).toBe(cmdFleetAdaptive);
  });

  it('prints usage for --help and rejects unknown or out-of-range arguments', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.lines[0]).toContain('Usage: phm fleet adaptive');
    expect(help.lines[0]).toContain('queue/adaptive.json');
    for (const args of [['--nope'], ['--window'], ['--window', '0'], ['--window', '169'], ['--window', 'abc'], ['--json', '--apply', '--apply'], ['--apply', '--json', 'extra']]) {
      const bad = await run(args);
      expect(bad.code).toBe(2);
      expect(bad.errors).toBe(1);
      vi.restoreAllMocks();
    }
  });

  it('exits 2 with a typed error when the job ledger is missing', async () => {
    const missing = await run();
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.lines[0]!)).toMatchObject({ schema: ADAPTIVE_SCHEMA, known: false });
    expect(existsSync(join(dir, 'queue', 'adaptive.json'))).toBe(false);
  });

  it('prints the projection without writing in dry-run mode', async () => {
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), ledger(Date.now()) + '\n');
    const result = await run(['--json']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.lines[0]!);
    expect(report).toMatchObject({ schema: ADAPTIVE_SCHEMA, known: true, applied: false, window_hours: 24 });
    expect(report.lanes.claude).toMatchObject({ launches: 4, yield_rate: 0.25, empty_rate: 1 / 3 });
    expect(report.publish.lanes.devin).toEqual({ empty_rate: null, yield_rate: 0, model_latency_s: null, backoff: null });
    expect(report.path).toContain(join('queue', 'adaptive.json'));
    expect(existsSync(join(dir, 'queue', 'adaptive.json'))).toBe(false);
  });

  it('--apply atomically publishes queue/adaptive.json in the market shape', async () => {
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), ledger(Date.now()) + '\n');
    const before = Date.now();
    const result = await run(['--apply', '--json']);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.lines[0]!);
    expect(report.applied).toBe(true);
    const target = join(dir, 'queue', 'adaptive.json');
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(target, 'utf8'));
    expect(written).toEqual(report.publish);
    expect(written.ts).toBeGreaterThanOrEqual(Math.floor(before / 1000) - 1);
    expect(written.ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(Object.keys(written.lanes)).toEqual(['claude', 'codex-cmp', 'devin']);
    expect(written.lanes.claude).toEqual({ empty_rate: 1 / 3, yield_rate: 0.25, model_latency_s: 50, backoff: null });
  });

  it('renders a plain-text summary and never writes on a missing ledger', async () => {
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), ledger(Date.now()) + '\n');
    const dry = await run(['--window', '6']);
    expect(dry.code).toBe(0);
    const body = dry.lines.join('\n');
    expect(body).toContain('claude: yield_rate 25% (1/4 launches merged)');
    expect(body).toContain('empty_rate 33.3% (1/3 finished)');
    expect(body).toContain('model_latency_s 50s');
    expect(body).toContain('Dry run');
    expect(body).toContain('fresh for 300s');
    const applied = await run(['--apply']);
    expect(applied.code).toBe(0);
    expect(applied.lines.join('\n')).toContain('Published');
    expect(existsSync(join(dir, 'queue', 'adaptive.json'))).toBe(true);
  });
});
