/**
 * routes/verse/fleet-observe/observe-model.ts — the Observe cockpit's view
 * model. Pure: one fleet snapshot (GET /api/verse/fleet/runs), the accounts
 * rows and the bus page in; sessions, merge ticker, quota gauges, comms and
 * incidents out. Nothing is invented — a reading the snapshot does not carry
 * stays `null` and renders as "—".
 */
import { busFeedItems } from '../fleet-events/bus-feed-items.js';
import { sortNewestFirst, type FeedItem } from '../fleet-events/fleet-events-model.js';
import type { UsageRow } from '../fleet-usage/usage-pane-model.js';
import { laneAvgJobMinutes } from '../fleet/runs-lanes-model.js';
import { workerAgeState, type AgeState } from '../fleet/worker-age-state.js';

export interface ObserveSession {
  job: string;
  repo: string;
  lane: string;
  tier: string;
  status: 'running' | 'claimed' | 'held';
  ageSeconds: number | null;
  ageState: AgeState;
  /** Lane burn — the snapshot has no per-session token reading. */
  laneTokensLastHour: number | null;
  /** Minutes until the lane's typical job length; null once past it or when unknown. */
  etaMinutes: number | null;
}
export interface ObserveMerge { id: string; repo: string; number: number; title: string; mergedAt: string | null; url: string | null }
export interface ObserveGauge { id: string; account: string; window: string; usedPercent: number | null; tone: 'ok' | 'warn' | 'danger'; resetsAt: string | null; limitReached: boolean }
export interface ObserveLane { lane: string; running: number; target: number; queued: number; held: boolean; heldReason: string | null }

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null;
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const validRepo = (repo: string): boolean => repo.split('/').length === 2 && repo.split('/').every((part) => SEGMENT.test(part));

export function readLanes(runs: unknown): ObserveLane[] {
  return list(record(runs).lanes).flatMap((raw) => {
    const l = record(raw);
    const lane = str(l.lane);
    if (!lane) return [];
    return [{ lane, running: num(l.running) ?? 0, target: num(l.target) ?? 0, queued: num(l.queued) ?? 0, held: l.held === true, heldReason: str(l.heldReason) }];
  });
}

/** Every running (and claimed, not yet running) session across all lanes, longest-running first. */
export function readSessions(runs: unknown): ObserveSession[] {
  const data = record(runs);
  const lanes = new Map(list(data.lanes).map((raw) => [str(record(raw).lane) ?? '', record(raw)] as const));
  const tokens = (lane: string) => num(lanes.get(lane)?.tokensLastHour);
  const held = (lane: string) => lanes.get(lane)?.held === true;
  const running: ObserveSession[] = list(data.workers).flatMap((raw) => {
    const w = record(raw);
    const job = str(w.job), lane = str(w.lane);
    if (!job || !lane) return [];
    const ageSeconds = num(w.ageSeconds);
    const typical = laneAvgJobMinutes(lane);
    return [{ job, repo: str(w.repo) ?? '—', lane, tier: str(w.tier) ?? '—', status: held(lane) ? 'held' as const : 'running' as const,
      ageSeconds, ageState: workerAgeState(lane, ageSeconds), laneTokensLastHour: tokens(lane),
      etaMinutes: ageSeconds === null ? null : Math.max(0, Math.ceil(typical - ageSeconds / 60)) || null }];
  }).sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1));
  const live = new Set(running.map((s) => s.job));
  const claimed: ObserveSession[] = list(data.claimed).flatMap((raw) => {
    const c = record(raw);
    const job = str(c.job), lane = str(c.lane);
    if (!job || !lane || live.has(job)) return [];
    return [{ job, repo: '—', lane, tier: str(c.tier) ?? '—', status: 'claimed' as const, ageSeconds: null, ageState: 'normal' as const,
      laneTokensLastHour: tokens(lane), etaMinutes: null }];
  });
  return [...running, ...claimed];
}

/** Merge ticker: the snapshot's last-hour merges, newest first. */
export function readMerges(runs: unknown): ObserveMerge[] {
  const items = list(record(record(runs).mergesLastHour).items);
  return items.flatMap((raw) => {
    const m = record(raw);
    const repo = str(m.repo), number = num(m.number);
    if (!repo || number === null || !Number.isSafeInteger(number) || number < 1) return [];
    return [{ id: `${repo}#${number}`, repo, number, title: str(m.title) ?? '', mergedAt: str(m.mergedAt),
      url: validRepo(repo) ? `https://github.com/${repo}/pull/${number}` : null }];
  }).sort((a, b) => (Date.parse(b.mergedAt ?? '') || 0) - (Date.parse(a.mergedAt ?? '') || 0));
}

const tone = (used: number | null, limitReached: boolean): ObserveGauge['tone'] =>
  limitReached || (used !== null && used >= 90) ? 'danger' : used !== null && used >= 75 ? 'warn' : 'ok';

/** One gauge per reported provider window; windows without a reading keep a null percent. */
export function readGauges(rows: readonly UsageRow[]): ObserveGauge[] {
  return rows.flatMap((row) => row.windows.map((w, i) => ({
    id: `${row.id}:${i}`, account: row.label, window: w.label, usedPercent: w.usedPercent,
    tone: tone(w.usedPercent, w.limitReached), resetsAt: w.resetsAt, limitReached: w.limitReached,
  })));
}

/** Agent-to-agent traffic (bus rows) and CI incidents, both newest first. */
export function readComms(busPage: unknown): { comms: FeedItem[]; incidents: FeedItem[] } {
  const items = sortNewestFirst(busFeedItems(busPage));
  return { comms: items.filter((i) => i.kind === 'bus'), incidents: items.filter((i) => i.kind === 'ci') };
}

export interface ObserveRosterRow {
  provider: string;
  sessionId: string;
  title: string | null;
  state: string;
  ownership: string | null;
  claims: number;
  lastActivity: string | null;
  blockers: string;
}

export interface ObserveRosterSourceLine {
  source: string;
  availability: 'known' | 'unknown';
  error: string | null;
  sessions: number;
}

/** The agent-roster.v1 feed. A payload that is not that schema is null. */
export function readRoster(raw: unknown): { rows: ObserveRosterRow[]; sources: ObserveRosterSourceLine[] } | null {
  const data = record(raw);
  if (data.schema !== 'agent-roster.v1' || !Array.isArray(data.sessions) || !Array.isArray(data.sources)) return null;
  const rows: ObserveRosterRow[] = [];
  for (const item of data.sessions) {
    const s = record(item);
    const provider = str(s.provider);
    const sessionId = str(s.sessionId);
    const state = str(s.state);
    if (!provider || !sessionId || !state) return null;
    const blockers = Array.isArray(s.blockers) ? s.blockers.filter((part): part is string => typeof part === 'string') : [];
    rows.push({
      provider,
      sessionId,
      title: str(s.title),
      state,
      ownership: str(s.ownership),
      claims: Array.isArray(s.claims) ? s.claims.length : 0,
      lastActivity: str(s.lastActivity),
      blockers: blockers.join('; '),
    });
  }
  const sources: ObserveRosterSourceLine[] = [];
  for (const item of data.sources) {
    const s = record(item);
    const source = str(s.source);
    const availability = s.availability === 'known' || s.availability === 'unknown' ? s.availability : null;
    if (!source || !availability) return null;
    sources.push({
      source,
      availability,
      error: str(s.error),
      sessions: Array.isArray(s.sessions) ? s.sessions.length : 0,
    });
  }
  return { rows, sources };
}

/** Lanes that cannot take work are incidents too — the reason comes from the lane itself. */
export function heldIncidents(lanes: readonly ObserveLane[]): string[] {
  return lanes.filter((l) => l.held).map((l) => `${l.lane} held: ${l.heldReason ?? 'reason unknown'}`);
}
