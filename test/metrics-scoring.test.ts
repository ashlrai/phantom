import { describe, expect, it } from 'vitest';
import { quality, recommend, rollup, significance } from '../src/core/metrics/scoring.js';
import { gradeBatch, jevRater, localModelRater, sampled, type RatingInput } from '../src/core/metrics/raters.js';
import type { TelemetryEvent } from '../src/core/metrics/telemetry.js';

const base = { v: 1 as const, id: 'event', ts: '2026-10-26T00:00:00.000Z', sessionId: 'session', agent: 'codex' };
const pr = { repo: 'ashlrai/phantom', number: 697, additions: 200, deployedToProduction: true };
const merged = (id: string, production?: boolean): TelemetryEvent => ({ ...base, id, kind: 'pr.merged', pr: { ...pr, deployedToProduction: production } });
const usage: TelemetryEvent = { ...base, id: 'usage', kind: 'usage', inputTokens: 10_000, outputTokens: 0, wallMs: 500, costUsd: 1 };
const item: RatingInput = { pr, title: 'A merged improvement', summary: 'Tests and implementation' };

describe('metrics scoring evidence', () => {
  it('credits only explicit deployment evidence, once per PR', () => {
    const r = rollup([merged('unknown'), merged('unshipped', false), merged('shipped', true), merged('duplicate', true)]);
    expect(r.totals.prsShipped).toBe(1);
    expect(r.prs).toHaveLength(1);
    expect(rollup([merged('unknown')]).totals.value).toBe(0);
    expect(rollup([merged('unshipped', false)]).totals.value).toBe(0);
  });

  it('deduplicates replayed receipts and reconciles session duration independently of event order', () => {
    const ended: TelemetryEvent = { ...base, id: 'ended', kind: 'session.ended', outcome: 'success', wallMs: 1000 };
    const after = rollup([usage, usage, ended, merged('merge', true)]);
    const before = rollup([ended, usage, merged('merge', true)]);
    expect(after.totals.tokens).toBe(10_000);
    expect(after.totals.wallMs).toBe(1000);
    expect(before.totals).toEqual(after.totals);
  });

  it('applies late ratings and reverts without creating phantom task attempts', () => {
    const rated: TelemetryEvent = { ...base, id: 'rated', sessionId: 'grader', agent: 'judge', kind: 'pr.rated', pr, rater: 'llm-judge', rating: 1 };
    const reverted: TelemetryEvent = { ...base, id: 'reverted', sessionId: 'observer', kind: 'pr.reverted', pr };
    const r = rollup([usage, merged('merge', true), rated]);
    expect(r.totals.sessions).toBe(1);
    expect(r.prs[0]!.quality).toBe(quality(pr, [1]));
    expect(rollup([usage, merged('merge', true), rated, reverted]).totals.value).toBe(0);
    expect(rollup([rated, reverted]).totals.sessions).toBe(0);
  });

  it('preserves task and strategy attribution across a whole session', () => {
    const started: TelemetryEvent = { ...base, id: 'start', kind: 'session.started', taskType: 'bugfix', strategy: 'tdd' };
    const chosen = recommend([started, usage, merged('merge', true)], 'bugfix', ['codex|tdd']);
    expect(chosen.arm).toBe('codex|tdd');
    expect(chosen.reason).toContain('n=1');
    expect(chosen.reason).toContain(`mean=${rollup([started, usage, merged('merge', true)]).totals.valuePerMTok}`);
    expect(recommend([started, usage], 'docs', ['codex']).reason).toContain('no evidence');
    expect(() => recommend([], 'bugfix', [])).toThrow(/at least one/);
  });

  it('retains the original upside-weighted scoring formula', () => {
    expect(significance({ repo: 'a/b', number: 1 })).toBe(1.3);
    expect(quality(pr)).toBe(0.75);
    expect(quality({ ...pr, ciPassedFirstTry: true, coverageDelta: 2 })).toBe(0.95);
  });
});

describe('metrics grading evidence', () => {
  it.each(['4', 'Rating: 4'])('accepts the supported rating form %s', async answer => {
    expect((await localModelRater(async () => answer).rate(item)).rating).toBe(4);
  });

  it.each(['', 'unavailable', '14', '0', '5.5', 'Error 401: denied'])('rejects an unknown or invalid model result %j', async answer => {
    await expect(localModelRater(async () => answer).rate(item)).rejects.toThrow(/invalid rating/);
  });

  it('rejects malformed Jev results instead of inventing a neutral score', async () => {
    await expect(jevRater(async () => ({ label: 'no result', confidence: 1 })).rate(item)).rejects.toThrow();
    await expect(jevRater(async () => ({ label: '5', confidence: 2 })).rate(item)).rejects.toThrow();
  });

  it('enforces concurrency and drops failed or invalid grades', async () => {
    let active = 0; let peak = 0; let calls = 0;
    const rater = { id: 'fixture', async rate() {
      active++; peak = Math.max(active, peak); const n = ++calls;
      await Promise.resolve(); active--;
      if (n === 1) throw new Error('unavailable');
      return { rating: n === 2 ? 9 : 4, rubric: 'fixture' };
    } };
    const result = await gradeBatch(Array.from({ length: 8 }, () => item), rater, { concurrency: 2 });
    expect(peak).toBe(2);
    expect(calls).toBe(8);
    expect(result).toHaveLength(6);
    expect(result.every(r => r.result.rating === 4)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid concurrency %s before grading', async concurrency => {
    await expect(gradeBatch([], localModelRater(async () => '4'), { concurrency })).rejects.toThrow(/Concurrency/);
  });

  it.each([-1, NaN, Infinity, 2])('rejects invalid sample rates %s even for empty batches', async sampleRate => {
    await expect(gradeBatch([], localModelRater(async () => '4'), { sampleRate })).rejects.toThrow(/Sample rate/);
    expect(() => sampled(pr, sampleRate)).toThrow(/Sample rate/);
  });
});
