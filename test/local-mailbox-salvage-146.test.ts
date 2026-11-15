/**
 * RQ-PHX-LOCALMAILBOXSALVAGE146: regression coverage for the durable iMessage
 * mailbox receipts recovered from PR #5019 (RQ-PHX-IMSGMAILBOXDEDUPE138).
 * Drives the real createLeaderMailbox().accept path against a temp runs dir.
 * Fake fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderMailbox, type LeaderMailboxMessage } from '../src/core/comms/leader-mailbox.js';
import { localMailboxReceiptId } from '../src/core/comms/local-mailbox-receipts.js';

let runsDir: string;
const inboxPath = (): string => join(runsDir, 'leader', 'MASON-INBOX.md');
const receiptDir = (): string => join(runsDir, 'leader', '.mailbox-receipts');
const msg = (over: Partial<LeaderMailboxMessage> = {}): LeaderMailboxMessage => ({
  channel: 'imessage', senderId: 'synthetic-sender-a', text: 'synthetic salvage request',
  idempotencyKey: 'salvage-key-1', receivedAt: Date.UTC(2026, 0, 3, 4, 5, 6), ...over,
});
const receiptFiles = async (): Promise<string[]> => {
  try { return (await readdir(receiptDir())).filter(f => f.endsWith('.json')); } catch { return []; }
};

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'mailbox-salvage-146-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('local mailbox receipts (salvage of #5019)', () => {
  it('refuses a message without an idempotency key and writes nothing', async () => {
    const result = await createLeaderMailbox({ runsDir }).accept(msg({ idempotencyKey: '' }));
    expect(result.status).toBe('refused');
    expect(result.requestId).toBeUndefined();
    await expect(readFile(inboxPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await receiptFiles()).toEqual([]);
  });

  it('treats the receipt, not the inbox file, as the duplicate authority', async () => {
    const first = await createLeaderMailbox({ runsDir }).accept(msg());
    expect(first.status).toBe('accepted');
    await unlink(inboxPath());
    const replay = await createLeaderMailbox({ runsDir }).accept(msg());
    expect(replay).toEqual({ status: 'duplicate', requestId: first.requestId });
    await expect(readFile(inboxPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds identity to channel, sender and key, so each change yields a distinct receipt', () => {
    const base = { channel: 'imessage', senderId: 'synthetic-sender-a', idempotencyKey: 'salvage-key-1' };
    const ids = new Set([
      localMailboxReceiptId(base),
      localMailboxReceiptId({ ...base, channel: 'telegram' }),
      localMailboxReceiptId({ ...base, senderId: 'synthetic-sender-b' }),
      localMailboxReceiptId({ ...base, idempotencyKey: 'salvage-key-2' }),
    ]);
    expect(ids.size).toBe(4);
    expect(localMailboxReceiptId(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes a receipt only after a successful append, with the original request id', async () => {
    const refused = await createLeaderMailbox({ runsDir }).accept(msg({ text: '--only-flags' }));
    expect(refused.status).toBe('refused');
    expect(await receiptFiles()).toEqual([]);
    const accepted = await createLeaderMailbox({ runsDir }).accept(msg());
    expect(accepted.status).toBe('accepted');
    const files = await receiptFiles();
    expect(files).toEqual([`${localMailboxReceiptId(msg())}.json`]);
    const stored = JSON.parse(await readFile(join(receiptDir(), files[0]!), 'utf8')) as Record<string, unknown>;
    expect(stored.requestId).toBe(accepted.requestId);
    expect(Object.keys(stored).sort()).toEqual(['acceptedAt', 'requestId', 'v']);
  });
});
