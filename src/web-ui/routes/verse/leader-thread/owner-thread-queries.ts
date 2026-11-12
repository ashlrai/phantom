/**
 * routes/verse/leader-thread/owner-thread-queries.ts — the Leader thread's read
 * of the owner thread (Telegram, email, iMessage, Slack and desktop messages
 * in one ordered file). The route may not be served by this build; a 404 or an
 * unreadable body means "no owner messages", never an error.
 */
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const OWNER_THREAD_READ_PATH = '/api/verse/comms/owner-thread';
const OWNER_THREAD_LIMIT = 100;

export interface OwnerThreadLine {
  seq: number;
  id: string;
  channel: string;
  senderId: string;
  direction: 'inbound' | 'outbound';
  at: string;
  text: string;
  replyTo?: string;
  fanout?: string[];
}

export interface OwnerChannelState {
  id: string;
  enabled: boolean;
  reason: string;
  nextStep: string | null;
}

export interface ReplyGapState { teammate: string; unansweredCount: number; oldestUnansweredMs: number; state: 'ok' | 'late' | 'unknown' }

export interface OwnerThreadRead {
  channels: OwnerChannelState[];
  replyGap?: ReplyGapState[];
  lines: OwnerThreadLine[];
  /** The owner channels are killed or paused: the pane says so and shows no owner lines. */
  paused: boolean;
}

export const NO_OWNER_THREAD: OwnerThreadRead = { lines: [], paused: false, channels: [], replyGap: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseLine(row: unknown): OwnerThreadLine | null {
  if (!isRecord(row)) return null;
  const { seq, id, channel, senderId, direction, at, text, replyTo, fanout } = row;
  if (typeof seq !== 'number' || !Number.isFinite(seq) || typeof id !== 'string' || typeof channel !== 'string' || typeof senderId !== 'string' ||
    (direction !== 'inbound' && direction !== 'outbound') || typeof at !== 'string' || typeof text !== 'string') return null;
  return { seq, id, channel, senderId, direction, at, text,
    ...(typeof replyTo === 'string' ? { replyTo } : {}),
    ...(Array.isArray(fanout) ? { fanout: fanout.filter((c): c is string => typeof c === 'string') } : {}) };
}

/** The good rows of a comms.owner-thread.v1 body; [] for any other shape. Bad rows drop one at a time. */
export function parseOwnerThread(value: unknown): OwnerThreadLine[] {
  if (!isRecord(value) || value.schema !== 'comms.owner-thread.v1' || value.unavailable === true || !Array.isArray(value.messages)) return [];
  return value.messages.flatMap(row => parseLine(row) ?? []);
}

export function parseOwnerThreadRead(value: unknown): OwnerThreadRead {
  const status = isRecord(value) && isRecord(value.status) ? value.status : null;
  const channels = Array.isArray(status?.adapters) ? status.adapters.flatMap((row: unknown): OwnerChannelState[] => {
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.enabled !== 'boolean' ||
      typeof row.reason !== 'string' || (row.nextStep !== null && typeof row.nextStep !== 'string')) return [];
    return [{ id: row.id, enabled: row.enabled, reason: row.reason, nextStep: row.nextStep }];
  }) : [];
  const replyGap = Array.isArray(status?.replyGap) ? status.replyGap.flatMap((row: unknown): ReplyGapState[] => {
    if (!isRecord(row) || typeof row.teammate !== 'string' || typeof row.unansweredCount !== 'number' || typeof row.oldestUnansweredMs !== 'number' ||
      (row.state !== 'ok' && row.state !== 'late' && row.state !== 'unknown')) return [];
    return [{ teammate: row.teammate, unansweredCount: row.unansweredCount, oldestUnansweredMs: row.oldestUnansweredMs, state: row.state }];
  }) : [];
  return { lines: parseOwnerThread(value), paused: status?.kill === true || status?.paused === true, channels, replyGap };
}

export const ownerThreadQuery: QueryDef<OwnerThreadRead> = {
  key: 'verse-comms-owner-thread',
  fetch: async signal => {
    try {
      return parseOwnerThreadRead(await apiGet<unknown>(`${OWNER_THREAD_READ_PATH}?limit=${OWNER_THREAD_LIMIT}`, signal));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return NO_OWNER_THREAD;
      throw error;
    }
  },
};
