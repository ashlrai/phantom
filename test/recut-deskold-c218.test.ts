import { describe, expect, it } from 'vitest';
import { applyMention, busTargets, mentionCandidates } from '../src/web-ui/routes/verse/fleet-bus/bus-targets-model.js';

// RQ-PHX-RECUTDESKOLDC218 recut of PR #2906: the Runs input is narrowed to the
// fields the model actually reads, so callers and tests pass minimal
// { lane } / { job, ageSeconds } shapes instead of a full FleetRuns snapshot.
const runs = {
  lanes: [{ lane: 'lane-a' }, { lane: 'leaders' }],
  workers: [{ job: 'RQ-OLD', ageSeconds: 90 }, { job: 'RQ-NEW', ageSeconds: 1 }],
};

describe('bus targets minimal snapshot (recut of #2906)', () => {
  it('orders workers by recency and dedupes addresses across groups', () => {
    expect(busTargets({ runs, senders: ['RQ-OLD', 'sender', 'sender'] })).toEqual([
      { group: 'Leaders', items: ['leaders'] },
      { group: 'Lanes', items: ['lane-a'] },
      { group: 'Workers', items: ['RQ-NEW', 'RQ-OLD'] },
      { group: 'Recent senders', items: ['sender'] },
    ]);
    expect(busTargets({ runs: null, senders: ['agent'] })[3].items).toEqual(['agent']);
  });

  it('matches case-insensitive mention prefixes against minimal workers', () => {
    expect(mentionCandidates('hello @rq-n tail', 11, runs)).toEqual({ query: 'rq-n', items: ['RQ-NEW'] });
    expect(mentionCandidates('@', 1, runs)?.items).toEqual(['RQ-NEW', 'RQ-OLD']);
    expect(mentionCandidates('@none', 5, runs)?.items).toEqual([]);
  });

  it('replaces the whole mention token at the caret', () => {
    expect(applyMention('@RQ', 3, 'RQ-NEW')).toEqual({ text: '@RQ-NEW ', caret: 8 });
  });
});
