import { expect, it } from 'vitest';
import { collectDigestFacts, planChangeDigest, type DigestSources } from '../src/core/comms/change-digest.js';

const now = Date.parse('2001-02-03T04:05:06Z');
const sources: DigestSources = {
  ledger: async () => [{ kind: 'pr:opened', at: new Date(now).toISOString(), repo: 'example/repo', data: { number: 1 } }],
  fleetTruth: async (sinceMs, nowMs) => ({
    windowStartMs: sinceMs, windowEndMs: nowMs!, merged: [], mergeCountState: 'ok', truncated: false,
    running: 2, queued: 3, blocked: 4,
  }),
  appliedProposals: () => [], proposalTitle: () => null, cloudTasks: () => [],
  capacity: () => null, memos: () => [], autonomy: () => ({ on: true, mode: 'test' }),
};

it('uses the supplied observation time for the collected and rendered load evidence', async () => {
  let observed: number | undefined;
  const facts = await collectDigestFacts(now - 60_000, {
    ...sources, loadLine: (time) => { observed = time; return `Blocked at ${new Date(time).toISOString()}`; },
  }, now);
  expect(observed).toBe(now);
  expect(facts.loadLine).toBe('Blocked at 2001-02-03T04:05:06.000Z');
  expect(planChangeDigest(null, facts, now).text).toContain(facts.loadLine);
  expect(facts.fleet).toEqual({ running: 2, queued: 3, blocked: 4 });
});

it.each([() => null, () => { throw new Error('unavailable'); }])(
  'keeps other facts when load evidence is unavailable', async (loadLine) => {
    const facts = await collectDigestFacts(now - 60_000, { ...sources, loadLine }, now);
    expect(facts.loadLine).toBeNull();
    expect(facts.events).toHaveLength(1);
    expect(facts.fleet).toEqual({ running: 2, queued: 3, blocked: 4 });
  },
);

it('uses current time when no observation time is supplied', async () => {
  let observed = 0;
  const before = Date.now();
  await collectDigestFacts(now, { ...sources, loadLine: (time) => { observed = time; return null; } });
  expect(observed).toBeGreaterThanOrEqual(before);
  expect(observed).toBeLessThanOrEqual(Date.now());
});
