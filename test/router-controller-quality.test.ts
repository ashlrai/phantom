import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetRouterWeights } from '../src/cli/fleet-router-weights.js';
import { readControllerQuality } from '../src/core/router/controller-quality.js';
import { readRouterOutcomes } from '../src/core/router/outcomes.js';
import { buildRouterWeightProposalReport } from '../src/core/router/weight-proposals.js';

// Fleet-controller lane-quality receipts (route.quality.v1) folded into the
// advisory router-weight report. Fixtures are synthetic; HOME/ASHLR_HOME are
// temp dirs so every read stays hermetic.

let root: string;
let runs: string;
let logged: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'router-controller-quality-'));
  runs = join(root, 'runs');
  mkdirSync(join(runs, 'metrics'), { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const statePath = (): string => join(runs, 'queue', 'fleet-controller.json');
const writeState = (doc: unknown): void => {
  mkdirSync(join(runs, 'queue'), { recursive: true });
  writeFileSync(statePath(), typeof doc === 'string' ? doc : JSON.stringify(doc));
};
const ledgerPath = (): string => join(runs, 'metrics', 'jobs.jsonl');
const writeLedger = (rows: object[]): void =>
  writeFileSync(ledgerPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

/** A route.quality.v1 receipt in the dispatcher's own shape. */
const receipt = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'route.quality.v1',
  lane: 'alpha',
  ts: 1_700_000_000,
  decided_at: 1_700_000_000,
  report_at: '2026-01-01T00:00:00.000Z',
  resolved: 31,
  score: 0.42,
  ci_adverse_delta: -0.1,
  from: 1,
  to: 0.75,
  reason: 'quality_adjustment',
  mode: 'enforce',
  target_from: 3,
  target_to: 2,
  ...over,
});

describe('readControllerQuality', () => {
  it('reports missing, unreadable-content and invalid shapes as their own states', async () => {
    expect(await readControllerQuality({ runsDir: runs })).toMatchObject({ state: 'missing', receipts: [], invalid_rows: null });
    writeState('{not json');
    expect(await readControllerQuality({ runsDir: runs })).toMatchObject({ state: 'invalid', receipts: [] });
    writeState({ quality_receipts: 'nope' });
    expect(await readControllerQuality({ runsDir: runs })).toMatchObject({ state: 'invalid', receipts: [] });
    writeState([1, 2, 3]);
    expect(await readControllerQuality({ runsDir: runs })).toMatchObject({ state: 'invalid', receipts: [] });
  });

  it('reads a state file with no quality_receipts member as read with zero verdicts', async () => {
    writeState({ level: 'normal', outcome_quality: {} });
    expect(await readControllerQuality({ runsDir: runs })).toMatchObject({ state: 'read', receipts: [], invalid_rows: 0 });
  });

  it('validates receipts, dedups newest-per-lane and sorts by lane', async () => {
    writeState({
      quality_receipts: [
        receipt({ lane: 'beta', ts: 100, score: 0.9, to: 1 }),
        receipt({ lane: 'alpha', ts: 100, score: 0.42 }),
        receipt({ lane: 'alpha', ts: 200, score: 0.5, to: 0.5, reason: 'deadband' }),
        receipt({ lane: 'alpha', ts: 200, score: 0.99, to: 0.6, reason: 'same_quality' }), // equal ts: later row wins
      ],
    });
    const read = await readControllerQuality({ runsDir: runs });
    expect(read.state).toBe('read');
    expect(read.invalid_rows).toBe(0);
    expect(read.receipts.map(r => r.lane)).toEqual(['alpha', 'beta']);
    // alpha: newest ts=200, later row on the tie -> score 0.99 wins.
    expect(read.receipts[0]).toMatchObject({ lane: 'alpha', ts: 200, score: 0.99, to: 0.6, reason: 'same_quality', mode: 'enforce', resolved: 31 });
    expect(read.receipts[1]).toMatchObject({ lane: 'beta', ts: 100, score: 0.9, to: 1 });
  });

  it('skips rows that cannot be attributed and counts them as invalid', async () => {
    writeState({
      quality_receipts: [
        'junk',
        receipt({ schema: 'route.quality.v0' }),
        receipt({ lane: 'bad lane!' }),
        receipt({ ts: 'soon' }),
        receipt({ lane: 'gamma' }),
      ],
    });
    const read = await readControllerQuality({ runsDir: runs });
    expect(read.state).toBe('read');
    expect(read.invalid_rows).toBe(4);
    expect(read.receipts.map(r => r.lane)).toEqual(['gamma']);
  });

  it('keeps unrecognized vocab and out-of-range numbers as null, never raw', async () => {
    writeState({
      quality_receipts: [receipt({
        reason: 'surprise', mode: 'ludicrous', score: 1.7, ci_adverse_delta: 4,
        from: -0.2, to: 2, resolved: -3, decided_at: 'later', report_at: 'x'.repeat(100),
        target_from: 1.5,
      })],
    });
    const [r] = (await readControllerQuality({ runsDir: runs })).receipts;
    expect(r).toMatchObject({
      reason: null, mode: null, score: null, ci_adverse_delta: null, from: null, to: null,
      resolved: null, decided_at: null, report_at: null, target_from: null, target_to: 2,
    });
  });

  it('rejects a non-absolute runsDir', async () => {
    await expect(readControllerQuality({ runsDir: 'relative/dir' })).rejects.toThrow(RangeError);
  });
});

describe('router weight proposal report', () => {
  it('carries controller quality state and receipts when supplied', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', phase: 'MERGED' }]);
    const read = await readRouterOutcomes({ runsDir: runs });
    writeState({ quality_receipts: [receipt()] });
    const controller = await readControllerQuality({ runsDir: runs });
    const report = buildRouterWeightProposalReport(read, '2026-02-01T00:00:00.000Z', { controllerQuality: controller });
    expect(report.controller_quality_state).toBe('read');
    expect(report.controller_quality_invalid_rows).toBe(0);
    expect(report.controller_quality).toHaveLength(1);
    expect(report.controller_quality![0]).toMatchObject({ lane: 'alpha', score: 0.42, to: 0.75, reason: 'quality_adjustment', mode: 'enforce' });
  });

  it('reports unreported when no controller read is supplied, and null receipts on degraded states', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', phase: 'MERGED' }]);
    const read = await readRouterOutcomes({ runsDir: runs });
    const bare = buildRouterWeightProposalReport(read, '2026-02-01T00:00:00.000Z');
    expect(bare).toMatchObject({ controller_quality_state: 'unreported', controller_quality: null, controller_quality_invalid_rows: null });
    writeState('{bad');
    const degraded = buildRouterWeightProposalReport(read, '2026-02-01T00:00:00.000Z',
      { controllerQuality: await readControllerQuality({ runsDir: runs }) });
    expect(degraded).toMatchObject({ controller_quality_state: 'invalid', controller_quality: null, controller_quality_invalid_rows: null });
  });
});

describe('phm fleet router-weights', () => {
  it('joins controller verdicts into the JSON report and renders them in text', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', work_class: 'code', phase: 'MERGED' }]);
    writeState({ quality_receipts: [receipt()] });
    logged = [];
    const code = await cmdFleetRouterWeights(['--runs-dir', runs, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(logged.join('\n'));
    expect(report.controller_quality_state).toBe('read');
    expect(report.controller_quality[0]).toMatchObject({ lane: 'alpha', score: 0.42, reason: 'quality_adjustment' });

    logged = [];
    const textCode = await cmdFleetRouterWeights(['--runs-dir', runs]);
    expect(textCode).toBe(0);
    const out = logged.join('\n');
    expect(out).toContain('controller_quality=read');
    expect(out).toContain('controller quality verdicts');
    expect(out).toContain('alpha: weight 1->0.75 score=0.42 resolved=31 ci_adverse=-0.1 reason=quality_adjustment mode=enforce');
  });

  it('reports a missing controller state as coverage, never as zero verdicts', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', phase: 'MERGED' }]);
    logged = [];
    const code = await cmdFleetRouterWeights(['--runs-dir', runs]);
    expect(code).toBe(0);
    const out = logged.join('\n');
    expect(out).toContain('controller_quality=missing');
    expect(out).toContain('controller-quality coverage: fleet-controller.json missing');
    expect(out).not.toContain('no lane-quality verdicts recorded');
  });
});
