import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLaneOverrides } from '../src/cli/fleet-lane-overrides.js';
import { foldLaneOverrides, renderLaneOverrides } from '../src/core/fleet/lane-overrides.js';

let dir: string;
const saved = process.env.ASHLR_RUNS_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-lane-overrides-'));
  mkdirSync(join(dir, 'metrics'), { recursive: true });
  process.env.ASHLR_RUNS_DIR = dir;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (saved === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;
const IN = NOW_S - 3600;
const OLD = NOW_S - 200_000;

const decision = (job: string, ts: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'work-market.v1', event: 'route_decision', job, ts,
    chosen_lane: 'claude', preferred_lane: 'codex-personal', work_class: 'standard',
    override: null, rejected_lanes: [], reason_codes: ['healthy_capacity'], ranking_inputs: {},
    ...extra,
  });

const override = (from: string, to: string, reason: string, blockedBy: string[] = []) =>
  ({ from, to, reason, preferred_lane_blocked_by: blockedBy });

describe('foldLaneOverrides', () => {
  it('reports unavailable with a null rate when the journal is absent', () => {
    const report = foldLaneOverrides(null, NOW_MS, 24);
    expect(report.available).toBe(false);
    expect(report.jobs).toBe(0);
    expect(report.overrideRate).toBeNull();
    expect(renderLaneOverrides(report)).toEqual(['Last 24h: no metrics/work-market.jsonl history.']);
  });

  it('keeps only each job\'s latest in-window decision and counts overrides, hints and unrouted jobs', () => {
    const jsonl = [
      // RQ-A moved off its hint early, then settled back on it: latest wins.
      decision('RQ-A', IN, { override: override('codex-personal', 'claude', 'preferred_lane_fallback', ['saturated']) }),
      decision('RQ-A', IN + 60, { chosen_lane: 'codex-personal', reason_codes: ['preferred_lane'] }),
      // RQ-B stays overridden: hint refused for capacity and a hold.
      decision('RQ-B', IN + 30, { chosen_lane: 'devin', override: override('codex-personal', 'devin', 'preferred_lane_fallback', ['saturated', 'held']) }),
      // RQ-C has no runnable lane and no hint.
      decision('RQ-C', IN + 40, { chosen_lane: null, preferred_lane: null, reason_codes: ['no_runnable_lane', 'global_admission'] }),
      // RQ-D holds its hint.
      decision('RQ-D', IN + 50, { preferred_lane: 'claude', chosen_lane: 'claude' }),
      // RQ-E only has a decision outside the window.
      decision('RQ-E', OLD),
      // Non-decision events and malformed lines are not evidence.
      JSON.stringify({ schema: 'work-market.v1', event: 'unfed_capacity', ts: IN, lanes: {} }),
      '{"schema":"work-market.v1","event":"route_decision","job":"RQ-BAD"',
      decision('RQ-BAD2', IN, { preferred_lane: 'not a lane!!' }),
    ].join('\n');
    const report = foldLaneOverrides(jsonl, NOW_MS, 24);
    expect(report.available).toBe(true);
    expect(report.jobs).toBe(4);
    expect(report.rows).toBe(5);
    expect(report.dropped).toBe(2);
    expect(report.hinted).toBe(3);
    expect(report.overrides).toBe(1);
    expect(report.overrideRate).toBe(0.333);
    expect(report.reasons).toEqual({ preferred_lane_fallback: 1 });
    expect(report.blockedBy).toEqual({ saturated: 1, held: 1 });
    expect(report.pairs).toEqual([{ from: 'codex-personal', to: 'devin', count: 1 }]);
    expect(report.unrouted).toBe(1);
    expect(report.unroutedReasons).toEqual({ no_runnable_lane: 1, global_admission: 1 });
  });

  it('rates overrides against hinted jobs only and leaves the rate unknown without hints', () => {
    const open = [
      decision('RQ-OPEN1', IN, { preferred_lane: null }),
      decision('RQ-OPEN2', IN, { preferred_lane: null, chosen_lane: null, reason_codes: ['no_runnable_lane'] }),
    ].join('\n');
    const report = foldLaneOverrides(open, NOW_MS, 24);
    expect(report.jobs).toBe(2);
    expect(report.hinted).toBe(0);
    expect(report.overrides).toBe(0);
    expect(report.overrideRate).toBeNull();
    expect(report.unrouted).toBe(1);
  });

  it('defaults override endpoints to the row\'s preferred and chosen lanes', () => {
    const jsonl = decision('RQ-DEF', IN, {
      chosen_lane: 'omlx',
      override: { reason: 'resource_fit', preferred_lane_blocked_by: ['lower_rank'] },
    });
    const report = foldLaneOverrides(jsonl, NOW_MS, 24);
    expect(report.overrides).toBe(1);
    expect(report.reasons).toEqual({ resource_fit: 1 });
    expect(report.blockedBy).toEqual({ lower_rank: 1 });
    expect(report.pairs).toEqual([{ from: 'codex-personal', to: 'omlx', count: 1 }]);
  });

  it('counts invalid_requirements early rows as unrouted, not as overrides', () => {
    const jsonl = JSON.stringify({
      schema: 'work-market.v1', event: 'route_decision', job: 'RQ-INV', ts: IN,
      chosen_lane: null, rejected_lanes: [], reason_codes: ['invalid_requirements'],
    });
    const report = foldLaneOverrides(jsonl, NOW_MS, 24);
    expect(report.jobs).toBe(1);
    expect(report.unrouted).toBe(1);
    expect(report.unroutedReasons).toEqual({ invalid_requirements: 1 });
    expect(report.overrides).toBe(0);
    expect(report.overrideRate).toBeNull();
  });
});

describe('cmdFleetLaneOverrides', () => {
  async function run(args: string[] = ['--json']) {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await cmdFleetLaneOverrides(args);
    return { code, lines: out.mock.calls.map(c => String(c[0])), errors: err.mock.calls.length };
  }

  it('prints the folded report as JSON and exits 0 when the journal exists', async () => {
    writeFileSync(join(dir, 'metrics', 'work-market.jsonl'),
      decision('RQ-A', Date.now() / 1000 - 60, { chosen_lane: 'devin', override: override('codex-personal', 'devin', 'resource_fit') }) + '\n');
    const { code, lines } = await run(['--json']);
    expect(code).toBe(0);
    const report = JSON.parse(lines[0]!);
    expect(report.schema).toBe('fleet.lane-overrides.v1');
    expect(report.jobs).toBe(1);
    expect(report.overrides).toBe(1);
    expect(report.pairs).toEqual([{ from: 'codex-personal', to: 'devin', count: 1 }]);
  });

  it('exits 1 with available:false when the journal is missing', async () => {
    const { code, lines } = await run(['--json']);
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]!).available).toBe(false);
  });

  it('rejects bad windows and unknown flags', async () => {
    expect((await run(['--window', '0'])).code).toBe(2);
    expect((await run(['--window', '999'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
});
