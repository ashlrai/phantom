import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readEmailOutbox } from '../src/core/comms/email-outbox.js';
import { createEmailNoticeSender, planOrderMergeNotices, readOrderNoticeLedger, sendOrderMergeNotices } from '../src/core/fleet/order-merge-notice.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const dirs: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'order-email-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const trace: OrderTraceV1 = { v: 1, generatedAt: '', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '', source: 'email (e-42)', key: '11-01 00:08', jobs: [{ id: 'RQ-FAKE1', lane: null, state: 'merged', url: null }] }] };

function setup(from: string[] | null): { root: string; outbox: string; senders: Parameters<typeof sendOrderMergeNotices>[2] } {
  const base = temp(); const runs = join(base, 'runs'); const outbox = join(base, 'outbox');
  if (from) {
    mkdirSync(join(runs, 'queue'), { recursive: true });
    writeFileSync(join(runs, 'queue', 'email-drop.json'), JSON.stringify({ v: 1, inboxDir: join(base, 'inbox'), outboxDir: outbox, from }));
  }
  return { root: join(base, 'root'), outbox, senders: { email: createEmailNoticeSender(runs) } };
}
const notices = () => planOrderMergeNotices(trace, new Set());

it('queues one reply for the single allowed sender, idempotently', async () => {
  const { root, outbox, senders } = setup(['mason@example.test']);
  expect(await sendOrderMergeNotices(root, notices(), senders)).toEqual({ sent: 1, skipped: 0, failed: 0 });
  const listing = readEmailOutbox(outbox);
  expect(listing.counts).toEqual({ queued: 1, sent: 0, stuck: 0 });
  expect(listing.entries[0]).toMatchObject({ state: 'queued', to: 'mason@example.test', subject: 'Phantom: merged for your order' });
  expect(statSync(join(outbox, listing.entries[0]!.name)).mode & 0o777).toBe(0o600);
  expect(readOrderNoticeLedger(root).has('e-42:RQ-FAKE1')).toBe(true);
  // Simulate a lost ledger: the retry must overwrite the same file, not add one.
  rmSync(join(root, 'queue', 'order-notices.jsonl'));
  await sendOrderMergeNotices(root, notices(), senders);
  expect(readdirSync(outbox)).toHaveLength(1);
});

it('fails and leaves no ledger row when config is missing', async () => {
  const { root, senders } = setup(null);
  expect(await sendOrderMergeNotices(root, notices(), senders)).toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(readOrderNoticeLedger(root).size).toBe(0);
});

it('fails rather than guessing between two allowed senders', async () => {
  const { root, outbox, senders } = setup(['mason@example.test', 'other@example.test']);
  expect(await sendOrderMergeNotices(root, notices(), senders)).toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(readOrderNoticeLedger(root).size).toBe(0);
  expect(readEmailOutbox(outbox).entries).toEqual([]);
});
