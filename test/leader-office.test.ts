import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireWorkClaim } from '../src/core/agents/work-visibility.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { WorldModel } from '../src/core/world/types.js';
import {
  acceptOwnerMessage,
  classifyEscalation,
  DEFAULT_LEADER_ORG,
  leaderAsk,
  leaderAssign,
  leaderOrg,
  leaderStatus,
  loadLeaderOrg,
  readLeaderOutbox,
  type LeaderOfficeDeps,
} from '../src/core/agents/leader-office.js';

const NOW = Date.parse('2026-11-09T07:10:00.000Z');
let root: string;

function field<T>(value: T | null): { value: T | null; source: string | null; observedAt: string | null; freshness: 'fresh' | 'unknown' } {
  return { value, source: value === null ? null : 'test', observedAt: '2026-11-09T07:10:00.000Z', freshness: value === null ? 'unknown' : 'fresh' };
}

function world(): WorldModel {
  return {
    schema: 'ashlr.world-model/v1',
    generatedAt: '2026-11-09T07:10:00.000Z',
    readOnly: true,
    cache: { hit: false, ageMs: 0, ttlMs: 15_000 },
    sensors: { lanes: [{
      lane: 'work', headroom: field(null), used: field(null), limit: field(null), remaining: field(null),
      burnRate: field(null), idleIncludedWastedPerWeek: field(null), pacePerHour: field(1),
      requiredPacePerHour: field(1), runwayHours: field(2),
    }] },
    roster: { sessions: field(null), sources: [] },
    claims: { live: field(null) },
    bus: { readable: field(true) },
    queue: { ready: field(null), claimed: field(null) },
    ci: { repos: field(null), medianDailyTtgSeconds: field(null) },
    releases: { updateCheck: field(null), train: field(null) },
    bottlenecks: { count: field(null) },
    humanSteps: { remaining: field(null) },
    outcomes: { repos: [] },
    blindSpots: [{ id: 'queue-ready', path: 'queue.ready', freshness: 'unknown', need: 'a queue reading' }],
  };
}

function deps(extra: Partial<LeaderOfficeDeps> = {}): LeaderOfficeDeps & { reads: number } {
  const bag: LeaderOfficeDeps & { reads: number } = {
    reads: 0,
    root, busRoot: root, claimRoot: root, now: () => NOW, pulls: [],
    killed: () => false,
    grant: () => ({ mode: 'apply', reason: 'standing-grant' }),
    readWorld: async () => { bag.reads += 1; return world(); },
    ...extra,
  };
  if (extra.readWorld) bag.readWorld = extra.readWorld;
  else bag.readWorld = async () => { bag.reads += 1; return world(); };
  return bag;
}

function busTo(to: string): unknown[] {
  const page = listBusInboxAfter(0, 20, { root, now: () => NOW });
  if (page.status !== 'ok') return [];
  return page.messages.filter((row) => row.envelope.to === to);
}

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('leader office escalation', () => {
  it('classifies only the hard-limit categories', () => {
    expect(classifyEscalation('rotate the API key')?.category).toBe('secrets');
    expect(classifyEscalation('raise the paid plan')?.category).toBe('money');
    expect(classifyEscalation('email the customer our status')?.category).toBe('outside-send');
    expect(classifyEscalation("delete Mason's documents")?.category).toBe('owner-data-destruction');
    expect(classifyEscalation('fix the flaky test in phantom')).toBeNull();
    expect(classifyEscalation('review the leader panel and open a pr')).toBeNull();
    expect(classifyEscalation('the mutation token refreshes the session')).toBeNull();
  });
});

describe('leader office decisions', () => {
  it('routes ordinary work on the bus through the org lane and reads the world once', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    const options = deps();
    const decision = await leaderAsk({ text: 'fix the flaky test' }, options);
    expect(options.reads).toBe(1);
    expect(decision.status).toBe('routed');
    expect(decision.world.schema).toBe('ashlr.world-model/v1');
    expect(decision.world.blindSpotCount).toBe(1);
    expect(decision.context?.lane).toBe('leader');
    expect(decision.route).toMatchObject({ via: 'existing-router', tier: 'work', roleId: 'engineering', spend: 'none' });
    expect(busTo('engineering')).toHaveLength(1);
    expect(busTo('owner').map((row) => (row as { envelope: { from: string } }).envelope.from)).toEqual(['leader']);
    expect(busTo('leader')).toHaveLength(1);
  });

  it('assigns an RQ with owner, due, status and outcome, and claims it', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    const decision = await leaderAssign({
      rq: 'RQ-LEADER-CEO-1', owner: 'engineering', summary: 'Build the leader office',
      due: '2026-11-10', outcome: 'panel merged',
    }, deps());
    expect(decision.status).toBe('routed');
    expect(decision.assignment).toMatchObject({
      rq: 'RQ-LEADER-CEO-1', owner: 'engineering', due: '2026-11-10', status: 'assigned', outcome: 'panel merged', lane: 'work',
    });
    const done = await leaderAssign({
      rq: 'RQ-LEADER-CEO-1', owner: 'engineering', summary: 'Build the leader office', status: 'done',
    }, deps());
    expect(done.assignment?.status).toBe('done');
    expect((await leaderStatus(deps())).priorities ?? []).toEqual([]);
  });

  it('escalates a hard limit to the owner and does not hand it to a worker', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    const decision = await acceptOwnerMessage({ text: 'rotate the API key sk-TEST-abcdefghijklmnopqrst' }, deps());
    expect(decision.status).toBe('escalated');
    expect(decision.escalation?.category).toBe('secrets');
    expect(decision.route).toBeNull();
    expect(busTo('engineering')).toHaveLength(0);
    expect(busTo('owner')).toHaveLength(1);
    const outbox = readLeaderOutbox({ root });
    expect(outbox.entries[0]?.text).toContain('secrets/keys');
    expect(JSON.stringify(outbox)).not.toContain('sk-TEST-abcdefghijklmnopqrst');
    expect(readFileSync(join(root, 'office.json'), 'utf8')).not.toContain('sk-TEST-abcdefghijklmnopqrst');
  });

  it('stops ask and assign when KILL is on, without writing or posting', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    const options = deps({ killed: () => true });
    const asked = await leaderAsk({ text: 'fix the flaky test' }, options);
    const assigned = await leaderAssign({ rq: 'RQ-LEADER-CEO-1', owner: 'engineering', summary: 'Build it' }, options);
    expect(asked.status).toBe('stopped');
    expect(assigned.status).toBe('stopped');
    expect(options.reads).toBe(2);
    expect(listBusInboxAfter(0, 10, { root, now: () => NOW }).status === 'ok'
      ? listBusInboxAfter(0, 10, { root, now: () => NOW }) : { messages: [] }).toMatchObject({ messages: [] });
    expect(() => readFileSync(join(root, 'office.json'), 'utf8')).toThrow();
  });

  it('records a proposal and stays off the bus without a standing grant', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    const decision = await leaderAsk({ text: 'fix the flaky test RQ-OFFICE-GRANT-1' }, deps({
      grant: () => ({ mode: 'propose', reason: 'no-standing-grant' }),
    }));
    expect(decision.status).toBe('proposed');
    expect(decision.assignment?.status).toBe('proposed');
    expect(decision.bus.ids).toEqual([]);
    expect(listBusInboxAfter(0, 10, { root, now: () => NOW })).toMatchObject({ status: 'ok', messages: [] });
  });

  it('does not take a work key another lane already holds', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    expect(acquireWorkClaim({ workKey: 'RQ-HELD-1', lane: 'review', root, now: NOW }).status).toBe('acquired');
    const decision = await leaderAssign({ rq: 'RQ-HELD-1', owner: 'engineering', summary: 'fix the test' }, deps());
    expect(decision.status).toBe('blocked');
    expect(decision.holder?.lane).toBe('review');
    expect(busTo('engineering')).toHaveLength(0);
  });

  it('refuses an unknown role and an invalid org file', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    expect((await leaderAssign({ rq: 'RQ-NO-ROLE-1', owner: 'finance', summary: 'fix the test' }, deps())).status).toBe('refused');
    writeFileSync(join(root, 'org.json'), '{', { mode: 0o600 });
    expect(loadLeaderOrg({ root })).toMatchObject({ ok: false, reason: 'invalid-org' });
    expect(leaderOrg({ root })).toMatchObject({ status: 'refused' });
  });

  it('prints the org as json and rejects a bare assign', async () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runLeaderCli } = await import('../src/cli/leader.js');
    expect(await runLeaderCli(['assign'])).toBe(2);
    expect(await runLeaderCli(['org', '--json'])).toBe(0);
    expect(logs.join('\n')).toContain('"schema": "phantom.leader-org/v1"');
    log.mockRestore();
    error.mockRestore();
  });

  it('ships the declarative org chart the bundled file describes', () => {
    root = mkdtempSync(join(tmpdir(), 'leader-office-'));
    const loaded = loadLeaderOrg({ root: join(root, 'missing') });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.org).toEqual(DEFAULT_LEADER_ORG);
    expect(loaded.org.roles.map((role) => role.lane).sort()).toEqual(['fast', 'frontier', 'mid', 'work', 'work']);
    expect(loaded.org.coordinatesWith.map((peer) => peer.rq)).toEqual(['RQ-SHARED-VISIBILITY-1', 'RQ-COMMS-UNIFIED-1']);
    const status = leaderOrg({});
    expect(status).toMatchObject({ source: 'bundled' });
  });
});
