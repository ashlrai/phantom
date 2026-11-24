/** Newest PLAN-LOG reply, once per entry heading, through the paired owner transport. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPlanLogReplies } from '../fleet/mason-outbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { isPaused } from './pause.js';
import { readOwnerLiveStatus } from './owner-live-status.js';
import type { OwnerThreadOptions } from './owner-thread.js';
export async function sendOwnerPlanReply(options: OwnerThreadOptions, input: { dryRun?: boolean; planLog?: string } = {}) {
  const result = (status: 'sent' | 'duplicate' | 'dry-run' | 'blocked' | 'no-reply', reason: string, text?: string) => ({ schema: 'owner.reply.v1' as const, status, reason, ...(text ? { text, destination: 'paired owner on iMessage' } : {}) });
  const hold = { halted: options.halted === true || killSwitchOn(), paused: options.paused === true || isPaused() };
  const owner = options.settings.owners.imessage;
  if (!owner || !options.settings.team.some(t => t.channel === 'imessage' && t.id === owner)) return result('blocked', 'no paired owner handle; run phm owner pair');
  const gate = readOwnerLiveStatus(options.settings, hold).channels.find(c => c.channel === 'imessage')!;
  if (gate.state !== 'on') return result('blocked', gate.reason);
  const replies = await readPlanLogReplies({ file: input.planLog ?? join(options.runsDir, 'leader', 'PLAN-LOG.md'), limit: 1, fileOrder: true });
  const reply = replies.entries[0];
  if (!reply?.id) return result('no-reply', replies.reason ?? 'No Reply for Mason quote found.');
  const dir = join(options.runsDir, 'leader');
  const file = join(dir, 'owner-reply.json');
  let lock: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    if (!input.dryRun) {
      ensurePrivateDirectory(dir);
      lock = acquireLocalStoreLockWithOutcome(join(dir, 'owner-reply.lock'), 0, { anchorPath: dir });
      if (lock.state !== 'acquired') return result('blocked', 'Another reply send is running or state is unavailable.');
    }
    const read = readPrivateFileCapped(file, 1024 * 1024);
    if (existsSync(file) && (!read || read.truncated)) throw new Error('unreadable state');
    const state: unknown = read ? JSON.parse(read.text) : {};
    if (!state || typeof state !== 'object' || Array.isArray(state) || Object.entries(state).some(([k, v]) => !/^plan-[a-f0-9]{16}$/.test(k) || (v !== 'sent' && v !== 'pending'))) throw new Error('invalid state');
    const keys = state as Record<string, 'sent' | 'pending'>;
    if (keys[reply.id]) return result(keys[reply.id] === 'sent' ? 'duplicate' : 'blocked', keys[reply.id] === 'sent' ? 'Already sent.' : 'Previous send is unconfirmed; not sending twice.');
    if (input.dryRun) return result('dry-run', 'Would send to the paired owner on iMessage.', reply.text);
    const transport = options.transports?.imessage;
    if (!transport) return result('blocked', 'No iMessage transport is attached.');
    if (killSwitchOn() || isPaused()) return result('blocked', 'Communications are held.');
    if (Object.keys(keys).length >= 10000) return result('blocked', 'Reply state is full.');
    keys[reply.id] = 'pending'; writePrivateFileAtomic(file, JSON.stringify(keys));
    const sent = await transport.deliver({ idempotencyKey: reply.id, text: reply.text, ownerId: owner });
    if (sent.status === 'refused') { delete keys[reply.id]; writePrivateFileAtomic(file, JSON.stringify(keys)); return result('blocked', 'iMessage did not send; try again.'); }
    keys[reply.id] = 'sent'; writePrivateFileAtomic(file, JSON.stringify(keys));
    return result('sent', 'Sent to the paired owner on iMessage.');
  } catch { return result('blocked', 'Reply state or delivery is unavailable; no automatic resend.'); }
  finally { if (lock?.state === 'acquired') releaseLocalStoreLock(lock.lock); }
}
