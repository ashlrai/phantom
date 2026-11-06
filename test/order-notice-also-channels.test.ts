import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { planOrderMergeNotices, sendOrderMergeNotices } from '../src/core/fleet/order-merge-notice.js';
import { readOrderTrace, type OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const line = '2026-11-03T10:00:00Z [src:phone id:phone-abc] ';
const roots: string[] = [];
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'order-also-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const trace = (alsoChannels = ['telegram']): OrderTraceV1 => ({
  v: 1, generatedAt: '', sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '', source: 'phone (phone-abc)', alsoChannels, key: '11-03 05:00',
    jobs: [{ id: 'RQ-EXAMPLE', lane: null, state: 'merged', url: null }] }],
});

it('strips attribution from the first body line and preserves continuation text', () => {
  const entry = parseInbox(`${line}[also:telegram,email] ship it`)[0]!;
  expect(entry.text).toBe('ship it');
  expect(entry.alsoChannels).toEqual(['telegram', 'email']);
  expect(parseInbox(`${line}[also:telegram] ship it\n[also:email] literal`)[0]!.text)
    .toBe('ship it\n[also:email] literal');
});
it('leaves entries without attribution unchanged', () => {
  const entry = parseInbox(`${line}ship it`)[0]!;
  expect(entry.text).toBe('ship it');
  expect(entry).not.toHaveProperty('alsoChannels');
});
it('drops invalid tokens and the primary channel', () => {
  expect(parseInbox(`${line}[also:telegram,bad!,phone,${'x'.repeat(33)},email] ship it`)[0]!.alsoChannels)
    .toEqual(['telegram', 'email']);
});
it('carries attribution into the order trace', async () => {
  const root = temp();
  mkdirSync(join(root, 'leader'));
  writeFileSync(join(root, 'leader', 'MASON-INBOX.md'), `${line}[also:telegram] ship it`);
  const result = await readOrderTrace({ runsDir: root });
  expect(result.orders[0]).toMatchObject({ source: 'phone (phone-abc)', alsoChannels: ['telegram'] });
});
it('keeps the primary notice unchanged and plans extra routes independently', () => {
  const primary = planOrderMergeNotices(trace([]), new Set())[0]!;
  const notices = planOrderMergeNotices(trace(['telegram', 'telegram', 'phone']), new Set());
  expect(notices).toEqual([primary, { ...primary, channel: 'telegram', key: 'phone-abc:RQ-EXAMPLE:telegram' }]);
  expect(primary.key).toBe('phone-abc:RQ-EXAMPLE');
  expect(planOrderMergeNotices(trace(), new Set([primary.key]))).toEqual([notices[1]]);
});
it('sends each route once and dedupes subsequent sends', async () => {
  const root = temp();
  const senders = { phone: vi.fn(async () => {}), telegram: vi.fn(async () => {}) };
  const notices = planOrderMergeNotices(trace(), new Set());
  expect(await sendOrderMergeNotices(root, notices, senders)).toEqual({ sent: 2, skipped: 0, failed: 0 });
  expect(await sendOrderMergeNotices(root, notices, senders)).toEqual({ sent: 0, skipped: 0, failed: 0 });
  expect(senders.phone).toHaveBeenCalledTimes(1);
  expect(senders.telegram).toHaveBeenCalledTimes(1);
});
