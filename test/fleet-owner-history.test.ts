import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { cmdFleetOwnerHistory } from '../src/cli/fleet-owner-history.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it('prints paged JSON and text, and validates arguments', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'fleet-history-')); roots.push(runsDir);
  const dir = join(runsDir, 'leader'); mkdirSync(dir, { mode: 0o700 });
  const messages = [1, 2].map(seq => ({ seq, id: `m${seq}`, idempotencyKey: `message-${seq}`, channel: 'desktop', senderId: 'owner', direction: 'inbound', at: 'today', text: `fake message ${seq}` }));
  writeFileSync(join(dir, 'owner-thread-archive-1-2.json'), JSON.stringify({ v: 1, threadId: 'owner', messages }), { mode: 0o600 });
  const lines: string[] = []; const errors: string[] = [];
  const deps = { options: { runsDir }, output: (s: string) => lines.push(s), error: (s: string) => errors.push(s) };
  expect(await cmdFleetOwnerHistory(['--json', '--before', '2', '--limit', '1'], deps)).toBe(0);
  expect(JSON.parse(lines.pop()!)).toMatchObject({ schema: 'comms.owner-thread-history.v1', messages: [{ seq: 1 }] });
  expect(await cmdFleetOwnerHistory([], deps)).toBe(0);
  expect(lines).toEqual(['#1 today desktop inbound fake message 1', '#2 today desktop inbound fake message 2', 'archives: 1, skipped: 0']);
  for (const args of [['--limit', '0'], ['--before', 'no'], ['--json', '--json'], ['extra'], ['--limit']]) expect(await cmdFleetOwnerHistory(args, deps)).toBe(2);
  expect(errors).toHaveLength(5);
  expect(await cmdFleetOwnerHistory(['--help'], deps)).toBe(0);
});
it('slices archived pages with the shared thread view flags', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'fleet-history-filter-')); roots.push(runsDir);
  const dir = join(runsDir, 'leader'); mkdirSync(dir, { mode: 0o700 });
  const messages = [
    { seq: 1, id: 'm1', idempotencyKey: 'k1', channel: 'desktop', senderId: 'owner', direction: 'inbound', at: '2026-01-01T00:00:00.000Z', text: 'deploy the fix' },
    { seq: 2, id: 'm2', idempotencyKey: 'k2', channel: 'telegram', senderId: 'owner', direction: 'outbound', at: '2026-01-02T00:00:00.000Z', text: 'shipped it' },
    { seq: 3, id: 'm3', idempotencyKey: 'k3', channel: 'email', senderId: 'owner', direction: 'inbound', at: '2026-01-03T00:00:00.000Z', text: 'please review the fix' },
  ];
  writeFileSync(join(dir, 'owner-thread-archive-1-3.json'), JSON.stringify({ v: 1, threadId: 'owner', messages }), { mode: 0o600 });
  const lines: string[] = []; const errors: string[] = [];
  const deps = { options: { runsDir }, output: (s: string) => lines.push(s), error: (s: string) => errors.push(s) };
  const seqs = async (args: string[]) => {
    lines.length = 0;
    expect(await cmdFleetOwnerHistory([...args, '--json'], deps)).toBe(0);
    return (JSON.parse(lines.pop()!) as { messages: Array<{ seq: number }> }).messages.map(m => m.seq);
  };
  expect(await seqs(['--channel', 'telegram'])).toEqual([2]);
  expect(await seqs(['--direction', 'outbound'])).toEqual([2]);
  expect(await seqs(['--since', '2026-01-02T00:00:00Z'])).toEqual([2, 3]);
  // seq 2 sits exactly at the ceiling — exclusive, like every other comms read's --before.
  expect(await seqs(['--before-at', '2026-01-02T00:00:00Z'])).toEqual([1]);
  expect(await seqs(['--since', '2026-01-01T12:00:00Z', '--before-at', '2026-01-03T00:00:00Z'])).toEqual([2]);
  expect(await seqs(['--contains', 'the fix'])).toEqual([1, 3]);
  expect(await seqs(['--channel', 'email', '--before', '4'])).toEqual([3]);
  expect(await seqs(['--channel', 'slack'])).toEqual([]);
  const beforeErrors = errors.length;
  for (const args of [['--channel', 'sms'], ['--direction', 'sideways'], ['--since', 'bogus'], ['--before-at', 'bogus'], ['--contains', ''], ['--channel', 'desktop', '--channel', 'telegram'], ['--contains', '--json']]) {
    expect(await cmdFleetOwnerHistory(args, deps)).toBe(2);
  }
  expect(errors.length - beforeErrors).toBe(13);
  expect(errors[beforeErrors]).toContain('--channel takes one of');
});
