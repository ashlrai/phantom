/**
 * RQ-PHX-MAILBOXEXACTRECUT157: preservation of the durable LOCAL iMessage
 * acceptance receipts from PR #5050. Drives the real createLeaderMailbox path
 * with fake identities. At-least-once across the append/receipt crash boundary
 * is documented in local-mailbox-receipts.ts; no exactly-once claim is tested.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderMailbox, type LeaderMailboxMessage } from '../src/core/comms/leader-mailbox.js';

let runsDir: string;
const inboxPath = (): string => join(runsDir, 'leader', 'MASON-INBOX.md');
const msg = (over: Partial<LeaderMailboxMessage> = {}): LeaderMailboxMessage => ({
  channel: 'imessage', senderId: 'fake-sender-one', text: 'fake preserve request',
  idempotencyKey: 'preserve-key-1', receivedAt: Date.UTC(2026, 0, 4, 5, 6, 7), ...over,
});
const inboxCount = async (): Promise<number> => {
  try { return ((await readFile(inboxPath(), 'utf8')).match(/ \[src:imessage id:/g) ?? []).length; } catch { return 0; }
};
const receiptFiles = async (): Promise<string[]> => {
  try { return (await readdir(join(runsDir, 'leader', '.mailbox-receipts'))).filter(f => f.endsWith('.json')); } catch { return []; }
};

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'mailbox-preserve-157-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('local mailbox acceptance preservation', () => {
  it('replays and concurrent acceptance return the original request id with one append', async () => {
    const first = await createLeaderMailbox({ runsDir }).accept(msg());
    const burst = await Promise.all(Array.from({ length: 5 }, () => createLeaderMailbox({ runsDir }).accept(msg())));
    expect(first.status).toBe('accepted');
    for (const r of burst) expect(r).toEqual({ status: 'duplicate', requestId: first.requestId });
    expect(await inboxCount()).toBe(1);
  });

  it('keeps distinct senders and keys distinct', async () => {
    const mailbox = createLeaderMailbox({ runsDir });
    const a = await mailbox.accept(msg());
    const b = await mailbox.accept(msg({ senderId: 'fake-sender-two', receivedAt: Date.UTC(2026, 0, 4, 5, 6, 8) }));
    const c = await mailbox.accept(msg({ idempotencyKey: 'preserve-key-2', receivedAt: Date.UTC(2026, 0, 4, 5, 6, 9) }));
    expect([a.status, b.status, c.status]).toEqual(['accepted', 'accepted', 'accepted']);
    expect(new Set([a.requestId, b.requestId, c.requestId]).size).toBe(3);
    expect(await inboxCount()).toBe(3);
  });

  it('keeps a failed append retryable: no receipt, then the retry is accepted once', async () => {
    // A directory where the inbox file belongs makes the real append fail.
    await mkdir(inboxPath(), { recursive: true });
    const failed = await createLeaderMailbox({ runsDir }).accept(msg());
    expect(failed.status).toBe('unavailable');
    expect(failed.requestId).toBeUndefined();
    expect(await receiptFiles()).toEqual([]);

    await rm(inboxPath(), { recursive: true });
    const retry = await createLeaderMailbox({ runsDir }).accept(msg());
    expect(retry.status).toBe('accepted');
    const replay = await createLeaderMailbox({ runsDir }).accept(msg());
    expect(replay).toEqual({ status: 'duplicate', requestId: retry.requestId });
    expect(await inboxCount()).toBe(1);
    expect(await receiptFiles()).toHaveLength(1);
  });
});
