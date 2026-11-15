import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderMailbox, type LeaderMailboxMessage } from '../src/core/comms/leader-mailbox.js';
import { localMailboxReceiptId } from '../src/core/comms/local-mailbox-receipts.js';

let runsDir: string;
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);
// The inbox derives its entry id from timestamp + text, so distinct messages carry distinct receivedAt.
const msg = (over: Partial<LeaderMailboxMessage> = {}): LeaderMailboxMessage => ({
  channel: 'imessage', senderId: 'synthetic-sender-a', text: 'synthetic status request',
  idempotencyKey: 'key-1', receivedAt: Date.UTC(2026, 0, 2, 3, 4, 5), ...over,
});
const inboxCount = async (): Promise<number> => {
  try {
    return ((await readFile(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8')).match(/ \[src:imessage id:/g) ?? []).length;
  } catch { return 0; }
};

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'mailbox-idem-138-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('local iMessage mailbox idempotency', () => {
  it('returns duplicate with the original requestId on sequential replay', async () => {
    const mailbox = createLeaderMailbox({ runsDir });
    const first = await mailbox.accept(msg());
    const second = await mailbox.accept(msg());
    expect(first.status).toBe('accepted');
    expect(first.requestId).toBeTruthy();
    expect(second).toEqual({ status: 'duplicate', requestId: first.requestId });
    expect(await inboxCount()).toBe(1);
  });

  it('survives a recreated mailbox instance', async () => {
    const first = await createLeaderMailbox({ runsDir }).accept(msg());
    const again = await createLeaderMailbox({ runsDir }).accept(msg());
    expect(again).toEqual({ status: 'duplicate', requestId: first.requestId });
    expect(await inboxCount()).toBe(1);
  });

  it('appends once for simultaneous replays across instances', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => createLeaderMailbox({ runsDir }).accept(msg())));
    const accepted = results.filter(r => r.status === 'accepted');
    expect(accepted).toHaveLength(1);
    expect(results.filter(r => r.status === 'duplicate').every(r => r.requestId === accepted[0]!.requestId)).toBe(true);
    expect(await inboxCount()).toBe(1);
  });

  it('keeps distinct keys and distinct senders separate, even with identical text', async () => {
    const mailbox = createLeaderMailbox({ runsDir });
    const a = await mailbox.accept(msg({ idempotencyKey: 'k-a', receivedAt: T0 + 1000 }));
    const b = await mailbox.accept(msg({ idempotencyKey: 'k-b', receivedAt: T0 + 2000 }));
    const c = await mailbox.accept(msg({ idempotencyKey: 'k-a', senderId: 'synthetic-sender-b', receivedAt: T0 + 3000 }));
    expect([a.status, b.status, c.status]).toEqual(['accepted', 'accepted', 'accepted']);
    expect(new Set([a.requestId, b.requestId, c.requestId]).size).toBe(3);
    expect(await inboxCount()).toBe(3);
  });

  it('keeps a refused message retryable with the same key', async () => {
    const mailbox = createLeaderMailbox({ runsDir });
    const refused = await mailbox.accept(msg({ text: '--only-flags' }));
    expect(refused.status).toBe('refused');
    expect(await inboxCount()).toBe(0);
    const retry = await mailbox.accept(msg({ text: 'valid retry text' }));
    expect(retry.status).toBe('accepted');
    expect(await inboxCount()).toBe(1);
  });

  it('reports unavailable and appends nothing when the filesystem is unusable', async () => {
    const blocked = join(runsDir, 'blocked');
    await writeFile(blocked, 'a file, not a directory');
    const result = await createLeaderMailbox({ runsDir: blocked }).accept(msg());
    expect(result.status).toBe('unavailable');
    expect(result.requestId).toBeUndefined();
  });

  it('stores only opaque hashes, never text or raw handles, and writes no shared bus', async () => {
    const busRoot = join(runsDir, 'bus');
    const m = msg({ text: 'private body words', senderId: 'raw-handle-value' });
    const r = await createLeaderMailbox({ runsDir, busRoot }).accept(m);
    const dir = join(runsDir, 'leader', '.mailbox-receipts');
    const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    expect(files).toEqual([`${localMailboxReceiptId(m)}.json`]);
    const raw = await readFile(join(dir, files[0]!), 'utf8');
    expect(JSON.parse(raw).requestId).toBe(r.requestId);
    for (const secret of ['private body words', 'raw-handle-value', 'key-1']) {
      expect(raw).not.toContain(secret);
      expect(files[0]).not.toContain(secret);
    }
    await expect(readdir(busRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
