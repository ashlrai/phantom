import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { orderSourceRoute, planOrderMergeNotices, sendOrderMergeNotices } from '../src/core/fleet/order-merge-notice.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const dirs: string[] = [];
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'order-notices-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const trace = (): OrderTraceV1 => ({ v: 1, generatedAt: '',
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '', source: 'desktop (desk-fake)', key: '11-01 00:08', jobs:
    ['queued', 'launched', 'published', 'merged', 'merged'].map((state, i) => ({
      id: `RQ-FAKE${i}`, lane: null, state: state as 'merged', url: 'https://example.com/fake',
    })) }] });

it('parses channel routes strictly and skips legacy headings', () => {
  for (const channel of ['desktop', 'phone', 'telegram']) {
    expect(orderSourceRoute(`${channel} (fake-01)`)).toEqual({ channel, entryId: 'fake-01' });
  }
  for (const source of ['Mason, desktop', '## 2026-11-01 00:08 ET (Mason, order)',
    'Desktop (fake)', 'desktop (bad id)', 'desktop (fake)\n', `${'x'.repeat(33)} (fake)`, `phone (${'x'.repeat(65)})`]) {
    expect(orderSourceRoute(source)).toBeNull();
  }
});
it('plans merged pairs once, excludes sent pairs, and includes order key and URL', () => {
  const input = trace();
  input.orders.push(input.orders[0]!);
  expect(planOrderMergeNotices(input, new Set())).toHaveLength(2);
  const notices = planOrderMergeNotices(input, new Set(['desk-fake:RQ-FAKE3']));
  expect(notices).toHaveLength(1);
  expect(notices[0]!.text).toBe('Merged: RQ-FAKE4 for your 11-01 00:08 order (https://example.com/fake).');
  input.orders[0]!.source = 'Mason';
  expect(planOrderMergeNotices(input, new Set())).toEqual([]);
});
it('caps scrubbed text at 200 characters', () => {
  const input = trace();
  input.orders[0]!.jobs[3]!.url = `https://example.com/${'x'.repeat(300)}`;
  expect(planOrderMergeNotices(input, new Set())[0]!.text).toHaveLength(200);
});
it('sends once across calls, ignoring malformed ledger rows', async () => {
  const root = temp();
  mkdirSync(join(root, 'queue'));
  writeFileSync(join(root, 'queue', 'order-notices.jsonl'), 'null\n{"broken":');
  const notices = planOrderMergeNotices(trace(), new Set());
  let calls = 0;
  const senders = { desktop: async () => { calls++; } };
  expect(await sendOrderMergeNotices(root, [...notices, ...notices], senders)).toEqual({ sent: 2, skipped: 0, failed: 0 });
  expect(await sendOrderMergeNotices(root, notices, senders)).toEqual({ sent: 0, skipped: 0, failed: 0 });
  expect(calls).toBe(2);
});
it('retries throwing senders and records unsupported channels as skipped', async () => {
  const root = temp();
  const notices = planOrderMergeNotices(trace(), new Set()).slice(0, 1);
  expect(await sendOrderMergeNotices(root, notices, { desktop: async () => { throw new Error('fake'); } }))
    .toEqual({ sent: 0, skipped: 0, failed: 1 });
  expect(await sendOrderMergeNotices(root, notices, { desktop: async () => {} })).toEqual({ sent: 1, skipped: 0, failed: 0 });
  const unsupported = [{ ...notices[0]!, key: 'email-fake:RQ-FAKE', channel: 'email' }];
  expect(await sendOrderMergeNotices(root, unsupported, {})).toEqual({ sent: 0, skipped: 1, failed: 0 });
  expect(readFileSync(join(root, 'queue', 'order-notices.jsonl'), 'utf8')).toContain('channel has no sender');
  expect(await sendOrderMergeNotices(root, unsupported, {})).toEqual({ sent: 0, skipped: 0, failed: 0 });
});
it('sends nothing while the ledger lock is held', async () => {
  const root = temp();
  mkdirSync(join(root, 'queue'), { mode: 0o700 });
  const acquired = acquireLocalStoreLockWithOutcome(join(root, 'queue', 'order-notices.jsonl.lock'), 0);
  expect(acquired.state).toBe('acquired');
  if (acquired.state !== 'acquired') throw new Error('fixture lock failed');
  try {
    expect(await sendOrderMergeNotices(root, planOrderMergeNotices(trace(), new Set()), {
      desktop: async () => { throw new Error('must not send'); },
    })).toEqual({ sent: 0, skipped: 0, failed: 0 });
  } finally { releaseLocalStoreLock(acquired.lock); }
});
