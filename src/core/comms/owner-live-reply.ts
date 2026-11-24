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
import type { LeaderReply } from '../fleet/mason-outbox.js';
import type { OwnerChannel } from './leader-mailbox.js';
import { readOwnerLiveStatus, type PhoneChannel } from './owner-live-status.js';
import { readOwnerThread, type OwnerThreadOptions } from './owner-thread.js';

export const OWNER_LIVE_REPLY_INTERVAL_MS = 60 * 60 * 1000;
const KEEP_HASHES = 50;
const STATE_FILE = 'owner-live-reply.json';

interface ReplyState { lastSentAt: number; hashes: string[] }

export type OwnerLiveReplyReason = 'sent' | 'planned' | 'no-channel-on' | 'no-reply' | 'already-sent' | 'too-soon' | 'not-delivered' | 'halted';

export interface OwnerLiveReplyReport {
  reason: OwnerLiveReplyReason;
  sent: PhoneChannel[];
  planned: PhoneChannel[];
  /** Per-channel plain reason for channels that were not on. */
  skipped: { channel: PhoneChannel; reason: string }[];
}

export const replyHash = (text: string): string => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');

function readState(path: string): ReplyState {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const o = raw as Partial<ReplyState>;
    if (typeof o.lastSentAt === 'number' && Array.isArray(o.hashes)) return { lastSentAt: o.lastSentAt, hashes: o.hashes.filter((h): h is string => typeof h === 'string') };
  } catch { /* first run or unreadable: nothing sent yet */ }
  return { lastSentAt: 0, hashes: [] };
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
  const state = readState(join(dir, STATE_FILE));
  if (state.hashes.includes(hash)) return done('already-sent');
  if (now - state.lastSentAt < OWNER_LIVE_REPLY_INTERVAL_MS) return done('too-soon');
  if (!input.apply) return done('planned', [], on);
  // Slack needs the DM it last spoke in; every other channel needs only the owner id.
  const refs = new Map<OwnerChannel, string>();
  for (const m of readOwnerThread(options).messages) if (m.direction === 'inbound' && m.channelRef) refs.set(m.channel, m.channelRef);
  const sent: PhoneChannel[] = [];
  for (const channel of on) {
    const transport = options.transports?.[channel];
    const ownerId = options.settings.owners[channel];
    if (!transport || !ownerId) continue;
    const ref = refs.get(channel);
    try {
      const result = await transport.deliver({ idempotencyKey: `owner-live-${hash.slice(0, 24)}-${channel}`, text: newest.text, ownerId, ...(ref ? { channelRef: ref } : {}) });
      if (result.status === 'sent' || result.status === 'duplicate') sent.push(channel);
    } catch { /* a failed channel is simply not counted */ }
  }
  if (sent.length === 0) return done('not-delivered');
  writeState(dir, { lastSentAt: now, hashes: [...state.hashes, hash].slice(-KEEP_HASHES) });
  return done('sent', sent);
}
