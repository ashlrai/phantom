import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import {
  followNeedsMasonAnswers, validNeedsAnswerFollow, NEEDS_ANSWER_FOLLOW_DEFAULT_POLL_MS,
  type NeedsAnswerFollowDeps, type NeedsAnswerFollowOptions, type NeedsAnswerFollowRecord,
  type NeedsAnswerFollowResult,
} from './needs-mason-answer-follow.js';

/** A checkpoint is at most 16 KiB and contains no reply text or filesystem path. */
export const NEEDS_ANSWER_CHECKPOINT_MAX_BYTES = 16 * 1024;
type Delivery = { itemId: string; id: string; cursor: number; receivedAt: number };
export type AnswerCheckpoint = { v: 1; root: string; ids: string[]; delivered: Delivery[] };
export type AnswerFeedRecord = (Extract<NeedsAnswerFollowRecord, { type: 'answer' }> & { checkpoint: AnswerCheckpoint }) |
  Extract<NeedsAnswerFollowRecord, { type: 'end' }>;
export interface AnswerFeedDeps extends Omit<NeedsAnswerFollowDeps, 'emit'> {
  emit?: (record: AnswerFeedRecord) => void | Promise<void>;
}
const keys = (value: object, expected: string): boolean => Object.keys(value).sort().join(',') === expected;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const scope = (root?: string): string => createHash('sha256').update(resolve(root ?? join(ashlrHome(), 'fleet'))).digest('hex').match(/.{1,16}/g)!.join(':');

function checkpoint(value: unknown, ids: string[], root: string): value is AnswerCheckpoint {
  if (!object(value) || !keys(value, 'delivered,ids,root,v') || value.v !== 1 || value.root !== root ||
      !Array.isArray(value.ids) || value.ids.length !== ids.length ||
      new Set(value.ids).size !== ids.length || !ids.every(id => (value.ids as unknown[]).includes(id)) ||
      !Array.isArray(value.delivered) || value.delivered.length > ids.length) return false;
  const seen = new Set<string>(), cursors = new Set<number>();
  for (const row of value.delivered) {
    if (!object(row) || !keys(row, 'cursor,id,itemId,receivedAt') || typeof row.itemId !== 'string' ||
        !ids.includes(row.itemId) || seen.has(row.itemId) || row.id !== `needs-mason-resolved-${row.itemId}` ||
        !Number.isSafeInteger(row.cursor) || (row.cursor as number) < 1 || cursors.has(row.cursor as number) ||
        !Number.isSafeInteger(row.receivedAt) || (row.receivedAt as number) < 0) return false;
    seen.add(row.itemId); cursors.add(row.cursor as number);
  }
  return true;
}

/** Read at most the documented limit plus one byte; never interpret checkpoint data as paths. */
function readCheckpoint(path: string): unknown {
  const fd = openSync(path, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw new Error('invalid checkpoint');
    const buffer = Buffer.alloc(NEEDS_ANSWER_CHECKPOINT_MAX_BYTES + 1);
    let length = 0, n: number;
    while (length < buffer.length && (n = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += n;
    if (length > NEEDS_ANSWER_CHECKPOINT_MAX_BYTES) throw new Error('checkpoint too large');
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
  } finally { closeSync(fd); }
}

export async function feedNeedsMasonAnswers(options: NeedsAnswerFollowOptions & { resumeFile?: string },
    deps: AnswerFeedDeps = {}): Promise<NeedsAnswerFollowResult> {
  const { resumeFile, ids, ...rest } = options;
  if (!validNeedsAnswerFollow(ids, rest.timeoutMs, rest.pollMs ?? NEEDS_ANSWER_FOLLOW_DEFAULT_POLL_MS)) return { outcome: 'invalid', pending: [] };
  const root = scope(rest.root);
  let state: AnswerCheckpoint = { v: 1, root, ids: [...ids], delivered: [] };
  if (resumeFile !== undefined) {
    try {
      const loaded = readCheckpoint(resumeFile);
      if (!checkpoint(loaded, ids, root)) return { outcome: 'invalid', pending: [] };
      state = loaded;
    } catch { return { outcome: 'invalid', pending: [] }; }
  }
  const pending = ids.filter(id => !state.delivered.some(row => row.itemId === id));
  if (!pending.length) {
    try { await deps.emit?.({ v: 1, type: 'end', outcome: 'complete', pending: [] }); }
    catch { return { outcome: 'unavailable', pending: [] }; }
    return { outcome: 'complete', pending: [] };
  }
  return followNeedsMasonAnswers({ ...rest, ids: pending }, {
    ...deps,
    emit: async record => {
      if (record.type === 'end') { await deps.emit?.(record); return; }
      const { itemId, id, cursor, receivedAt } = record;
      const next: AnswerCheckpoint = { ...state, delivered: [...state.delivered, { itemId, id, cursor, receivedAt }] };
      await deps.emit?.({ ...record, checkpoint: next });
      state = next;
    },
  });
}
