/**
 * Ops API : the command-center projections behind the desktop's Ops section
 * (mounted by verse-api.ts as the `ops` workbench family).
 *
 *   GET  /api/verse/ops/board               → OpsBoardV1
 *   GET  /api/verse/ops/fleet               → OpsFleetV1
 *   GET  /api/verse/ops/releases            → OpsReleasesV1
 *   GET  /api/verse/ops/leaders[?team=]     → OpsLeadersV1
 *   POST /api/verse/ops/leaders/messages    { text } → { ok, event }
 *
 * WHAT THIS IS. The desktop app is the command center, and every pane here
 * is a PROJECTION over the buses the CLI and Telegram already share: the
 * team event log (`phm team`, the MCP team tools, src/core/teams), the fleet
 * task queue and router tick/journal (src/core/fleet), the calibration
 * harness (src/core/learn), and the companion ledger (src/core/proactive).
 * Nothing is re-stored; nothing here can apply, merge, publish or deploy.
 * The leaders POST is the same `message.posted` event `phm team say` writes.
 *
 * POSTURE. GETs sit behind the read-session boundary like every workbench
 * read; POST is 404 unless dispatch is allowed, then the shared mutation
 * gate, then a bounded strict body. Reads never throw: a source that cannot
 * be read reports `degraded` (UNKNOWN), never an empty list. Per-repo probes
 * stay async under the folder-IO rules (ops-releases.ts); ~/.ashlr private
 * state readers are the same synchronous helpers sibling route files use.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { ApiModule } from './api-modules.js';
import type { VerseApiContext } from './verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { ashlrHome } from '../cloud/store.js';
import { listTasks, type TaskQueueRead } from '../fleet/task-source.js';
import {
  readJournalSince,
  readTickState,
  type DispatchJournalRecord,
  type FleetJournalRecord,
  type FleetTickStateV1,
} from '../fleet/fleet-runtime-journal.js';
import type { FleetTask } from '../fleet/fleet-types.js';
import { buildLearningState } from '../learn/harness-registry.js';
import type { LearningStateV1 } from '../learn/harness-types.js';
import { listEnrolled } from '../sandbox/policy.js';
import { DEFAULT_TEAM } from '../teams/tools.js';
import { localHumanActor } from '../teams/identity.js';
import { validId, type TeamEvent } from '../teams/protocol.js';
import { appendEvent, readEvents } from '../teams/store.js';
import { foldTeam, type Handoff, type Member } from '../teams/state.js';
import { createCompanionCoordinator } from '../proactive/coordination.js';
import type { CompanionList, CompanionTask } from '../proactive/coordination-types.js';
import { scrubSecrets } from '../util/scrub.js';
import { fetchOrigin, readSelfUpdateStatus, type SelfUpdateDeps } from './self-update-status.js';
import { probeReleases, type OpsReleaseProbeDeps } from './ops-releases.js';
import {
  OPS_BOARD_JOURNAL_WINDOW_MS,
  OPS_BOARD_TASK_LIMIT,
  OPS_FLEET_DECISION_LIMIT,
  OPS_FLEET_JOURNAL_WINDOW_MS,
  OPS_LEADERS_CHANNEL,
  OPS_LEADERS_MESSAGE_LIMIT,
  OPS_MESSAGE_MAX_CHARS,
  VERSE_OPS_BOARD_PATH,
  VERSE_OPS_FLEET_PATH,
  VERSE_OPS_LEADERS_MESSAGES_PATH,
  VERSE_OPS_LEADERS_PATH,
  VERSE_OPS_PATH,
  VERSE_OPS_RELEASES_PATH,
  VERSE_OPS_SELF_UPDATE_PATH,
  type OpsBoardColumn,
  type OpsBoardV1,
  type OpsFleetV1,
  type OpsLeaderMember,
  type OpsLeaderMessage,
  type OpsLeadersV1,
  type OpsReleasesV1,
  type OpsRouteDecision,
  type OpsSourceState,
  type OpsTaskRow,
  type OpsTaskSource,
} from './ops-types.js';

/** Test seams : production defaults are the real buses, never fixtures. */
export interface OpsApiDeps {
  selfUpdate?: SelfUpdateDeps;
  now?: () => number;
  fleetTasks?: () => TaskQueueRead;
  teamEvents?: (team: string) => TeamEvent[];
  companions?: () => CompanionList;
  tick?: () => FleetTickStateV1 | null;
  journal?: (sinceMs: number) => Promise<FleetJournalRecord[]>;
  learning?: () => LearningStateV1;
  enrolled?: () => string[];
  releases?: (paths: readonly string[]) => Promise<OpsReleasesV1['repos']>;
  postMessage?: (team: string, text: string) => { ok: boolean; reason?: string };
  releaseDeps?: OpsReleaseProbeDeps;
}

// ---------------------------------------------------------------------------
// Small route helpers (the shapes fleet-control-api.ts set)
// ---------------------------------------------------------------------------

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

function queryParam(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): URLSearchParams | null {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return null;
  }
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      sendInvalid(res, `unknown query parameter: ${key}`);
      return null;
    }
  }
  return params;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

const ok = (state: 'healthy' | 'degraded' | 'missing'): OpsSourceState => (state === 'degraded' ? 'degraded' : 'healthy');

// ---------------------------------------------------------------------------
// Board : handoff-schema rows over the three task sources
// ---------------------------------------------------------------------------

const FLEET_COLUMN: Record<FleetTask['status'], OpsBoardColumn> = {
  queued: 'next',
  parked: 'held',
  dispatched: 'active',
  done: 'done',
  failed: 'closed',
  cancelled: 'closed',
};

const HANDOFF_COLUMN: Record<Handoff['state'], OpsBoardColumn> = {
  open: 'next',
  'awaiting-approval': 'held',
  accepted: 'active',
  completed: 'done',
  declined: 'closed',
};

const COMPANION_COLUMN: Record<CompanionTask['state'], OpsBoardColumn> = {
  draft: 'next',
  assigned: 'active',
  'handoff-intent': 'active',
  'needs-attention': 'held',
  reported: 'done',
  verified: 'done',
  'cancel-requested': 'closed',
};

function companionAssignee(task: CompanionTask): string | null {
  const attempt = task.attempts[task.attempts.length - 1];
  if (!attempt) return null;
  const a = attempt.assignee;
  return `${a.provider}/${a.accountId}/${a.agentId}`.slice(0, 160);
}

function fleetEstimate(task: FleetTask): string {
  return `${task.difficulty} · ≤${task.sizeBudget.files} file${task.sizeBudget.files === 1 ? '' : 's'} / ${task.sizeBudget.lines} lines`;
}

function companionEstimate(task: CompanionTask): string | null {
  const parts: string[] = [];
  if (typeof task.maxCostUsd === 'number' && Number.isFinite(task.maxCostUsd)) parts.push(`cap $${task.maxCostUsd.toFixed(2)}`);
  if (task.deadline) parts.push(`due ${task.deadline.slice(0, 10)}`);
  if (task.maxAttempts > 1) parts.push(`≤${task.maxAttempts} attempts`);
  return parts.length ? parts.join(' · ') : null;
}

type BoardDeps = Required<Pick<OpsApiDeps, 'fleetTasks' | 'teamEvents' | 'companions' | 'journal' | 'now'>>;

async function boardRows(deps: BoardDeps, team: string): Promise<{
  rows: OpsTaskRow[];
  sources: Record<OpsTaskSource, OpsSourceState>;
}> {
  const seatByTask = new Map<string, { seatId: string | null; lane: string | null }>();
  const rows: OpsTaskRow[] = [];
  const sources: Record<OpsTaskSource, OpsSourceState> = { fleet: 'degraded', handoff: 'degraded', companion: 'degraded' };

  const finish = (records: FleetJournalRecord[]) => {
    for (const d of records) {
      if (d.type !== 'dispatch') continue;
      if (d.taskId && !seatByTask.has(d.taskId)) seatByTask.set(d.taskId, { seatId: d.seatId, lane: d.lane });
    }

    const queue = safe(deps.fleetTasks);
    if (queue && queue.ok) {
      sources.fleet = 'healthy';
      for (const task of queue.tasks) {
        const seat = seatByTask.get(task.id);
        const assignee = task.status === 'dispatched'
          ? seat?.seatId ?? seat?.lane ?? task.requestedBy
          : task.requestedBy;
        const outcome = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled'
          ? { state: task.status, text: null }
          : task.status === 'parked' && task.parkedUntil
            ? { state: 'parked', text: `Parked until ${task.parkedUntil.slice(0, 10)}` }
            : null;
        rows.push({
          id: `fleet:${task.id}`,
          source: 'fleet',
          title: task.title,
          repo: task.repo || null,
          column: FLEET_COLUMN[task.status],
          assignee,
          estimate: fleetEstimate(task),
          outcome,
          needsYou: false,
          updatedAt: task.updatedAt,
        });
      }
    }

    const state = safe(() => foldTeam(team, deps.teamEvents(team), deps.now()));
    if (state) {
      sources.handoff = 'healthy';
      const pendingApproval = new Set(state.approvals.filter((a) => a.state === 'pending').map((a) => a.handoffId));
      for (const h of state.handoffs) {
        rows.push({
          id: `handoff:${h.id}`,
          source: 'handoff',
          title: h.title,
          repo: h.contextRefs.find((r) => r.includes('/')) ?? null,
          column: HANDOFF_COLUMN[h.state],
          assignee: h.assignee ?? h.to ?? h.from,
          estimate: null,
          outcome: h.state === 'completed' || h.state === 'declined' ? { state: h.state, text: h.result } : null,
          needsYou: h.state === 'awaiting-approval' || pendingApproval.has(h.id),
          updatedAt: h.updatedAt,
        });
      }
    }

    const companions = safe(deps.companions);
    if (companions) {
      sources.companion = ok(companions.sourceState);
      for (const task of companions.tasks) {
        const report = task.reports[task.reports.length - 1];
        rows.push({
          id: `companion:${task.id}`,
          source: 'companion',
          title: task.goal,
          repo: task.projectBindingId || null,
          column: COMPANION_COLUMN[task.state],
          assignee: companionAssignee(task),
          estimate: companionEstimate(task),
          outcome: report || task.state === 'verified'
            ? { state: task.state === 'verified' ? 'verified' : 'reported', text: report?.result ?? null }
            : null,
          needsYou: task.state === 'needs-attention' || task.notification?.state === 'pending',
          updatedAt: task.updatedAt,
        });
      }
    }

    rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { rows: rows.slice(0, OPS_BOARD_TASK_LIMIT), sources };
  };

  return deps.journal(deps.now() - OPS_BOARD_JOURNAL_WINDOW_MS).then(finish, () => finish([]));
}

// ---------------------------------------------------------------------------
// Fleet & router : lanes, holds, seat decisions, A/B results
// ---------------------------------------------------------------------------

async function buildFleet(deps: OpsApiDeps): Promise<OpsFleetV1> {
  const now = deps.now?.() ?? Date.now();
  const tick = safe(() => (deps.tick ?? readTickState)());
  const journal = await (deps.journal ?? readJournalSince)(now - OPS_FLEET_JOURNAL_WINDOW_MS).catch(() => null);
  const dispatches = journal?.filter((r): r is DispatchJournalRecord => r.type === 'dispatch') ?? null;
  const learning = safe(() => (deps.learning ?? buildLearningState)());

  const decisions: OpsRouteDecision[] = (dispatches ?? [])
    .filter((d) => d.seatDecision || d.dispatched)
    .slice(-OPS_FLEET_DECISION_LIMIT)
    .reverse()
    .map((d) => ({
      at: d.at,
      itemId: d.itemId,
      taskId: d.taskId,
      repo: d.repo,
      title: d.title,
      seatId: d.seatDecision?.seatId ?? d.seatId,
      lane: d.lane,
      dispatched: d.dispatched,
      why: d.seatDecision?.why ?? null,
      summary: d.seatDecision?.summary ?? null,
      candidates: d.seatDecision?.candidates ?? [],
      skipReason: d.skipReason,
    }));

  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    tickAt: tick?.at ?? null,
    lanes: tick ? tick.lanes : null,
    holdProduction: tick?.holdProduction ?? null,
    held: (tick?.held ?? []).map((h) => ({
      itemId: h.itemId,
      repo: h.repo,
      title: h.title,
      holdKind: h.hold.kind,
      reason: h.hold.reason,
      nextEligibleAt: h.hold.nextEligibleAt ?? null,
      at: h.at,
    })),
    decisions,
    experiments: (learning?.experiments ?? []).map((e) => ({
      id: e.id,
      hypothesisId: e.hypothesisId,
      arms: { base: e.baseVersionId, candidate: e.candidateVersionId },
      status: e.status,
      pairs: e.pairs,
      wins: e.wins,
      losses: e.losses,
      ties: e.ties,
      lift: e.lift ? { mean: e.lift.mean, ciLow: e.lift.ciLow, ciHigh: e.lift.ciHigh } : null,
      verdict: e.verdict,
      reasons: e.reasons.slice(0, 8),
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
    })),
    sources: {
      tick: tick ? 'healthy' : 'degraded',
      journal: journal ? 'healthy' : 'degraded',
      learning: learning ? 'healthy' : 'degraded',
    },
  };
}

// ---------------------------------------------------------------------------
// Leaders' channel : the team bus the CLI and Telegram share
// ---------------------------------------------------------------------------

function isLeader(member: Member): boolean {
  return member.role === 'owner' || member.role === 'admin' || member.capabilities.includes('leader');
}

function buildLeaders(events: TeamEvent[], team: string, canPost: boolean, now: number): OpsLeadersV1 {
  const state = foldTeam(team, events, now);
  const channelCounts = new Map<string, number>();
  const messages: OpsLeaderMessage[] = [];
  for (const ev of events) {
    if (ev.type !== 'message.posted') continue;
    const channel = typeof ev.payload['channel'] === 'string' ? (ev.payload['channel'] as string) : 'general';
    channelCounts.set(channel, (channelCounts.get(channel) ?? 0) + 1);
    if (channel === OPS_LEADERS_CHANNEL) {
      messages.push({
        id: ev.id,
        from: ev.actor.id,
        at: ev.ts,
        text: typeof ev.payload['text'] === 'string' ? ev.payload['text'] : '',
      });
    }
  }
  return {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    team,
    channel: OPS_LEADERS_CHANNEL,
    leaders: state.members
      .map((m): OpsLeaderMember => ({
        id: m.id,
        kind: m.kind,
        role: m.role,
        provider: m.provider ?? null,
        onBehalfOf: m.onBehalfOf ?? null,
        capabilities: m.capabilities,
        online: m.online,
        lastSeenAt: m.lastSeen,
        leader: isLeader(m),
      }))
      .sort((a, b) => Number(b.leader) - Number(a.leader) || a.id.localeCompare(b.id)),
    channels: [...channelCounts.entries()].map(([channel, count]) => ({ channel, count })).sort((a, b) => b.count - a.count),
    messages: messages.slice(-OPS_LEADERS_MESSAGE_LIMIT),
    openHandoffs: state.handoffs
      .filter((h) => h.state === 'open' || h.state === 'accepted' || h.state === 'awaiting-approval')
      .map((h) => ({ id: h.id, from: h.from, to: h.to, title: h.title, state: h.state, updatedAt: h.updatedAt })),
    pendingApprovals: state.approvals
      .filter((a) => a.state === 'pending')
      .map((a) => ({ id: a.id, handoffId: a.handoffId, action: a.action, requestedBy: a.requestedBy })),
    canPost,
  };
}

function defaultPost(team: string, text: string): { ok: boolean; reason?: string } {
  try {
    const actor = localHumanActor();
    appendEvent(team, actor, 'message.posted', { channel: OPS_LEADERS_CHANNEL, text });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'The message was refused. Secret-shaped text cannot be posted to the team channel.' };
  }
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/**
 * The `ops` workbench family. Deps exist for tests and for callers that
 * already hold the buses; production uses the real readers.
 */
export function createOpsApi(deps: OpsApiDeps = {}): ApiModule {
  const now = () => deps.now?.() ?? Date.now();
  const fleetTasks = deps.fleetTasks ?? (() => listTasks());
  const teamEvents = deps.teamEvents ?? ((team: string) => readEvents(team));
  // Lazy: ASHLR_HOME resolves per request, as in proactive-coordination-api.ts.
  const companions = deps.companions ?? (() => createCompanionCoordinator({ directory: join(ashlrHome(), 'proactive-coordination') }).list());
  const enrolled = deps.enrolled ?? (() => listEnrolled());
  const releases = deps.releases ?? ((paths: readonly string[]) => probeReleases(paths, deps.releaseDeps));
  const post = deps.postMessage ?? defaultPost;
  let statusCache: { at: number; value: ReturnType<typeof readSelfUpdateStatus> } | null = null;

  return async (ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> => {
    if (path !== VERSE_OPS_PATH && !path.startsWith(`${VERSE_OPS_PATH}/`)) return false;

    if (path === VERSE_OPS_SELF_UPDATE_PATH && method === 'GET') {
      if (!queryParam(req, res, [])) return true;
      if (!statusCache || now() - statusCache.at >= 2000) {
        const entry = { at: Infinity, value: readSelfUpdateStatus(deps.selfUpdate) };
        statusCache = entry;
        void entry.value.then(() => { entry.at = now(); });
      }
      sendJson(res, 200, await statusCache.value);
      return true;
    }
    if (path === '/api/verse/ops/leader-journal' && method === 'GET') {
      if (!queryParam(req, res, [])) return true;
      const { readLeaderJournal } = await import('../fleet/leader-journal.js');
      sendJson(res, 200, await readLeaderJournal({ now }));
      return true;
    }
    if (path === VERSE_OPS_SELF_UPDATE_PATH && method === 'POST') {
      if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (!passesMutationGate(req, res, ctx.token)) return true;
      try {
        const body: unknown = JSON.parse(await readBody(req));
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 1 || !('action' in body) || body.action !== 'fetch') throw new Error('bad');
      } catch { sendInvalid(res, 'expected {action:"fetch"}'); return true; }
      const result = await fetchOrigin(deps.selfUpdate);
      statusCache = null;
      sendJson(res, 200, result);
      return true;
    }

    if (method === 'GET' && path === VERSE_OPS_BOARD_PATH) {
      if (!queryParam(req, res, ['team'])) return true;
      const team = new URL(req.url ?? '/', 'http://localhost').searchParams.get('team')?.trim() || DEFAULT_TEAM;
      if (!validId(team)) { sendInvalid(res, 'unknown team'); return true; }
      const boardDeps = { fleetTasks, teamEvents, companions, journal: deps.journal ?? readJournalSince, now };
      const { rows, sources } = await boardRows(boardDeps, team);
      const columns: OpsBoardV1['columns'] = { next: [], active: [], held: [], done: [], closed: [] };
      const counts: OpsBoardV1['counts'] = { next: 0, active: 0, held: 0, done: 0, closed: 0 };
      for (const row of rows) {
        columns[row.column].push(row);
        counts[row.column] += 1;
      }
      sendJson(res, 200, { v: 1, generatedAt: new Date(now()).toISOString(), team, columns, counts, sources } satisfies OpsBoardV1);
      return true;
    }

    if (method === 'GET' && path === VERSE_OPS_FLEET_PATH) {
      if (!queryParam(req, res, [])) return true;
      sendJson(res, 200, await buildFleet(deps));
      return true;
    }

    if (method === 'GET' && path === VERSE_OPS_RELEASES_PATH) {
      if (!queryParam(req, res, [])) return true;
      const paths = safe(enrolled) ?? null;
      sendJson(res, 200, {
        v: 1,
        generatedAt: new Date(now()).toISOString(),
        repos: paths ? await releases(paths) : [],
        sourceState: paths ? 'healthy' : 'degraded',
      } satisfies OpsReleasesV1);
      return true;
    }

    if (method === 'GET' && path === VERSE_OPS_LEADERS_PATH) {
      const params = queryParam(req, res, ['team']);
      if (!params) return true;
      const team = params.get('team')?.trim() || DEFAULT_TEAM;
      if (!validId(team)) { sendInvalid(res, 'unknown team'); return true; }
      const events = safe(() => teamEvents(team));
      if (!events) {
        sendJson(res, 200, {
          v: 1, generatedAt: new Date(now()).toISOString(), team, channel: OPS_LEADERS_CHANNEL,
          leaders: [], channels: [], messages: [], openHandoffs: [], pendingApprovals: [], canPost: false,
        } satisfies OpsLeadersV1);
        return true;
      }
      sendJson(res, 200, buildLeaders(events, team, ctx.allowDispatch, now()));
      return true;
    }

    if (method === 'POST' && path === VERSE_OPS_LEADERS_MESSAGES_PATH) {
      // The dispatcher already applied the dispatch flag + mutation gate; the
      // re-check keeps the module honest when mounted in tests without it.
      if (!ctx.allowDispatch) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      if (!passesMutationGate(req, res, ctx.token)) return true;
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await readBody(req)) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('bad');
        body = parsed as Record<string, unknown>;
      } catch {
        sendInvalid(res, 'a JSON object body is required');
        return true;
      }
      const extra = Object.keys(body).filter((k) => k !== 'text' && k !== 'team');
      if (extra.length) { sendInvalid(res, `unknown field: ${extra[0]}`); return true; }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) { sendInvalid(res, 'text is required'); return true; }
      if (text.length > OPS_MESSAGE_MAX_CHARS) { sendInvalid(res, `text is limited to ${OPS_MESSAGE_MAX_CHARS} characters`); return true; }
      const team = typeof body.team === 'string' && body.team.trim() ? body.team.trim() : DEFAULT_TEAM;
      if (!validId(team)) { sendInvalid(res, 'unknown team'); return true; }
      const result = post(team, scrubSecrets(text).slice(0, OPS_MESSAGE_MAX_CHARS));
      if (!result.ok) {
        sendJson(res, 422, { code: 'OPS_MESSAGE_REFUSED', error: result.reason ?? 'The message was refused.' });
        return true;
      }
      sendJson(res, 201, { ok: true });
      return true;
    }

    return false;
  };
}

/** The mounted handler. */
export const handleOpsApi: ApiModule = createOpsApi();
