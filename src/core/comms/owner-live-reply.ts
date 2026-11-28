/**
 * Default owner-live send: once a phone channel is on, the newest leader reply
 * (readLeaderReplies) goes to Mason, at most once an hour, and the same text
 * never twice (sha256 of the whitespace-normalised text). Only the verified
 * Mason binding is addressed: a channel counts only when readOwnerLiveStatus
 * says "on". State is one small file under the runs dir; it holds hashes and a
 * time, never message text or ids.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import type { LeaderReply } from '../fleet/mason-outbox.js';
import type { OwnerChannel } from './leader-mailbox.js';
import { PHONE_CHANNELS, readOwnerLiveStatus, type PhoneChannel } from './owner-live-status.js';
import { readOwnerThread, type OwnerThreadOptions } from './owner-thread.js';

export const OWNER_LIVE_REPLY_INTERVAL_MS = 60 * 60 * 1000;
const KEEP_HASHES = 50;
const STATE_FILE = 'owner-live-reply.json';

interface ReplyState { lastSentAt: number; hashes: string[]; delivered: Record<string, PhoneChannel[]> }

export type OwnerLiveReplyReason = 'sent' | 'planned' | 'no-channel-on' | 'no-reply' | 'already-sent' | 'too-soon' | 'not-delivered' | 'halted';

export interface OwnerLiveReplyReport {
  reason: OwnerLiveReplyReason;
  sent: PhoneChannel[];
  planned: PhoneChannel[];
  /** Per-channel plain reason for channels that were not on. */
  skipped: { channel: PhoneChannel; reason: string }[];
}

export const replyHash = (text: string): string => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

type StateRead = { kind: 'ready'; state: ReplyState } | { kind: 'unknown' };

// Only ENOENT is a first run; anything unreadable or malformed is unknown history (never sent from, never rewritten).
function readState(path: string): StateRead {
  const first: StateRead = { kind: 'ready', state: { lastSentAt: 0, hashes: [], delivered: {} } };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? first : { kind: 'unknown' };
  }
  let raw: unknown = null;
  try { raw = JSON.parse(text); } catch { /* falls through to the shape check */ }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'unknown' };
  const o = raw as Record<string, unknown>;
  if (typeof o.lastSentAt !== 'number' || !Number.isFinite(o.lastSentAt) || !Array.isArray(o.hashes)) return { kind: 'unknown' };
  if (!o.hashes.every(h => typeof h === 'string')) return { kind: 'unknown' };
  const hashes = (o.hashes as string[]).slice(-KEEP_HASHES);
  if (o.delivered !== undefined && (typeof o.delivered !== 'object' || o.delivered === null || Array.isArray(o.delivered))) return { kind: 'unknown' };
  const evidence = (o.delivered ?? {}) as Record<string, unknown>;
  const delivered: ReplyState['delivered'] = {};
  for (const hash of hashes) {
    if (!Object.hasOwn(evidence, hash)) continue;
    const channels = evidence[hash];
    if (!Array.isArray(channels) || !channels.every(c => typeof c === 'string' && (PHONE_CHANNELS as readonly string[]).includes(c))) return { kind: 'unknown' };
    delivered[hash] = PHONE_CHANNELS.filter(c => channels.includes(c));
  }
  return { kind: 'ready', state: { lastSentAt: o.lastSentAt, hashes, delivered } };
}

function writeState(dir: string, state: ReplyState): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, STATE_FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(state));
  renameSync(`${path}.tmp`, path);
}

export async function sendLeaderReplyToPhone(
  options: OwnerThreadOptions,
  input: { apply: boolean; replies: readonly LeaderReply[]; halted: boolean; paused: boolean },
): Promise<OwnerLiveReplyReport> {
  const now = (options.now ?? Date.now)();
  const status = readOwnerLiveStatus(options.settings, { halted: input.halted, paused: input.paused });
  const skipped = status.channels.filter(c => c.state !== 'on').map(c => ({ channel: c.channel, reason: c.nextStep ? `${c.reason} Next: ${c.nextStep}` : c.reason }));
  const on = status.channels.filter(c => c.state === 'on').map(c => c.channel);
  const done = (reason: OwnerLiveReplyReason, sent: PhoneChannel[] = [], planned: PhoneChannel[] = []): OwnerLiveReplyReport => ({ reason, sent, planned, skipped });
  if (input.halted || input.paused) return done('halted');
  if (on.length === 0) return done('no-channel-on');
  const newest = input.replies[0];
  if (!newest || !newest.text.trim()) return done('no-reply');
  const hash = replyHash(newest.text);
  const dir = join(options.runsDir, 'leader');
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  if (input.apply) {
    try {
      ensurePrivateDirectory(dir);
      lock = acquireLocalStoreLockWithOutcome(join(dir, 'owner-live-reply.lock'), 0, { anchorPath: dir });
    } catch { return done('not-delivered'); }
    if (lock.state !== 'acquired') return done('not-delivered');
  }
  try {
    const read = readState(join(dir, STATE_FILE));
    if (read.kind === 'unknown') return done('not-delivered');
    const state = read.state;
    const known = state.hashes.includes(hash);
    // A legacy hash has no destination evidence and must retain global dedupe.
    if (known && !Object.hasOwn(state.delivered, hash)) return done('already-sent');
    const pending = on.filter(channel => !state.delivered[hash]?.includes(channel));
    if (known && pending.length === 0) return done('already-sent');
    if (now - state.lastSentAt < OWNER_LIVE_REPLY_INTERVAL_MS) return done('too-soon');
    if (!input.apply) return done('planned', [], pending);
    // Slack needs the DM it last spoke in; every other channel needs only the owner id.
    const refs = new Map<OwnerChannel, string>();
    for (const m of readOwnerThread(options).messages) if (m.direction === 'inbound' && m.channelRef) refs.set(m.channel, m.channelRef);
    const sent: PhoneChannel[] = [];
    for (const channel of pending) {
      const transport = options.transports?.[channel];
      const ownerId = options.settings.owners[channel];
      if (!transport || !ownerId) continue;
      const ref = refs.get(channel);
      try {
        const result = await transport.deliver({ idempotencyKey: `owner-live-${hash.slice(0, 24)}-${channel}`, text: newest.text, ownerId, ...(ref ? { channelRef: ref } : {}) });
        if (result.status === 'sent' || result.status === 'duplicate') sent.push(channel);
      } catch { /* a failed channel is simply not counted */ }
    }
    const hashes = (known ? state.hashes : [...state.hashes, hash]).slice(-KEEP_HASHES);
    const delivered = Object.fromEntries(hashes.filter(h => Object.hasOwn(state.delivered, h)).map(h => [h, state.delivered[h]!]));
    delivered[hash] = [...(state.delivered[hash] ?? []), ...sent];
    writeState(dir, { lastSentAt: sent.length > 0 ? now : state.lastSentAt, hashes, delivered });
    if (sent.length === 0) return done('not-delivered');
    return done('sent', sent);
  } finally {
    if (lock?.state === 'acquired') releaseLocalStoreLock(lock.lock);
  }
}
