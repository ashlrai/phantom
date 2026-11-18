import { describe, expect, it } from 'vitest';
import { claimsByOwner, orgExecutives } from './org-roster.js';

const office = {
  roles: [
    { id: 'leader', title: 'Digital co-founder', owner: 'leader', lane: 'frontier' },
    { id: 'engineering', title: 'Engineering', owner: 'engineering', lane: 'work' },
    { id: 'review', title: 'Review', owner: 'review', lane: 'mid' },
    { id: 'release', title: 'Release', owner: 'release', lane: 'work' },
  ],
  priorities: [
    { rq: 'RQ-A-1', owner: 'engineering', status: 'in_progress', due: null, outcome: null },
    { rq: 'RQ-A-2', owner: 'engineering', status: 'proposed', due: null, outcome: null },
    { rq: 'RQ-A-3', owner: 'review', status: 'blocked', due: null, outcome: null },
    { rq: 'RQ-A-4', owner: 'release', status: 'done', due: null, outcome: null },
  ],
  latestReply: null,
};
const roster = {
  schema: 'agent-roster.v1',
  claims: { source: 'claim-store', items: [
    { owner: 'claude', completed: false }, { owner: 'claude', completed: false },
    { owner: 'claude', completed: true }, { owner: 'grok', completed: false },
  ] },
};
describe('orgExecutives', () => {
  it('lists every office role except the leader', () => {
    expect(orgExecutives(office)!.map(e => e.name)).toEqual(['Engineering', 'Review', 'Release']);
  });

  it('derives executive status from open priorities only', () => {
    const [eng, review, release] = orgExecutives(office)!;
    expect(eng).toMatchObject({ status: 'working', detail: '1 active, 1 proposed', lane: 'work' });
    expect(review).toMatchObject({ status: 'blocked', detail: '1 blocked' });
    expect(release).toMatchObject({ status: 'idle', detail: null });
  });

  it('keeps ids unique and avatars deterministic with initials', () => {
    const execs = orgExecutives(office)!;
    expect(new Set(execs.map(m => m.id)).size).toBe(execs.length);
    expect(execs[0]!.avatar).toMatchObject({ initials: 'EN', imageSrc: null });
    expect(orgExecutives(office)![0]!.avatar).toEqual(execs[0]!.avatar);
  });

  it('reports a down office as unavailable, not as an empty team', () => {
    expect(orgExecutives(null)).toBeNull();
    expect(orgExecutives({ ...office, roles: [] })).toEqual([]);
  });
});

describe('claimsByOwner', () => {
  it('counts open claims per owner and rejects other schemas', () => {
    expect(claimsByOwner(roster)).toEqual(new Map([['claude', 2], ['grok', 1]]));
    expect(claimsByOwner({ schema: 'agent-roster.v1' })).toBeNull();
    expect(claimsByOwner(undefined)).toBeNull();
  });
});
