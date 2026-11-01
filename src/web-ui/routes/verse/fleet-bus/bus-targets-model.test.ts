import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { applyMention, busTargets, mentionCandidates } from './bus-targets-model.js';

const runs = { lanes: [{ lane: 'lane-a' }, { lane: 'leaders' }, { lane: 'bad lane' }], workers: [
  { job: 'RQ-OLD', ageSeconds: 90 }, { job: 'RQ-NEW', ageSeconds: 1 }, { job: 'lane-a', ageSeconds: 3 },
  { job: 'RQ-NEW', ageSeconds: 2 }, { job: 'bad\n', ageSeconds: 4 }, { job: 'x'.repeat(129), ageSeconds: 5 },
] } as FleetRuns;

describe('bus targets', () => {
  it('orders and deduplicates valid addresses across groups', () => {
    expect(busTargets({ runs, senders: ['RQ-OLD', 'sender', 'sender', '', 'bad sender'] })).toEqual([
      { group: 'Leaders', items: ['leaders'] }, { group: 'Lanes', items: ['lane-a'] },
      { group: 'Workers', items: ['RQ-NEW', 'RQ-OLD'] }, { group: 'Recent senders', items: ['sender'] },
    ]);
    expect(busTargets({ runs: null, senders: ['agent'] })[3].items).toEqual(['agent']);
  });
  it('matches case-insensitive prefixes at the caret and caps results', () => {
    expect(mentionCandidates('hello @rq-n tail', 11, runs)).toEqual({ query: 'rq-n', items: ['RQ-NEW'] });
    expect(mentionCandidates('hello@RQ', 8, runs)).toBeNull();
    const many = { lanes: [], workers: Array.from({ length: 12 }, (_, i) => ({ job: `RQ-${i}`, ageSeconds: i })) } as FleetRuns;
    expect(mentionCandidates('@', 1, many)?.items).toHaveLength(8);
    expect(mentionCandidates('@none', 5, runs)?.items).toEqual([]);
  });
  it('replaces the whole mention at the beginning or inside text', () => {
    expect(applyMention('@RQ', 3, 'RQ-NEW')).toEqual({ text: '@RQ-NEW ', caret: 8 });
    expect(applyMention('ask @RQ-old next', 7, 'RQ-NEW')).toEqual({ text: 'ask @RQ-NEW  next', caret: 12 });
    expect(applyMention('plain', 5, 'RQ-NEW')).toEqual({ text: 'plain', caret: 5 });
  });
});
