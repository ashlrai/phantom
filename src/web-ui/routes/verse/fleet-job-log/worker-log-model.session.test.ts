import { describe, expect, it } from 'vitest';
import { sessionFacts, stepJob, stepLabel } from './worker-log-model.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const byLabel = (facts: ReturnType<typeof sessionFacts>) => Object.fromEntries(facts.map(fact => [fact.label, fact]));

describe('sessionFacts', () => {
  it('names each recorded fact under its own label, in reading order', () => {
    const facts = sessionFacts({
      schema: 'fleet.job.v1', state: 'running', lane: 'codex-personal', tier: 'mid', model: 'gpt-6.1-terra', branch: 'codex-bridge/RQ-OLD',
      launchedAt: '2026-10-31T11:48:00Z', publish: { prUrl: 'https://github.com/example/repo/pull/1234' },
    }, 'phantom', NOW);
    expect(facts.map(fact => fact.label)).toEqual(['Lane', 'Tier', 'Model', 'Repo', 'Launched', 'Branch', 'Pull request']);
    const by = byLabel(facts);
    expect(by.Lane!.value).toBe('codex-personal');
    expect(by.Tier!.value).toBe('mid');
    expect(by.Model!.value).toBe('gpt-6.1-terra');
    expect(by.Repo!.value).toBe('phantom');
    expect(by.Launched).toMatchObject({ value: '12 min ago', at: '2026-10-31T11:48:00.000Z' });
    expect(by.Branch!.value).toBe('codex-bridge/RQ-OLD');
    expect(by['Pull request']).toMatchObject({ value: 'PR #1234', href: 'https://github.com/example/repo/pull/1234' });
  });

  it('leaves a fact nobody recorded empty instead of guessing it', () => {
    const by = byLabel(sessionFacts({ schema: 'fleet.job.v1', lane: '', model: 'unknown', launchedAt: 'not a time', publish: { prUrl: 'javascript:alert(1)' } }, undefined, NOW));
    for (const label of ['Lane', 'Tier', 'Model', 'Repo', 'Launched', 'Branch']) expect(by[label]).toEqual({ label, value: null, missing: 'unknown' });
    // A job with no link has not published one: that is not an unknown, and an unsafe link is never offered.
    expect(by['Pull request']).toEqual({ label: 'Pull request', value: null, missing: 'none recorded' });
  });
});

describe('stepping through the worker list', () => {
  const options = [{ job: 'RQ-A' }, { job: 'RQ-B' }, { job: 'RQ-C' }];
  it('moves one session at a time and wraps at both ends', () => {
    expect(stepJob(options, 'RQ-A', 1)).toBe('RQ-B');
    expect(stepJob(options, 'RQ-C', 1)).toBe('RQ-A');
    expect(stepJob(options, 'RQ-A', -1)).toBe('RQ-C');
    expect(stepLabel(options, 'RQ-B')).toBe('2 of 3');
  });
  it('steps a session that is no longer listed back onto the list, and says it is not listed', () => {
    expect(stepJob(options, 'RQ-GONE', 1)).toBe('RQ-A');
    expect(stepJob(options, 'RQ-GONE', -1)).toBe('RQ-C');
    expect(stepLabel(options, 'RQ-GONE')).toBe('not listed · 3 running');
  });
  it('has nowhere to go with one listed session or none', () => {
    expect(stepJob([{ job: 'RQ-A' }], 'RQ-A', 1)).toBeNull();
    expect(stepJob([], 'RQ-A', -1)).toBeNull();
    expect(stepLabel([], 'RQ-A')).toBe('not listed · 0 running');
  });
});
