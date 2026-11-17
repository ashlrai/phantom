import { describe, expect, it } from 'vitest';
import { SEATS_FIXTURE } from '../../../data/agent-roster.fixtures.js';
import { buildOrgRoster, claimsByOwner, laneModel, LEADER_IMAGE, type OrgRosterInput } from './org-roster.js';
import { seatRows } from '../agents/agents-model.js';

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
const runs = {
  lanes: [
    { lane: 'claude', running: 2, target: 8, queued: 1, held: false, heldReason: null },
    { lane: 'codex-personal', running: 0, target: 20, queued: 0, held: true, heldReason: 'quota' },
    { lane: 'grok', running: 0, target: 4, queued: 0, held: false, heldReason: null },
  ],
};
const roster = {
  schema: 'agent-roster.v1',
  claims: { source: 'claim-store', items: [
    { owner: 'claude', completed: false }, { owner: 'claude', completed: false },
    { owner: 'claude', completed: true }, { owner: 'grok', completed: false },
  ] },
};
const base: OrgRosterInput = { office, runs, roster, seats: SEATS_FIXTURE };

describe('buildOrgRoster', () => {
  it('builds one leader, the executives and a teammate per lane', () => {
    const org = buildOrgRoster(base);
    expect(org.leader).toMatchObject({ tier: 'leader', name: 'Leader', role: 'Digital co-founder', lane: 'frontier', status: 'working', detail: '2 running across 3 lanes' });
    expect(org.leader.avatar.imageSrc).toBe(LEADER_IMAGE);
    expect(org.executives.map(e => e.name)).toEqual(['Engineering', 'Review', 'Release']);
    expect(org.teammates.map(t => t.lane)).toEqual(['claude', 'codex-personal', 'grok']);
    expect(org.sources).toEqual({ office: 'live', lanes: 'live', roster: 'live', seats: 'live' });
  });

  it('derives executive status from open priorities only', () => {
    const [eng, review, release] = buildOrgRoster(base).executives;
    expect(eng).toMatchObject({ status: 'working', detail: '1 active, 1 proposed', lane: 'work' });
    expect(review).toMatchObject({ status: 'blocked', detail: '1 blocked' });
    expect(release).toMatchObject({ status: 'idle', detail: null });
  });

  it('derives teammate status, model and claims from lanes, seats and the claim store', () => {
    const [claude, codex, grok] = buildOrgRoster(base).teammates;
    expect(claude).toMatchObject({ status: 'working', detail: '2 of 8 slots, 1 queued', model: 'Opus 5.5', claims: 2 });
    expect(codex).toMatchObject({ status: 'held', detail: 'quota', model: 'GPT-5.5 Codex', claims: 0 });
    // No grok seat in the fixture: the model stays unreported rather than guessed.
    expect(grok).toMatchObject({ status: 'idle', model: null, claims: 1 });
  });

  it('keeps ids unique and avatars deterministic with initials', () => {
    const org = buildOrgRoster(base);
    const ids = [org.leader, ...org.executives, ...org.teammates].map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(org.teammates[0]!.avatar).toMatchObject({ initials: 'CL', imageSrc: null });
    expect(buildOrgRoster(base).teammates[0]!.avatar).toEqual(org.teammates[0]!.avatar);
  });

  it('names every down source and shows nothing invented', () => {
    const org = buildOrgRoster({ office: null, runs: {}, roster: { schema: 'other' }, seats: null });
    expect(org.sources).toEqual({ office: 'unavailable', lanes: 'unavailable', roster: 'unavailable', seats: 'unavailable' });
    expect(org.leader).toMatchObject({ status: 'unknown', detail: null, role: 'Digital co-founder', lane: null });
    expect(org.executives).toEqual([]);
    expect(org.teammates).toEqual([]);
  });

  it('reports an idle fleet as idle, not unknown, and tolerates a missing claim feed', () => {
    const org = buildOrgRoster({ ...base, runs: { lanes: [] }, roster: null });
    expect(org.leader).toMatchObject({ status: 'idle', detail: '0 running across 0 lanes' });
    expect(buildOrgRoster({ ...base, roster: null }).teammates.every(t => t.claims === null)).toBe(true);
  });

  it('survives malformed lane rows', () => {
    const org = buildOrgRoster({ ...base, runs: { lanes: [null, 7, { lane: '' }, { lane: 'claude', running: 'x' }] } });
    expect(org.teammates).toHaveLength(1);
    expect(org.teammates[0]).toMatchObject({ lane: 'claude', status: 'idle', detail: '0 of 0 slots' });
  });
});

describe('claimsByOwner', () => {
  it('counts open claims per owner and rejects other schemas', () => {
    expect(claimsByOwner(roster)).toEqual(new Map([['claude', 2], ['grok', 1]]));
    expect(claimsByOwner({ schema: 'agent-roster.v1' })).toBeNull();
    expect(claimsByOwner(undefined)).toBeNull();
  });
});

describe('laneModel', () => {
  const rows = seatRows(SEATS_FIXTURE);
  it('prefers the lane\'s own seat, then a runnable seat of its engine', () => {
    expect(laneModel('claude', rows)).toBe('Opus 5.5');
    expect(laneModel('codex-primary', rows)).toBe('GPT-5.5 Codex');
    expect(laneModel('local', rows)).toBe('Qwen3-Coder');
  });
  it('does not borrow a signed-out seat or an unknown engine', () => {
    expect(laneModel('devin-flash', rows)).toBeNull();
    expect(laneModel('zai', rows)).toBeNull();
  });
});
