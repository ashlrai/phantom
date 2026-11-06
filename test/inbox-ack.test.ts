import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acknowledgeInboxEntries, inboxAckEntry, planInboxAcks } from '../src/core/fleet/inbox-ack.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'inbox-ack-')); roots.push(dir); return dir; };
afterEach(() => roots.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const at = '2026-11-02T12:00:00Z';
const line = (channel: string, id = channel) => `${at} [src:${channel} id:${id}] Please steer the fleet`;

it('plans one ack per ID, preserves all channels, and excludes recorded IDs', () => {
  const entries = ['desktop', 'telegram', 'email', 'phone'].map(c => inboxAckEntry(line(c), at));
  const first = planInboxAcks([...entries, entries[0]!], new Set());
  expect(first.map(a => a.channel)).toEqual(['desktop', 'telegram', 'email', 'phone']);
  expect(first[0]?.text).toBe(`Got it: Please steer the fleet. In the planner brief at ${at}.`);
  expect(planInboxAcks(entries, new Set(first.map(a => a.entryId)))).toEqual([]);
});

it('persists dedupe across runs and retries sender failure', async () => {
  const dir = root();
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const run = () => acknowledgeInboxEntries([line('desktop'), line('desktop')], dir, at, { desktop: send });
  await run();
  expect(existsSync(join(dir, 'queue', 'inbox-acks.jsonl'))).toBe(false);
  await run();
  await run();
  expect(send).toHaveBeenCalledTimes(2);
  expect(readFileSync(join(dir, 'queue', 'inbox-acks.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

it('records legacy and unknown routes as skipped without sending', async () => {
  const dir = root();
  const send = vi.fn();
  const legacy = '## 2026-11-02 12:00 ET (Mason, desktop) PRIORITY P0\nlegacy';
  expect(planInboxAcks([inboxAckEntry(legacy, at)], new Set())).toEqual([]);
  await acknowledgeInboxEntries([legacy, line('unknown'), line('phone')], dir, at, { desktop: send });
  expect(send).not.toHaveBeenCalled();
  const rows = readFileSync(join(dir, 'queue', 'inbox-acks.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  expect(rows).toHaveLength(3);
  expect(rows.every(row => row.status === 'skipped' && row.reason)).toBe(true);
});

it('serializes concurrent builders and keeps hash IDs stable', async () => {
  const dir = root();
  const send = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const raw = `${at} [src:desktop] hash identity`;
  expect(inboxAckEntry(raw, at).entryId).toBe(inboxAckEntry(raw, 'later').entryId);
  await Promise.all([1, 2].map(() => acknowledgeInboxEntries([raw], dir, at, { desktop: send })));
  expect(send).toHaveBeenCalledTimes(1);
});
