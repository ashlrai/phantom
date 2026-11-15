/**
 * routes/verse/fleet-steer/steer-model.ts — the Steer pane's read model:
 * validate GET /api/wb/v1/steer, hand its fleet slice to the #945 roster
 * adapter, and shape the queue lines the two job pickers act on.
 *
 * Pure: no fetch, no React. Every field is validated before use — the pane
 * never spreads untrusted rows into props.
 */
import type { VerseSeat } from '../../../../core/verse/types.js';
import { buildAgentRoster, type AgentRoster } from '../../../data/agent-roster.js';

export const WB_STEER_READ_PATH = '/api/wb/v1/steer';
/** Mirror of STRAY_ID_PATTERN (core/fleet/stray-slots.ts) — what job.stop accepts. */
export const STEER_JOB_ID = /^[A-Za-z0-9._-]{1,80}$/;
export const STEER_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
/** queue.reprioritize only reaches unclaimed lines. */
export const REPRIORITIZE_STATUSES = new Set(['READY', 'HOLD']);
/** Terminal queue states — a stop never lists those. */
const FINISHED_STATUSES = new Set(['DONE', 'RETIRED', 'DROPPED']);

export interface SteerQueueLine {
  id: string;
  status: string;
  priority: string;
  pool: string | null;
  tier: string | null;
  scope: string | null;
}

export type SteerSourceState = 'ok' | 'missing' | 'malformed' | 'too-large' | 'unreadable' | 'unavailable' | 'not-fleet-v1';

export interface SteerSnapshot {
  generatedAt: string | null;
  fleetState: SteerSourceState;
  seatsState: 'ok' | 'unavailable';
  queueState: 'ok' | 'unavailable';
  roster: AgentRoster | null;
  queue: SteerQueueLine[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 240): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

const SOURCE_STATES: readonly string[] = ['ok', 'missing', 'malformed', 'too-large', 'unreadable', 'unavailable', 'not-fleet-v1'];
const sourceState = (value: unknown): SteerSourceState =>
  typeof value === 'string' && SOURCE_STATES.includes(value) ? value as SteerSourceState : 'unavailable';

function queueLine(value: unknown): SteerQueueLine | null {
  if (!record(value)) return null;
  const id = text(value.id, 128), status = text(value.status, 20), priority = text(value.priority, 20);
  if (!id || !status || !priority) return null;
  return { id, status, priority, pool: text(value.pool, 80), tier: text(value.tier, 40), scope: text(value.scope) };
}

/** Seats pass through to the roster adapter, which validates every field it copies. */
function seats(value: unknown): VerseSeat[] {
  return Array.isArray(value) ? value.filter((row): row is VerseSeat => record(row) && typeof row.id === 'string') : [];
}

export function parseSteerSnapshot(value: unknown, now: number): SteerSnapshot {
  const doc = record(value) ? value : null;
  const fleetState = sourceState(doc?.fleetState);
  let roster: AgentRoster | null = null;
  // fleet.v1 goes through the adapter untouched — it validates rows itself.
  if (fleetState === 'ok' && doc?.fleet) {
    try { roster = buildAgentRoster({ fleet: doc.fleet, seats: seats(doc.seats), now }); }
    catch { roster = null; }
  }
  return {
    generatedAt: text(doc?.generatedAt, 60),
    fleetState,
    seatsState: doc?.seatsState === 'ok' ? 'ok' : 'unavailable',
    queueState: doc?.queueState === 'ok' ? 'ok' : 'unavailable',
    roster,
    queue: (Array.isArray(doc?.queue) ? doc.queue : []).map(queueLine).filter((row): row is SteerQueueLine => row !== null),
  };
}

/** The queue lines reprioritize can act on — unclaimed work only. */
export function reprioritizable(queue: readonly SteerQueueLine[]): SteerQueueLine[] {
  return queue.filter((row) => REPRIORITIZE_STATUSES.has(row.status));
}

/** The queue lines a stop can act on — anything not finished. */
export function stoppable(queue: readonly SteerQueueLine[]): SteerQueueLine[] {
  return queue.filter((row) => STEER_JOB_ID.test(row.id) && !FINISHED_STATUSES.has(row.status));
}
