/**
 * Ops API (the desktop command center) : route-shape and projection tests.
 * Every source is a fixture injected through OpsApiDeps: no real ~/.ashlr,
 * no git or gh, no network. Covers all four GETs, the leaders POST, and the
 * shared gates (dispatch flag, mutation token, strict bodies and queries).
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createOpsApi, type OpsApiDeps } from '../src/core/verse/ops-api.js';
import {
  VERSE_OPS_BOARD_PATH,
  VERSE_OPS_FLEET_PATH,
  VERSE_OPS_LEADERS_MESSAGES_PATH,
  VERSE_OPS_LEADERS_PATH,
  VERSE_OPS_RELEASES_PATH,
  type OpsBoardV1,
  type OpsFleetV1,
  type OpsLeadersV1,
  type OpsReleasesV1,
} from '../src/core/verse/ops-types.js';
import type { FleetTask } from '../src/core/fleet/fleet-types.js';
import type { DispatchJournalRecord, FleetTickStateV1 } from '../src/core/fleet/fleet-runtime-journal.js';
import type { TeamEvent } from '../src/core/teams/protocol.js';
import type { CompanionList } from '../src/core/proactive/coordination-types.js';
import type { LearningStateV1 } from '../src/core/learn/harness-types.js';

const TOKEN = 'ops-test-token';
const NOW = Date.parse('2026-10-30T10:00:00Z');

function fleetTask(over: Partial<FleetTask> = {}): FleetTask {
  return {
    v: 1, id: 'task-1', repo: 'ashlrai/phantom', source: 'leader', title: 'Fix the gate', detail: '',
    difficulty: 'medium', value: 50, requestedBy: 'leader', goalId: null, landingId: null,
    insightId: null, dedupeKey: null, status: 'dispatched', sizeBudget: { files: 3, lines: 200 },
    attempts: 1, parkedUntil: null, createdAt: '2026-10-30T08:00:00Z', updatedAt: '2026-10-30T09:00:00Z',
    ...over,
  };
}

function dispatch(over: Partial<DispatchJournalRecord> = {}): DispatchJournalRecord {
  return {
    v: 1, type: 'dispatch', at: '2026-10-30T09:30:00Z', itemId: 'i1', taskId: 'task-1', runId: 'r1',
    repo: 'ashlrai/phantom', title: 'Fix the gate', source: 'fleet', backend: null, model: null,
    lane: 'codex', seatId: 'seat-codex-1', dispatched: true, skipReason: null, proposalId: null,
    spentUsd: 0.12,
    seatDecision: { seatId: 'seat-codex-1', candidates: ['seat-codex-1'], exclusions: [], why: 'Codex had quota.', summary: 'Codex seat 1.', mode: 'balanced' },
    hold: null,
    ...over,
  };
}

function teamEvent(actorId: string, type: TeamEvent['type'], payload: Record<string, unknown>, seq: number, ts = '2026-10-30T09:00:00Z'): TeamEvent {
  const agent = actorId.startsWith('agent:');
  return { v: 1, id: `e${seq}`, team: 'default', ts, actor: { kind: agent ? 'agent' : 'human', id: actorId, ...(agent ? { provider: actorId.slice(6).split('/')[0], onBehalfOf: 'human:mason' } : {}) }, type, payload };
}

const TICK: FleetTickStateV1 = {
  v: 1, at: '2026-10-30T10:00:00Z', capabilityKind: null, dryRun: false, standing: null,
  lanes: [{ lane: 'codex', slots: 2, busy: 1, capReason: null }],
  presence: { present: true, reason: 'Terminal focused recently', evidenceAt: '2026-10-30T09:59:00Z' },
  holdProduction: null, pausedRepos: [], waitingVerify: null, openPrsByRepo: null, ledgerHead: null,
  held: [{ itemId: 'i9', repo: 'ashlrai/hub', title: 'Parked work', hold: { kind: 'budget', reason: 'Daily cap reached', nextEligibleAt: null }, seatDecision: null, at: '2026-10-30T09:50:00Z' }],
  watch: { available: false, reason: 'no gh' },
};

function events(): TeamEvent[] {
  return [
    teamEvent('human:mason', 'member.joined', { role: 'owner' }, 1),
    teamEvent('agent:grok-bot/mason', 'agent.registered', { capabilities: ['leader'] }, 2, '2026-10-30T09:01:00Z'),
    teamEvent('agent:grok-bot/mason', 'agent.registered', { capabilities: ['leader'] }, 3, '2026-10-30T09:01:30Z'),
    teamEvent('human:mason', 'message.posted', { channel: 'leaders', text: 'Hold the fleet until the release lands.' }, 4, '2026-10-30T09:10:00Z'),
    teamEvent('human:mason', 'message.posted', { channel: 'general', text: 'General chatter.' }, 5, '2026-10-30T09:11:00Z'),
    teamEvent('human:mason', 'handoff.requested', { to: 'agent:grok-bot/mason', title: 'Prep the changelog', detail: '' }, 6, '2026-10-30T09:20:00Z'),
    teamEvent('agent:grok-bot/mason', 'handoff.accepted', { handoffId: 'e6' }, 7, '2026-10-30T09:25:00Z'),
    teamEvent('agent:grok-bot/mason', 'handoff.completed', { handoffId: 'e6', result: 'Changelog drafted in #505' }, 8, '2026-10-30T09:40:00Z'),
    teamEvent('agent:codex/mason', 'handoff.requested', { title: 'Merge the release', detail: '', action: 'merge' }, 9, '2026-10-30T09:45:00Z'),
    teamEvent('agent:codex/mason', 'approval.requested', { handoffId: 'e9' }, 10, '2026-10-30T09:46:00Z'),
  ];
}

const LEARNING: LearningStateV1 = {
  v: 1, generatedAt: '2026-10-30T10:00:00Z', active: null, canary: null, versions: [],
  experiments: [{
    v: 1, id: 'exp-07', hypothesisId: 'hyp-3', baseVersionId: 'h-0004', candidateVersionId: 'h-0007',
    taskSet: { id: 'ts1', digest: 'd' }, status: 'done', pairs: 40, wins: 24, losses: 12, ties: 4,
    lift: { mean: 6.2, ciLow: 1.1, ciHigh: 11.3, level: 0.95 }, refuseRegression: false,
    claimedChangeNoneMadeDelta: -1, costDeltaPct: 3.5, verdict: 'adopt',
    reasons: ['Candidate beat the baseline.'], startedAt: '2026-10-20T00:00:00Z', finishedAt: '2026-10-28T00:00:00Z',
  }],
  hypotheses: [],
};

const COMPANIONS: CompanionList = {
  sourceState: 'healthy', revision: 1,
  tasks: [{
    tenantId: 't', projectBindingId: 'proj-1', taskKey: 'k1', goal: 'Run nightly checks',
    acceptance: [], packetDigest: 'sha256:x', capabilityIds: [], deadline: '2026-10-31T00:00:00Z',
    maxCostUsd: 2, maxAttempts: 2, id: 'ct-1', createdAt: '2026-10-30T08:00:00Z', updatedAt: '2026-10-30T08:30:00Z',
    state: 'assigned',
    attempts: [{ id: 'a1', epoch: 1, assignee: { provider: 'devin', accountId: 'acct-1', agentId: 'agent-9' }, ownerId: 'op', claimedAt: '2026-10-30T08:20:00Z', leaseExpiresAt: '2026-10-30T12:20:00Z', packetDigest: 'sha256:x', contact: 'accepted', handoffAt: null, cancelRequestedAt: null, providerRunId: null, observationReference: null }],
    reports: [], verifications: [], events: [], notification: null,
  }],
};

function deps(over: Partial<OpsApiDeps> = {}): OpsApiDeps {
  return {
    now: () => NOW,
    fleetTasks: () => ({ ok: true, tasks: [fleetTask()] }),
    teamEvents: () => events(),
    companions: () => COMPANIONS,
    tick: () => TICK,
    journal: async () => [dispatch()],
    learning: () => LEARNING,
    enrolled: () => ['/repos/phantom'],
    releases: async () => [{
      repo: 'ashlrai/phantom', path: '/repos/phantom', version: '3.16.2', latestTag: 'v3.16.2',
      releaseWorkflow: 'release.yml',
      gh: { latestRelease: { tag: 'v3.16.2', name: 'Phantom', publishedAt: '2026-10-29T08:00:00Z', draft: false, prerelease: false }, latestRun: { workflow: 'release.yml', status: 'completed', conclusion: 'success', at: '2026-10-29T08:10:00Z' } },
      notes: [],
    }],
    postMessage: (_team, _text) => ({ ok: true }),
    ...over,
  };
}

async function request(api: ReturnType<typeof createOpsApi>, options: { path: string; method?: string; body?: unknown; token?: string; allowDispatch?: boolean; raw?: string }): Promise<{ handled: boolean; status: number; wire: Record<string, unknown> | null }> {
  const req = Readable.from(options.method === 'GET' || !options.method ? [] : [options.raw ?? JSON.stringify(options.body ?? {})]) as unknown as IncomingMessage;
  req.url = options.path;
  req.method = options.method ?? 'GET';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': options.token ?? TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: options.allowDispatch ?? true } as VerseApiContext;
  const handled = await api(ctx, req, res, options.path.split('?')[0]!, options.method ?? 'GET');
  return { handled, status, wire };
}

describe('ops api', () => {
  it('returns false for paths outside the family', async () => {
    const api = createOpsApi(deps());
    expect((await request(api, { path: '/api/verse/leader/thread' })).handled).toBe(false);
  });

  it('folds fleet tasks, handoffs and companion work into board columns with assignee, estimate and outcome', async () => {
    const api = createOpsApi(deps());
    const { status, wire } = await request(api, { path: VERSE_OPS_BOARD_PATH });
    expect(status).toBe(200);
    const board = wire as unknown as OpsBoardV1;
    expect(board.sources).toEqual({ fleet: 'healthy', handoff: 'healthy', companion: 'healthy' });
    // Fleet task: dispatched, assignee resolved from the dispatch journal's seat.
    const ft = board.columns.active.find((r) => r.id === 'fleet:task-1');
    expect(ft).toMatchObject({ source: 'fleet', title: 'Fix the gate', assignee: 'seat-codex-1', estimate: 'medium · ≤3 files / 200 lines' });
    // Completed handoff: outcome text carried through.
    const ho = board.columns.done.find((r) => r.id === 'handoff:e6');
    expect(ho).toMatchObject({ source: 'handoff', title: 'Prep the changelog', assignee: 'agent:grok-bot/mason', outcome: { state: 'completed', text: 'Changelog drafted in #505' } });
    // The approval-gated handoff sits in held and asks for a human.
    const held = board.columns.held.find((r) => r.id === 'handoff:e9');
    expect(held).toMatchObject({ source: 'handoff', needsYou: true });
    // Companion task: assignee is the identity, estimate is the cap.
    const co = board.columns.active.find((r) => r.id === 'companion:ct-1');
    expect(co).toMatchObject({ source: 'companion', assignee: 'devin/acct-1/agent-9' });
    expect(co?.estimate).toContain('cap $2.00');
    expect(board.counts.active).toBe(2);
  });

  it('reports degraded sources on the board instead of a quiet partial read', async () => {
    const api = createOpsApi(deps({ fleetTasks: () => { throw new Error('corrupt'); }, teamEvents: () => { throw new Error('locked'); } }));
    const { status, wire } = await request(api, { path: VERSE_OPS_BOARD_PATH });
    expect(status).toBe(200);
    const board = wire as unknown as OpsBoardV1;
    expect(board.sources.fleet).toBe('degraded');
    expect(board.sources.handoff).toBe('degraded');
    expect(board.sources.companion).toBe('healthy');
  });

  it('projects lanes, held items, seat decisions and A/B results', async () => {
    const api = createOpsApi(deps());
    const { status, wire } = await request(api, { path: VERSE_OPS_FLEET_PATH });
    expect(status).toBe(200);
    const fleet = wire as unknown as OpsFleetV1;
    expect(fleet.lanes).toHaveLength(1);
    expect(fleet.lanes![0]).toMatchObject({ lane: 'codex', slots: 2, busy: 1 });
    expect(fleet.held[0]).toMatchObject({ itemId: 'i9', holdKind: 'budget', reason: 'Daily cap reached' });
    expect(fleet.decisions[0]).toMatchObject({ itemId: 'i1', seatId: 'seat-codex-1', lane: 'codex', dispatched: true, summary: 'Codex seat 1.' });
    expect(fleet.experiments[0]).toMatchObject({ id: 'exp-07', arms: { base: 'h-0004', candidate: 'h-0007' }, verdict: 'adopt', lift: { mean: 6.2, ciLow: 1.1, ciHigh: 11.3 } });
  });

  it('answers null lanes when no tick exists and degraded on a failed journal', async () => {
    const api = createOpsApi(deps({ tick: () => null, journal: async () => { throw new Error('gone'); } }));
    const { wire } = await request(api, { path: VERSE_OPS_FLEET_PATH });
    const fleet = wire as unknown as OpsFleetV1;
    expect(fleet.lanes).toBeNull();
    expect(fleet.tickAt).toBeNull();
    expect(fleet.sources.journal).toBe('degraded');
    expect(fleet.decisions).toEqual([]);
  });

  it('returns per-repo release status through the injected probe', async () => {
    const api = createOpsApi(deps());
    const { status, wire } = await request(api, { path: VERSE_OPS_RELEASES_PATH });
    expect(status).toBe(200);
    const releases = wire as unknown as OpsReleasesV1;
    expect(releases.sourceState).toBe('healthy');
    expect(releases.repos[0]).toMatchObject({ repo: 'ashlrai/phantom', version: '3.16.2', latestTag: 'v3.16.2', releaseWorkflow: 'release.yml' });
    expect(releases.repos[0]!.gh?.latestRelease?.tag).toBe('v3.16.2');
    expect(releases.repos[0]!.gh?.latestRun?.conclusion).toBe('success');
  });

  it('folds the leaders channel from the shared event log', async () => {
    const api = createOpsApi(deps());
    const { status, wire } = await request(api, { path: VERSE_OPS_LEADERS_PATH });
    expect(status).toBe(200);
    const leaders = wire as unknown as OpsLeadersV1;
    expect(leaders.channel).toBe('leaders');
    // Only the leaders-channel message is in the transcript; general is counted, not shown.
    expect(leaders.messages.map((m) => m.id)).toEqual(['e4']);
    expect(leaders.channels).toContainEqual({ channel: 'general', count: 1 });
    // Leaders: the owner and the agent declaring the leader capability.
    expect(leaders.leaders.find((m) => m.id === 'human:mason')?.leader).toBe(true);
    expect(leaders.leaders.find((m) => m.id === 'agent:grok-bot/mason')?.leader).toBe(true);
    expect(leaders.pendingApprovals[0]).toMatchObject({ handoffId: 'e9', action: 'merge' });
    expect(leaders.canPost).toBe(true);
  });

  it('posts to the leaders channel through the shared gate', async () => {
    const posted: { team: string; text: string }[] = [];
    const api = createOpsApi(deps({ postMessage: (team, text) => { posted.push({ team, text }); return { ok: true }; } }));
    expect((await request(api, { path: VERSE_OPS_LEADERS_MESSAGES_PATH, method: 'POST', body: { text: 'Go' }, token: 'wrong' })).status).toBe(401);
    expect((await request(api, { path: VERSE_OPS_LEADERS_MESSAGES_PATH, method: 'POST', body: { text: 'Go' }, allowDispatch: false })).status).toBe(404);
    expect((await request(api, { path: VERSE_OPS_LEADERS_MESSAGES_PATH, method: 'POST', body: { text: '' } })).status).toBe(400);
    expect((await request(api, { path: VERSE_OPS_LEADERS_MESSAGES_PATH, method: 'POST', body: { text: 'x', extra: 1 } })).status).toBe(400);
    const ok = await request(api, { path: VERSE_OPS_LEADERS_MESSAGES_PATH, method: 'POST', body: { text: 'Hold for green' } });
    expect(ok.status).toBe(201);
    expect(posted).toEqual([{ team: 'default', text: 'Hold for green' }]);
  });

  it('refuses the post when the bus rejects the message', async () => {
    const api = createOpsApi(deps({ postMessage: () => ({ ok: false, reason: 'refused' }) }));
    const res = await request(api, { path: VERSE_OPS_LEADERS_MESSAGES_PATH, method: 'POST', body: { text: 'hi' } });
    expect(res.status).toBe(422);
  });

  it('rejects unknown query params and bad team ids', async () => {
    const api = createOpsApi(deps());
    expect((await request(api, { path: `${VERSE_OPS_FLEET_PATH}?x=1` })).status).toBe(400);
    expect((await request(api, { path: `${VERSE_OPS_LEADERS_PATH}?team=bad team!!` })).status).toBe(400);
  });
});
