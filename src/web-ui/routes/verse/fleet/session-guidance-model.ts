/**
 * routes/verse/fleet/session-guidance-model.ts — narrowing and display text
 * for the per-session guidance read (GET /api/fleet/guidance). Pure: the
 * strategy table and kinds come from the shared core contract.
 */
import {
  guidanceKindInfo,
  type GuidanceAckState,
  type GuidanceDeliveryKind,
} from '../../../../core/fleet/session-guidance.js';

export interface GuidanceLatest {
  id: string;
  at: string;
  state: GuidanceAckState;
  turn: number | null;
  requeueTo: string | null;
}

export interface GuidanceSessionSummary {
  job: string;
  lane: string | null;
  strategy: GuidanceDeliveryKind;
  pending: number | null;
  latest: GuidanceLatest | null;
}

const KINDS: readonly GuidanceDeliveryKind[] = ['stream-json-inject', 'resume-followup', 'resume', 'requeue'];
const STATES: readonly GuidanceAckState[] = ['queued', 'delivered', 'requeued'];
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 200): string | null => typeof v === 'string' && v.length <= max ? v : null;
const optText = (v: unknown, max = 200): string | null => v === null || v === undefined ? null : text(v, max);

function narrowLatest(v: unknown): GuidanceLatest | null {
  if (!record(v)) return null;
  const id = text(v.id);
  const at = text(v.at);
  const state = STATES.includes(v.state as GuidanceAckState) ? (v.state as GuidanceAckState) : null;
  if (id === null || at === null || state === null) return null;
  const turn = typeof v.turn === 'number' && Number.isInteger(v.turn) && v.turn >= 0 ? v.turn : null;
  return { id, at, state, turn, requeueTo: optText(v.requeueTo) };
}

export function narrowGuidanceList(v: unknown): { generatedAt: string; sourceState: string; sessions: GuidanceSessionSummary[] } | null {
  if (!record(v) || v.v !== 1 || typeof v.generatedAt !== 'string' || !Array.isArray(v.sessions)) return null;
  const sessions: GuidanceSessionSummary[] = [];
  for (const raw of v.sessions) {
    if (!record(raw) || text(raw.job) === null) continue;
    const strategy = KINDS.includes(raw.strategy as GuidanceDeliveryKind) ? (raw.strategy as GuidanceDeliveryKind) : 'requeue';
    const pending = typeof raw.pending === 'number' && Number.isInteger(raw.pending) && raw.pending >= 0 ? raw.pending : null;
    sessions.push({
      job: raw.job as string,
      lane: optText(raw.lane, 64),
      strategy,
      pending,
      latest: raw.latest === null || raw.latest === undefined ? null : narrowLatest(raw.latest),
    });
  }
  return {
    generatedAt: v.generatedAt,
    sourceState: typeof v.sourceState === 'string' ? v.sourceState : 'degraded',
    sessions,
  };
}

export function guidanceForJob(sessions: readonly GuidanceSessionSummary[], job: string): GuidanceSessionSummary | null {
  return sessions.find((session) => session.job === job) ?? null;
}

/** Row chip text for a stored strategy kind. */
export function strategyChip(kind: GuidanceDeliveryKind): string {
  return guidanceKindInfo(kind).label;
}

/**
 * The ack line a row shows: 'Queued', 'Delivered at turn N', 'Requeued'.
 * A latest entry nulls to '' — nothing to show.
 */
export function ackLabel(latest: GuidanceLatest | null): string {
  if (latest === null) return '';
  if (latest.state === 'delivered') return latest.turn === null ? 'Delivered' : `Delivered at turn ${latest.turn}`;
  if (latest.state === 'requeued') return latest.requeueTo === null ? 'Requeued' : `Requeued as ${latest.requeueTo}`;
  return 'Queued';
}

/** Dot color state matching the interject ack dot. */
export function ackTone(latest: GuidanceLatest | null): 'seen' | 'waiting' | 'unknown' {
  if (latest === null) return 'unknown';
  if (latest.state === 'queued') return 'waiting';
  return 'seen';
}
