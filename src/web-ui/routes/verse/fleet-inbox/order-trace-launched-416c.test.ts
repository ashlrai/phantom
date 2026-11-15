import { describe, expect, it } from 'vitest';
import { interjectOutcome } from '../fleet/interject-outcome-model.js';
import { citedJobsLine } from '../fleet-steering/steering-model.js';
import { stateWord, type OrderTraceJob, type OrderTraceV1 } from './order-trace-model.js';

const NOW = '2026-11-13T12:00:00.000Z';
const AT = '2026-11-01 00:08 ET';
const launched: OrderTraceJob = { id: 'RQ-PHX-FAKE01', lane: 'devin', state: 'launched', url: null };
const traceWithLaunchedJob: OrderTraceV1 = {
  v: 1, generatedAt: NOW, sources: { inbox: null, prompts: null, publishes: null },
  orders: [{ at: AT, source: 'Phantom desktop', key: '11-01 00:08', jobs: [launched] }],
};

describe('launched job wording (416c)', () => {
  it('reports the launch without claiming current liveness', () => {
    expect(stateWord(launched)).toBe('launched');
    expect(stateWord(launched)).not.toContain('running');
  });

  it('preserves queued, published and merged words', () => {
    const url = 'https://github.com/ashlrai/phantom/pull/77';
    expect(stateWord({ ...launched, state: 'queued' })).toBe('queued');
    expect(stateWord({ ...launched, state: 'published' })).toBe('published');
    expect(stateWord({ ...launched, state: 'published', url })).toBe('PR #77');
    expect(stateWord({ ...launched, state: 'merged', url })).toBe('merged #77');
  });

  it('keeps the interject receipt text consistent with its ASSIGNED badge', () => {
    const outcome = interjectOutcome(AT, false, traceWithLaunchedJob, NOW);
    expect(outcome.text).toBe('job RQ-PHX-FAKE01 launched');
    expect(outcome.text).not.toContain('running');
    expect(outcome.contract.state).toBe('ASSIGNED');
  });

  it('preserves cited-job counts for launched jobs', () => {
    expect(citedJobsLine([launched], null)).toBe('1 jobs cite this order · 0 published · 0 open PRs');
    expect(citedJobsLine([
      launched,
      { ...launched, id: 'RQ-PHX-PUBLISHED', state: 'published' },
      { ...launched, id: 'RQ-PHX-PR', state: 'published', url: 'https://github.com/ashlrai/phantom/pull/77' },
    ], 5)).toBe('3 jobs cite this order · 1 published · 1 open PRs');
  });
});
