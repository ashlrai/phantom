import { createHash } from 'node:crypto';
/** Called ONLY by authenticated native iMessage receiver; not a Bus/MCP/API entry. */
import type { AshlrConfig } from '../types.js';
import { isVerifiedMasonHandle, type IntakeMsg } from '../integrations/imessage.js';
import { senderIdFor } from '../comms/imessage-teammate-inbox.js';
import { prepareOwnerChatShare } from './chat-owner-intent.js';
import { readAgentRegistry } from './bus-identity.js';
import { localWriteGate } from './send-gate.js';
import { readLeaderNetworkConfig, type LeaderRuntimeOptions } from './leader-network-runtime.js';
import { appendBusInbox, assertPrivateBusPath } from '../fleet/bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { join } from 'node:path';
import { OwnerChatCapacityError, ownerChatRoot, ownerReceiptDir, readOwnerChatReceipts, writeOwnerChatReceipts, ownerEnvelopeDigest } from './chat-owner-receipts.js';
import type { BusEnvelope } from '../fleet/bus-envelope.js';

export type OwnerChatIngressResult = { status: 'ignored' | 'refused' | 'retryable' | 'accepted' | 'duplicate'; cursor?: number };
export function receiptOwnerChat(msg: IntakeMsg, cfg: AshlrConfig, options: LeaderRuntimeOptions = {}): OwnerChatIngressResult {
  let value: unknown;
  try { value = JSON.parse(msg.text); } catch { return { status: 'ignored' }; }
  if (!value || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'agent-chat.share') return { status: 'ignored' };
  if (cfg.comms?.enabled !== true || !isVerifiedMasonHandle(msg.handle, cfg) || !msg.identity || !Number.isSafeInteger(msg.ts) || msg.ts < 0 || localWriteGate()) return { status: 'refused' };
  const root = ownerChatRoot(options.busRoot), now = options.now ?? Date.now;
  const prepare = () => {
    const registry = readAgentRegistry({ root });
    const policy = readLeaderNetworkConfig(options);
    return prepareOwnerChatShare({ ...msg.identity!, receipt: { channel: 'imessage', verifiedSenderId: senderIdFor(msg.handle),
      body: msg.text, receivedAt: new Date(msg.ts).toISOString() },
      registry: registry.status === 'ok' ? registry.registry : null, ...policy, now: now(), paused: !!localWriteGate(), killed: false });
  };
  let held: ReturnType<typeof acquireLocalStoreLockWithOutcome> | undefined;
  try {
    const initial = prepare();
    ensurePrivateDirectory(root); assertPrivateBusPath(root, 'directory', root);
    const dir = ownerReceiptDir(root); ensurePrivateDirectory(dir); assertPrivateBusPath(dir, 'directory', root);
    held = acquireLocalStoreLockWithOutcome(join(dir, 'writer.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    if (held.state !== 'acquired') return { status: 'retryable' };
    const sourceId = 'owner-chat-' + createHash('sha256').update(JSON.stringify([msg.identity!.sourceNamespace, 'imessage', senderIdFor(msg.handle), msg.identity!.physicalMessageId])).digest('hex').slice(0, 32);
    const rows = readOwnerChatReceipts(root), old = rows.find(row => row.id === sourceId);
    const reject = (): OwnerChatIngressResult => {
      if (old?.state === 'pending') { old.state = 'rejected'; writeOwnerChatReceipts(root, rows); }
      return { status: 'refused' };
    };
    if (initial.status !== 'prepared' || old?.state === 'rejected') return reject();
    if (old && old.contentDigest !== initial.contentDigest) return reject();
    const current = prepare(); // fresh owner, confirmation, exact member set and pause state under lock
    if (current.status !== 'prepared' || current.contentDigest !== initial.contentDigest) return reject();
    if (old?.state === 'accepted') return { status: 'duplicate', cursor: old.cursor };
    if (!old && rows.length >= 1024) return { status: 'refused' };
    const to = `group:${current.channel}:general`;
    const envelope: BusEnvelope = { id: current.messageId, from: 'owner:local', to, priority: 'P0', ttl: 7 * 24 * 60 * 60_000,
      body: { kind: 'note', thread: current.thread, text: current.text }, channel: 'bus', channel_ref: to,
      sender: { agent_id: 'owner:local', vendor: 'phantom', human: true, team: true }, external: false, origin_bridge: 'agent-chat-owner' };
    const digest = ownerEnvelopeDigest(envelope);
    if (old && old.envelopeDigest !== digest) return { status: 'refused' };
    const row = old ?? { id: current.messageId, recipients: current.recipientIds, contentDigest: current.contentDigest, envelopeDigest: digest,
      state: 'pending' as const, cursor: 0, receivedAt: current.receivedAt };
    if (!old) { rows.push(row); writeOwnerChatReceipts(root, rows); }
    // No await between final policy check and append. Bus ID dedup recovers a crash
    // after append. Pending replay expires before Bus TTL reclamation could resend.
    const final = prepare();
    if (final.status !== 'prepared' || final.contentDigest !== current.contentDigest) {
      row.state = 'rejected'; writeOwnerChatReceipts(root, rows); return { status: 'refused' };
    }
    const posted = appendBusInbox(envelope, { root, now });
    if (posted.status !== 'posted' && posted.status !== 'duplicate') return { status: posted.status === 'conflict' ? 'refused' : 'retryable' };
    row.state = 'accepted'; row.cursor = posted.cursor;
    writeOwnerChatReceipts(root, rows);
    return { status: posted.status === 'posted' ? 'accepted' : 'duplicate', cursor: posted.cursor };
  } catch (error) { return { status: error instanceof OwnerChatCapacityError ? 'refused' : 'retryable' }; }
  finally { if (held?.state === 'acquired') releaseLocalStoreLock(held.lock); }
}
