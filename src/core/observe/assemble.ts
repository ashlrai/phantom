/**
 * Pure observe snapshot. Callers pass already-read roster, sensors, claims,
 * files, and pulls. This module does not spawn processes or open files.
 */
import { parseBottlenecks, parseHumanSteps } from './contracts.js';
import { headlinesFor, type PullFact } from './pulls.js';
import { classifyResources, resourceCounts, type RosterSessionInput, type RosterSourceInput } from './resources.js';
import { projectSensors } from './sensors.js';
import type { BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { stableFieldId } from '../world/types.js';
import {
  OBSERVE_BASELINE,
  OBSERVE_CLAIM_WINDOW_MS,
  OBSERVE_SCHEMA,
  type ObserveSnapshot,
  type ReadingState,
  type ReleaseStage,
  type SessionDetail,
} from './types.js';

export interface ObserveInput {
  nowMs: number;
  windowMs?: number;
  windowDays?: number;
  roster?: unknown;
  sensors?: unknown;
  claims?: BusWorkClaimsInspection | null;
  humanSteps?: unknown;
  bottlenecks?: unknown;
  pulls?: readonly PullFact[];
  pullsComplete?: boolean;
  pullsReason?: string | null;
  updatePhase?: 'failed' | 'ok' | 'unknown';
}

const PIPELINE: ReleaseStage[] = [
  { id: 'merge', label: 'Merge', state: 'unknown', detail: null },
  { id: 'tag', label: 'Tag', state: 'unknown', detail: null },
  { id: 'release_gate', label: 'CI release gate', state: 'unknown', detail: null },
  { id: 'attest', label: 'Attest', state: 'unknown', detail: null },
  { id: 'npm', label: 'npm', state: 'unknown', detail: null },
  { id: 'sign', label: 'Sign', state: 'unknown', detail: null },
  { id: 'feed', label: 'Feed', state: 'unknown', detail: null },
  { id: 'installed', label: 'Installed version', state: 'unknown', detail: null },
  { id: 'update_check', label: 'Update check', state: 'unknown', detail: null },
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}

export function parseRoster(raw: unknown): { sources: RosterSourceInput[]; sessions: RosterSessionInput[] } | null {
  const body = record(raw);
  if (!body || !Array.isArray(body['sources'])) return null;
  const sources: RosterSourceInput[] = [];
  for (const row of body['sources']) {
    const source = record(row);
    if (!source || typeof source['source'] !== 'string') continue;
    const availability = source['availability'] === 'known' ? 'known' : 'unknown';
    const sessions = (Array.isArray(source['sessions']) ? source['sessions'] : []).flatMap((item) => {
      const session = sessionOf(item);
      return session ? [session] : [];
    });
    sources.push({ source: source['source'], availability, sessions: availability === 'known' ? sessions : [] });
  }
  return { sources, sessions: sources.flatMap((source) => source.sessions) };
}

function sessionOf(raw: unknown): RosterSessionInput | null {
  const row = record(raw);
  if (!row || typeof row['provider'] !== 'string' || typeof row['sessionId'] !== 'string' || typeof row['state'] !== 'string') return null;
  const claims = Array.isArray(row['claims']) ? row['claims'].flatMap((claim) => {
    const item = record(claim);
    return item && typeof item['id'] === 'string' ? [{ id: item['id'] }] : [];
  }) : [];
  return {
    provider: row['provider'],
    sessionId: row['sessionId'],
    title: text(row['title']),
    state: row['state'],
    ownership: text(row['ownership']),
    claims,
    lastActivity: text(row['lastActivity']),
  };
}

function ageSeconds(lastActivity: string | null, nowMs: number): number | null {
  if (!lastActivity) return null;
  const at = Date.parse(lastActivity);
  if (!Number.isFinite(at) || at > nowMs) return null;
  return Math.floor((nowMs - at) / 1000);
}

function stages(phase: ObserveInput['updatePhase']): { stages: ReleaseStage[]; bottleneck: ObserveSnapshot['graph']['bottleneck'] } {
  const next = PIPELINE.map((stage) => ({ ...stage }));
  const update = next.find((stage) => stage.id === 'update_check');
  if (phase === 'failed' && update) {
    update.state = 'blocked';
    update.detail = 'Update check failed';
    return { stages: next, bottleneck: { nodeId: 'update_check', reason: 'Update check failed' } };
  }
  if (phase === 'ok' && update) {
    update.state = 'ok';
    update.detail = 'Update check succeeded';
  }
  return { stages: next, bottleneck: null };
}

function countFields(snapshot: Omit<ObserveSnapshot, 'coverage'>): { live: number; unknown: number } {
  let live = 0;
  let unknown = 0;
  const mark = (value: unknown) => { if (value === null || value === 'unknown') unknown += 1; else live += 1; };
  for (const session of snapshot.roster.sessions) {
    mark(session.role); mark(session.task); mark(session.claim); mark(session.model); mark(session.ageSeconds);
  }
  if (snapshot.roster.state !== 'live') unknown += 1;
  for (const window of snapshot.usage.windows) {
    mark(window.headroom); mark(window.burnPerHour); mark(window.projectedUnused);
    mark(window.remaining); mark(window.forecastExhaustAt); mark(window.forecastVsReset); mark(window.idleIncludedWastedPerWeek);
  }
  if (snapshot.usage.state !== 'live') unknown += 1;
  mark(snapshot.resources.counts.coordinated);
  mark(snapshot.resources.counts.idle);
  mark(snapshot.resources.counts.duplicated);
  for (const repo of snapshot.pulls.repos) {
    mark(repo.mergedPerDay); mark(repo.changeFailureRate); mark(repo.timeToMergeHours); mark(repo.queueWaitHours); mark(repo.ciDurationHours);
  }
  if (snapshot.pulls.state !== 'live') unknown += 1;
  for (const item of snapshot.bottlenecks.top) { mark(item.before); mark(item.after); }
  if (snapshot.bottlenecks.state !== 'live') unknown += 1;
  mark(snapshot.humans.stepsRemaining);
  if (snapshot.humans.state !== 'live') unknown += 1;
  for (const stage of snapshot.graph.stages) if (stage.state === 'unknown') unknown += 1; else live += 1;
  return { live, unknown };
}

export function assembleObserve(input: ObserveInput): ObserveSnapshot {
  const windowMs = input.windowMs ?? OBSERVE_CLAIM_WINDOW_MS;
  const windowDays = input.windowDays ?? 7;
  const roster = input.roster === undefined ? null : parseRoster(input.roster);
  const windows = input.sensors === undefined ? [] : projectSensors(input.sensors, input.nowMs);
  const usageState: ReadingState = input.sensors === undefined ? 'pending' : windows.length === 0 ? 'unknown' : windows.some((window) => window.status === 'fresh') ? 'live' : 'unknown';
  const classified = classifyResources({
    roster: roster?.sources ?? null,
    claims: input.claims === undefined ? null : input.claims,
    windows,
    nowMs: input.nowMs,
    windowMs,
  });
  const humans = input.humanSteps === undefined
    ? { source: null, stepsRemaining: null, decisions: [], reason: 'Eng Ops has not published ashlr.human-steps/v1' }
    : parseHumanSteps(input.humanSteps);
  const bottlenecks = input.bottlenecks === undefined
    ? { source: null, top: [], reason: 'Eng Ops has not published bottlenecks.v1' }
    : parseBottlenecks(input.bottlenecks);
  const pulls = input.pulls
    ? headlinesFor(input.pulls, input.nowMs, windowDays, input.pullsComplete !== false)
    : [];
  const pipeline = stages(input.updatePhase ?? 'unknown');
  const graphBlocked = pipeline.bottleneck !== null;
  const snapshot: Omit<ObserveSnapshot, 'coverage'> = {
    schema: OBSERVE_SCHEMA,
    generatedAt: new Date(input.nowMs).toISOString(),
    readOnly: true,
    baseline: OBSERVE_BASELINE,
    roster: {
      state: roster ? 'live' : input.roster === undefined ? 'pending' : 'unknown',
      reason: roster ? null : 'phm agents roster is not available',
      source: roster ? 'agent-roster.v1' : null,
      sessions: (roster?.sessions ?? []).map((session) => ({
        provider: session.provider,
        sessionId: session.sessionId,
        role: session.ownership,
        task: session.title,
        claim: session.claims[0]?.id ?? null,
        status: session.state,
        model: null,
        ageSeconds: ageSeconds(session.lastActivity, input.nowMs),
      })),
    },
    usage: {
      state: usageState,
      reason: usageState === 'live' ? null : 'phm usage sensors has no fresh headroom',
      windows,
    },
    resources: {
      windowMinutes: windowMs / 60_000,
      claims: classified.claims,
      counts: resourceCounts(classified.items),
      items: classified.items,
    },
    pulls: {
      state: pulls.length > 0 && pulls.every((repo) => repo.state === 'live') ? 'live' : 'unknown',
      reason: input.pullsReason ?? (pulls.length === 0 ? 'No pull export was provided' : null),
      windowDays,
      repos: pulls,
    },
    bottlenecks: {
      state: bottlenecks.top.length > 0 ? 'live' : 'unknown',
      reason: bottlenecks.reason,
      source: bottlenecks.source,
      top: bottlenecks.top,
    },
    humans: {
      state: humans.stepsRemaining === null ? 'unknown' : 'live',
      reason: humans.reason,
      source: humans.source,
      stepsRemaining: humans.stepsRemaining,
      decisions: humans.decisions,
    },
    graph: {
      state: graphBlocked || input.updatePhase === 'ok' ? 'live' : 'unknown',
      reason: graphBlocked ? null : 'Release stages other than the update check are not measured yet',
      stages: pipeline.stages,
      bottleneck: pipeline.bottleneck,
    },
  };
  const fields = countFields(snapshot);
  const sources: ObserveSnapshot['coverage']['sources'] = [
    { id: 'agent-roster', state: snapshot.roster.state },
    { id: 'usage-sensors', state: snapshot.usage.state },
    { id: 'bus-claims', state: snapshot.resources.claims === 'available' || snapshot.resources.claims === 'missing' ? 'live' : 'unknown' },
    { id: 'gh-pulls', state: snapshot.pulls.state },
    { id: 'bottlenecks-file', state: snapshot.bottlenecks.state },
    { id: 'human-steps-file', state: snapshot.humans.state },
    { id: 'update-check', state: input.updatePhase === 'unknown' || input.updatePhase === undefined ? 'unknown' : 'live' },
  ];
  return {
    ...snapshot,
    coverage: { panels: 12, sources, fields, unknownFields: observeUnknownFields(snapshot) },
  };
}

function observeUnknownFields(snapshot: Omit<ObserveSnapshot, 'coverage'>): ObserveSnapshot['coverage']['unknownFields'] {
  const rows: ObserveSnapshot['coverage']['unknownFields'] = [];
  const add = (path: string, freshness: 'unknown' | 'stale' = 'unknown') => {
    rows.push({ id: stableFieldId(path), path, freshness });
  };
  if (snapshot.roster.state !== 'live') add('roster');
  for (const session of snapshot.roster.sessions) {
    if (session.role === null) add(`roster.sessions.${session.sessionId}.role`);
    if (session.task === null) add(`roster.sessions.${session.sessionId}.task`);
    if (session.claim === null) add(`roster.sessions.${session.sessionId}.claim`);
    if (session.model === null) add(`roster.sessions.${session.sessionId}.model`);
    if (session.ageSeconds === null) add(`roster.sessions.${session.sessionId}.ageSeconds`);
  }
  for (const window of snapshot.usage.windows) {
    if (window.headroom === null) add(`usage.windows.${window.lane}.headroom`);
    if (window.used === null) add(`usage.windows.${window.lane}.used`);
    if (window.limit === null) add(`usage.windows.${window.lane}.limit`);
  }
  if (snapshot.resources.counts.coordinated === null) add('resources.counts.coordinated');
  if (snapshot.resources.counts.idle === null) add('resources.counts.idle');
  if (snapshot.resources.counts.duplicated === null) add('resources.counts.duplicated');
  if (snapshot.resources.counts.unknown === null) add('resources.counts.unknown');
  if (snapshot.pulls.state !== 'live') add('pulls');
  for (const repo of snapshot.pulls.repos) {
    if (repo.mergedPerDay === null) add(`pulls.repos.${repo.repo}.mergedPerDay`);
    if (repo.changeFailureRate === null) add(`pulls.repos.${repo.repo}.changeFailureRate`);
  }
  if (snapshot.bottlenecks.state !== 'live') add('bottlenecks');
  if (snapshot.humans.stepsRemaining === null) add('humans.stepsRemaining');
  for (const stage of snapshot.graph.stages) {
    if (stage.state === 'unknown') add(`graph.stages.${stage.id}`);
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

export function sessionFromRoster(roster: unknown, sessionId: string, _nowMs: number): SessionDetail {
  const parsed = parseRoster(roster);
  const session = parsed?.sessions.find((item) => item.sessionId === sessionId) ?? null;
  if (!session) {
    return { schema: OBSERVE_SCHEMA, state: 'unknown', reason: 'Roster has no session with that id', sessionId, provider: null, task: null, status: null, transcript: null };
  }
  return {
    schema: OBSERVE_SCHEMA,
    state: 'live',
    reason: 'Transcript reader is not registered. desktop-operator has not landed.',
    sessionId,
    provider: session.provider,
    task: session.title,
    status: session.state,
    transcript: null,
  };
}

export function pipelineLabel(phase: string | null | undefined): string {
  if (phase === 'failed') return 'Release pipeline: Update check failed';
  if (phase === 'ok' || phase === 'current' || phase === 'idle') return 'Release pipeline: update check is current';
  return 'Release pipeline: update check unknown';
}
