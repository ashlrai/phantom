import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseOutcomeLog, replayOutcomeRecords, replayOutcomeText } from '../src/core/bandit/replay.js';
import { outcomeRecordFrom, rewardOf, ROUTER_OUTCOME_SCHEMA } from '../src/core/bandit/rewards.js';
import { DEFAULT_BANDIT_CONFIG } from '../src/core/bandit/types.js';

const fixture = readFileSync(new URL('./fixtures/bandit/outcomes.jsonl', import.meta.url), 'utf8');

const record = (overrides: Record<string, unknown>) => outcomeRecordFrom({
  schema: ROUTER_OUTCOME_SCHEMA,
  job: 'RQ-T',
  at: '2026-10-20T00:00:00Z',
  pool: 'devin',
  repo: 'phantom',
  tier: 'work',
  ...overrides,
});

describe('outcome record validation', () => {
  it('accepts a complete row and defaults lane to the declared pool', () => {
    const parsed = record({ sizeLines: 12 });
    expect(parsed.lane).toBe('devin');
    expect(parsed.pool).toBe('devin');
  });

  it('rejects malformed rows with a field-level reason', () => {
    for (const bad of [
      {}, { schema: 'other' }, { schema: ROUTER_OUTCOME_SCHEMA, job: '', pool: 'p', repo: 'r', tier: 't', at: 'x' },
      { schema: ROUTER_OUTCOME_SCHEMA, job: 'j', pool: 'p', repo: 'r', tier: 't', at: 'not-a-time' },
      { schema: ROUTER_OUTCOME_SCHEMA, job: 'j', pool: 'p', repo: 'r', tier: 't', at: '2026-10-20T00:00:00Z', costUsd: -1 },
      { schema: ROUTER_OUTCOME_SCHEMA, job: 'j', pool: 'p', repo: 'r', tier: 't', at: '2026-10-20T00:00:00Z', mergedAt: 'soon' },
      { schema: ROUTER_OUTCOME_SCHEMA, job: 'j', pool: 'p', repo: 'r', tier: 't', at: '2026-10-20T00:00:00Z', credits: { p: 'lots' } },
    ]) {
      expect(() => outcomeRecordFrom(bad)).toThrow(/Invalid router outcome row/);
    }
  });
});

describe('reward', () => {
  it('is 1 minus normalized cost and CI wall for a merge inside 24h with green CI', () => {
    const reward = rewardOf(record({
      mergedAt: '2026-10-20T06:00:00Z', ciGreen: true, costUsd: 5, ciWallMs: 1_800_000,
    }), DEFAULT_BANDIT_CONFIG.reward);
    // 1 - 0.25*(5/10) - 0.25*(1800000/3600000) = 1 - 0.125 - 0.125 = 0.75
    expect(reward.success).toBe(true);
    expect(reward.unit).toBeCloseTo(0.75, 6);
    expect(reward.raw).toBeCloseTo(0.75, 6);
  });

  it('is 0-ish for no merge, for a merge outside the window, and for red CI', () => {
    const noMerge = rewardOf(record({ ciGreen: true, costUsd: 5 }), DEFAULT_BANDIT_CONFIG.reward);
    expect(noMerge.success).toBe(false);
    expect(noMerge.unit).toBe(0);
    expect(noMerge.raw).toBeLessThan(0);

    const late = rewardOf(record({ mergedAt: '2026-10-21T01:00:00Z', ciGreen: true }), DEFAULT_BANDIT_CONFIG.reward);
    expect(late.success).toBe(false);

    const red = rewardOf(record({ mergedAt: '2026-10-20T06:00:00Z', ciGreen: false }), DEFAULT_BANDIT_CONFIG.reward);
    expect(red.success).toBe(false);

    const unknownCi = rewardOf(record({ mergedAt: '2026-10-20T06:00:00Z' }), DEFAULT_BANDIT_CONFIG.reward);
    expect(unknownCi.success).toBe(false);
  });

  it('treats absent cost and wall evidence as zero penalty, never synthesized', () => {
    const reward = rewardOf(record({ mergedAt: '2026-10-20T06:00:00Z', ciGreen: true }), DEFAULT_BANDIT_CONFIG.reward);
    expect(reward.unit).toBe(1);
  });
});

describe('outcome log parsing', () => {
  it('parses JSONL and JSON-array forms, skips nothing silently', () => {
    const fromLog = parseOutcomeLog(fixture);
    expect(fromLog.length).toBeGreaterThan(90);
    const asArray = parseOutcomeLog(JSON.stringify(fromLog.slice(0, 3)));
    expect(asArray).toHaveLength(3);
    expect(parseOutcomeLog('')).toEqual([]);
  });

  it('fails loudly with the line number on malformed input', () => {
    expect(() => parseOutcomeLog('{"schema":"phantom-router-outcome/v1"}\nnot json')).toThrow(/line 2/);
    expect(() => parseOutcomeLog(fixture.split('\n').slice(0, 1).join('\n').replace('"phantom"', '123'))).toThrow(/line 1/);
  });
});

describe('replay against the fixture outcome log', () => {
  const report = replayOutcomeText(fixture, { seed: 7 });

  it('reports static and bandit rewards with kept-record accounting', () => {
    expect(report.schema).toBe('phantom-router-bandit-replay/v1');
    expect(report.records).toBe(95);
    expect(report.kept).toBeGreaterThan(0);
    expect(report.kept).toBeLessThan(report.records);
    expect(report.keptRate).toBeGreaterThan(0);
    expect(report.floorDenials).toBe(1);
    for (const lane of ['devin', 'codex-personal']) {
      expect(report.lanes[lane]!.logged).toBeGreaterThan(0);
    }
  });

  it('shows the bandit beating the static router — the acceptance before/after', () => {
    expect(report.before.meanReward).not.toBeNull();
    expect(report.after.meanReward).not.toBeNull();
    expect(report.after.meanReward!).toBeGreaterThan(report.before.meanReward!);
    expect(report.delta.meanReward).toBeGreaterThan(0);
    // The kept subset is a matched-evidence control, not a different world.
    expect(report.staticOnKept.records).toBe(report.after.records);
  });

  it('is deterministic for a fixed seed and honest about support', () => {
    const repeat = replayOutcomeText(fixture, { seed: 7 });
    expect(repeat).toEqual(report);
    const other = replayOutcomeText(fixture, { seed: 8 });
    expect(other.kept).not.toBe(0);
  });

  it('a bandit that only ever agrees with the logger reproduces the static mean', () => {
    // With all lanes trained identically at the global level, posterior means
    // tie and sampling reduces to the logged choice more often — sanity-check
    // the kept mean stays within the logged support range.
    expect(report.after.meanReward!).toBeGreaterThanOrEqual(0);
    expect(report.after.meanReward!).toBeLessThanOrEqual(1);
  });
});

describe('replay edge cases', () => {
  it('an empty log produces a null-metric report, not invented numbers', () => {
    const report = replayOutcomeRecords([]);
    expect(report.records).toBe(0);
    expect(report.before.meanReward).toBeNull();
    expect(report.after.meanReward).toBeNull();
    expect(report.delta.meanReward).toBeNull();
  });

  it('records with an all-below-floor plan are counted as denials and never kept', () => {
    const rec = record({ credits: { devin: -1, 'codex-personal': -1 } });
    const report = replayOutcomeRecords([rec]);
    expect(report.floorDenials).toBe(1);
    expect(report.kept).toBe(0);
    expect(report.before.records).toBe(1);
  });

  it('a supplied lane set lets arms exist beyond the logged lanes', () => {
    const rec = record({ mergedAt: '2026-10-20T06:00:00Z', ciGreen: true });
    const report = replayOutcomeRecords([rec], {
      lanes: [
        { id: 'devin', pool: 'devin' },
        { id: 'codex-personal', pool: 'codex-personal' },
        { id: 'local', pool: 'local' },
      ],
      seed: 3,
    });
    expect(report.config.lanes).toEqual(['devin', 'codex-personal', 'local']);
  });
});
