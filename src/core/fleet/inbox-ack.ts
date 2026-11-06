import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import { appendBusInbox } from './bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';
import { postLeaderMessage } from '../vision/leader-thread.js';
import { readEmailDropConfig } from '../comms/email-drop-config.js';

export interface InboxAckEntry { entryId: string; channel: string | null; text: string; briefAt: string }
export interface InboxAck { entryId: string; channel: string; text: string }
export type InboxAckSenders = Partial<Record<string, (ack: InboxAck) => Promise<void>>>;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Only complete entries selected by the brief belong here. Legacy headings have no reply route. */
export function inboxAckEntry(raw: string, briefAt: string): InboxAckEntry {
  const match = /^\d{4}-\d{2}-\d{2}T\S+\s+\[src:([a-z0-9._-]{1,32})(?:\s+id:([A-Za-z0-9._:-]{1,64}))?\]\s+([^]*)$/.exec(raw);
  return { entryId: match?.[2] ?? hash(raw.trim()), channel: match?.[1] ?? null,
    text: match?.[3] ?? '', briefAt };
}

/** Pure planning: dedupe both previously recorded IDs and repeated input entries. */
export function planInboxAcks(entries: readonly InboxAckEntry[], ackLedger: ReadonlySet<string>): InboxAck[] {
  const seen = new Set(ackLedger);
  return entries.flatMap(entry => {
    if (seen.has(entry.entryId) || !entry.channel) return [];
    seen.add(entry.entryId);
    const preview = scrubSecrets(entry.text).replace(/\s+/g, ' ').trim().slice(0, 80);
    return [{ entryId: entry.entryId, channel: entry.channel,
      text: `Got it: ${preview}. In the planner brief at ${entry.briefAt}.` }];
  });
}

export function recordInboxAck(ledgerPath: string, entryId: string, status: 'acked' | 'skipped' = 'acked', reason?: string): void {
  ensurePrivateDirectory(dirname(ledgerPath));
  appendFileSync(ledgerPath, `${JSON.stringify({ entryId, status, ...(reason ? { reason } : {}) })}\n`, { mode: 0o600 });
}

/** Phone remote, fleet page and desktop all read bus messages to `mason`; the stable id makes a retry a duplicate. */
async function postBusAck(ack: InboxAck): Promise<void> {
  const result = appendBusInbox({ id: `inbox-ack-${hash(ack.entryId).slice(0, 32)}`, from: 'planner', to: 'mason',
    priority: 'P2', ttl: 7 * 24 * 60 * 60 * 1000, body: { kind: 'inbox-ack', channel: ack.channel, text: ack.text } });
  if (result.status !== 'posted' && result.status !== 'duplicate') throw new Error('bus unavailable');
}

async function defaultSenders(root: string): Promise<InboxAckSenders> {
  const senders: InboxAckSenders = {
    desktop: postBusAck,
    phone: postBusAck,
    page: postBusAck,
    telegram: async ack => { postLeaderMessage({ channel: 'telegram', kind: 'update', text: ack.text }); },
  };
  const email = await readEmailDropConfig(root);
  // Use the existing reply-eml outbox; its normal drain owns transport and recipient allowlisting.
  if (email.state === 'ok' && email.config?.outboxDir && email.config.from.length === 1) {
    const { outboxDir, from } = email.config;
    senders.email = async ack => {
      ensurePrivateDirectory(outboxDir);
      const name = `inbox-ack-${hash(ack.entryId)}.reply.eml`;
      if (['sent', 'sending'].some(dir => existsSync(join(outboxDir, dir, name)))) return;
      const content = `To: ${from[0]}\r\nSubject: Phantom planner acknowledgement\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${ack.text}\r\n`;
      try { writeFileSync(join(outboxDir, name), content, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    };
  }
  return senders;
}

/** Serialize send+record across brief builders. Failed senders remain retryable. */
export async function acknowledgeInboxEntries(raw: readonly string[], root: string, briefAt: string, injected?: InboxAckSenders): Promise<void> {
  if (!raw.length) return;
  const ledgerPath = join(root, 'queue', 'inbox-acks.jsonl');
  try {
    ensurePrivateDirectory(dirname(ledgerPath));
    const acquired = acquireLocalStoreLockWithOutcome(`${ledgerPath}.lock`, 0);
    if (acquired.state !== 'acquired') return;
    try {
      let ledger = '';
      try { ledger = readFileSync(ledgerPath, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const seen = new Set<string>();
      for (const line of ledger.split('\n').filter(Boolean)) {
        try {
          const row: unknown = JSON.parse(line);
          if (!row || typeof row !== 'object' || !('entryId' in row) || typeof row.entryId !== 'string'
            || !('status' in row) || typeof row.status !== 'string') continue;
          if (row.status === 'acked' || row.status === 'skipped') seen.add(row.entryId);
        } catch { /* A malformed row must not block acknowledgements after a restart. */ }
      }
      let needsNewline = ledger.length > 0 && !ledger.endsWith('\n');
      const record = (entryId: string, status: 'acked' | 'skipped' = 'acked', reason?: string): void => {
        if (needsNewline) {
          appendFileSync(ledgerPath, '\n', { mode: 0o600 });
          needsNewline = false;
        }
        recordInboxAck(ledgerPath, entryId, status, reason);
      };
      const entries = raw.map(text => inboxAckEntry(text, briefAt));
      const senders = injected ?? await defaultSenders(root);
      for (const entry of entries) {
        if (!entry.channel && !seen.has(entry.entryId)) {
          record(entry.entryId, 'skipped', 'legacy entry has no channel');
          seen.add(entry.entryId);
        }
      }
      for (const ack of planInboxAcks(entries, seen)) {
        const send = senders[ack.channel];
        if (!send) { record(ack.entryId, 'skipped', 'channel has no sender'); continue; }
        try { await send(ack); }
        catch { continue; }
        record(ack.entryId);
      }
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { /* Ledger failure must not prevent the planner from receiving orders. */ }
}
