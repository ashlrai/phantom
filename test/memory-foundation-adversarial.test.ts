import { describe, expect, it } from 'vitest';
import { buildMemoryContextPack } from '../src/core/memory/pack.js';
import type { MemoryFactEvent, MemoryPackQuery, MemorySnapshot } from '../src/core/memory/types.js';

// Independent adversarial review of the reviewed-memory kernel (PR #719).
const early = '2026-10-01T00:00:00.000Z';
const mid = '2026-10-05T00:00:00.000Z';
const late = '2026-10-10T00:00:00.000Z';
const now = '2026-10-14T00:00:00.000Z';
function event(overrides: Partial<MemoryFactEvent> = {}): MemoryFactEvent {
  return { schemaVersion: 1, eventId: 'ev_a', factId: 'fact_a', revision: 1, kind: 'fact', projectId: 'project_a', ownerId: 'owner_a',
    audienceIds: ['team_a'], subjectKey: 'deploy', slotKey: 'region', text: 'Deploy to us-east-1.',
    sourceRefs: [{ id: 'src_a', digest: 'sha256_' + 'a'.repeat(64), locator: 'line:1', quote: 'us-east-1', observedAt: early }],
    observedAt: early, validFrom: early, validUntil: null, recordedAt: early, reviewState: 'approved', reviewedAt: early,
    reviewerDecisionId: 'review_a', supersedes: [], derivedFrom: [], tombstones: [], authority: false, ...overrides };
}
function tombstone(targets: string[], overrides: Partial<MemoryFactEvent> = {}): MemoryFactEvent {
  return event({ eventId: 'ev_delete', factId: 'delete', kind: 'tombstone', text: '', tombstones: targets,
    validFrom: late, recordedAt: late, reviewedAt: late, ...overrides });
}
const snapshot = (events: MemoryFactEvent[]): MemorySnapshot => ({ schemaVersion: 1, snapshotId: 'snapshot_a', revision: 1,
  recordedThrough: now, sourceState: 'available', complete: true, events, authority: false });
const query = (overrides: Partial<MemoryPackQuery> = {}): MemoryPackQuery => ({ schemaVersion: 1, projectId: 'project_a', ownerId: 'owner_a',
  audienceId: 'team_a', time: { mode: 'current', at: now }, knownAt: null, query: 'deploy region', maxBytes: 6144, maxFacts: 8, authority: false, ...overrides });
const selected = (events: MemoryFactEvent[], overrides: Partial<MemoryPackQuery> = {}): string[] =>
  buildMemoryContextPack(snapshot(events), query(overrides)).receipt.selectedEventIds;

describe('reviewed deletion applies to every admissible target', () => {
  it('a tombstone naming an extra unreviewed event still deletes its approved target', () => {
    const draft = event({ eventId: 'ev_draft', factId: 'draft', reviewState: 'proposed', reviewedAt: null, reviewerDecisionId: null });
    expect(selected([event(), draft, tombstone(['ev_a'])])).toEqual([]);
    expect(selected([event(), draft, tombstone(['ev_a', 'ev_draft'])])).toEqual([]);
  });
  it('a tombstone naming a missing or foreign event still deletes its admitted target', () => {
    expect(selected([event(), tombstone(['ev_a', 'ev_missing'])])).toEqual([]);
    const foreign = event({ eventId: 'ev_foreign', factId: 'foreign', audienceIds: ['team_b'], subjectKey: 'other' });
    expect(selected([event(), foreign, tombstone(['ev_a', 'ev_foreign'])])).toEqual([]);
    // The foreign target is not deleted for its own audience: deletion never widens scope.
    expect(selected([event(), foreign, tombstone(['ev_a', 'ev_foreign'])], { audienceId: 'team_b', query: '' })).toEqual(['ev_foreign']);
  });
  it('a current tombstone is not undone by a knowledge cutoff that predates one of its targets', () => {
    const later = event({ eventId: 'ev_later', factId: 'later', subjectKey: 'other', recordedAt: late, reviewedAt: late });
    expect(selected([event(), later, tombstone(['ev_a', 'ev_later'], { recordedAt: now, reviewedAt: now })], { knownAt: mid })).toEqual([]);
  });
});

describe('an admitted but unusable correction never falls back to the value it replaces', () => {
  it('a correction that also names an unreviewed predecessor does not serve the stale value', () => {
    const draft = event({ eventId: 'ev_draft', factId: 'fact_a', revision: 1, reviewState: 'proposed', reviewedAt: null, reviewerDecisionId: null,
      text: 'Deploy to eu-west-1.' });
    const fix = event({ eventId: 'ev_fix', revision: 2, text: 'Deploy to us-west-2.', validFrom: mid, recordedAt: mid, reviewedAt: mid,
      supersedes: ['ev_a', 'ev_draft'] });
    const pack = buildMemoryContextPack(snapshot([event(), draft, fix]), query());
    expect(pack.receipt.selectedEventIds).not.toContain('ev_a');
    expect(pack.text).not.toContain('us-east-1');
  });
  it('a backdated correction is refused rather than silently serving the claim it corrects', () => {
    const original = event({ validFrom: mid, recordedAt: mid, reviewedAt: mid });
    const backdated = event({ eventId: 'ev_fix', revision: 2, text: 'Deploy to us-west-2.', validFrom: early, recordedAt: late, reviewedAt: late,
      supersedes: ['ev_a'] });
    expect(selected([original, backdated])).not.toContain('ev_a');
  });
  it('an invalid correction from another slot or audience cannot suppress an unrelated fact', () => {
    const otherSlot = event({ eventId: 'ev_x', factId: 'other', revision: 2, subjectKey: 'billing', slotKey: 'plan', text: 'Plan is team.',
      validFrom: mid, recordedAt: mid, reviewedAt: mid, supersedes: ['ev_a'] });
    expect(selected([event(), otherSlot])).toContain('ev_a');
    expect(selected([event(), { ...otherSlot, audienceIds: ['team_a', 'team_b'] }])).toContain('ev_a');
  });
});

describe('deletion never turns unusable lineage into a valid decision', () => {
  it('tombstoning an invalid withdrawal does not revoke the fact it named', () => {
    const withdrawal = event({ eventId: 'ev_w', revision: 2, reviewState: 'withdrawn', validFrom: mid, recordedAt: mid, reviewedAt: mid,
      derivedFrom: ['ev_missing'] });
    expect(selected([event(), withdrawal])).toEqual(['ev_a']);
    expect(selected([event(), withdrawal, tombstone(['ev_w'])])).toEqual(['ev_a']);
  });
});
