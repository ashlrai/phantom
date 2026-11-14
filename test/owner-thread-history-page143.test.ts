import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as stableRead from '../src/core/util/stable-file-read.js';
import { readOwnerThreadHistory } from '../src/core/comms/owner-thread-archive.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'history-page-')); roots.push(runsDir);
  const dir = join(runsDir, 'leader'); mkdirSync(dir, { mode: 0o700 });
  return { runsDir, dir };
}
function message(seq: number, text = `message ${seq}`) {
  return { seq, id: `m${seq}`, idempotencyKey: `key${seq}`, senderId: 'owner', channel: 'desktop', direction: 'inbound', at: '2026-01-01', text };
}
function archive(dir: string, first: number, last: number, messages: unknown[]) {
  writeFileSync(join(dir, `owner-thread-archive-${first}-${last}.json`), JSON.stringify({ v: 1, threadId: 'owner', messages }), { mode: 0o600 });
}

it('stops before reading irrelevant older files and honors the exclusive cursor', () => {
  const f = fixture();
  archive(f.dir, 1, 2, [message(1), message(2)]);
  archive(f.dir, 3, 4, [message(3), message(4)]);
  archive(f.dir, 5, 6, [message(5), message(6, `token=${'a'.repeat(30)}`)]);
  const spy = vi.spyOn(stableRead, 'readStableRegularFile');
  const newest = readOwnerThreadHistory(f, { limit: 2 });
  expect(newest.messages.map(m => m.seq)).toEqual([5, 6]);
  expect(newest.messages[1]!.text).toContain('[REDACTED]');
  expect(newest).toMatchObject({ archives: 3, skipped: 0 });
  expect(spy.mock.calls.map(([path]) => path)).toEqual([join(f.dir, 'owner-thread-archive-5-6.json')]);
  spy.mockClear();
  expect(readOwnerThreadHistory(f, { before: 5, limit: 2 }).messages.map(m => m.seq)).toEqual([3, 4]);
  expect(spy.mock.calls.map(([path]) => path)).toEqual([join(f.dir, 'owner-thread-archive-3-4.json')]);
});

it('reads overlapping ranges, including equal boundary sequences', () => {
  const f = fixture();
  archive(f.dir, 1, 10, [message(9, 'overlap'), message(10)]);
  archive(f.dir, 5, 6, [message(5), message(6)]);
  archive(f.dir, 7, 9, [message(8), message(9, 'newer archive')]);
  const result = readOwnerThreadHistory(f, { limit: 3 });
  expect(result.messages.map(m => [m.seq, m.text])).toEqual([[9, 'newer archive'], [9, 'overlap'], [10, 'message 10']]);
});

it('counts only attempted malformed and unreadable archives as skipped', () => {
  const f = fixture();
  archive(f.dir, 1, 1, [message(1)]);
  writeFileSync(join(f.dir, 'owner-thread-archive-2-2.json'), '{');
  archive(f.dir, 3, 3, [message(3)]);
  writeFileSync(join(f.dir, 'owner-thread-archive-4-4.json'), '{}');
  const original = stableRead.readStableRegularFile;
  const spy = vi.spyOn(stableRead, 'readStableRegularFile').mockImplementation((path, options) =>
    path.endsWith('4-4.json') ? { ok: false, reason: 'io-error' } : original(path, options));
  const result = readOwnerThreadHistory(f, { limit: 2 });
  expect(result.messages.map(m => m.seq)).toEqual([1, 3]);
  expect(result.skipped).toBe(2);
  spy.mockRestore();
  archive(f.dir, 5, 6, [message(5), message(6)]);
  expect(readOwnerThreadHistory(f, { limit: 2 })).toMatchObject({ skipped: 0, archives: 5 });
});

it('keeps the total byte budget when a page is not full', () => {
  const f = fixture();
  for (let seq = 1; seq <= 5; seq++) archive(f.dir, seq, seq, [message(seq, 'x'.repeat(1_700_000))]);
  const result = readOwnerThreadHistory(f, { limit: 10 });
  expect(result.messages.map(m => m.seq)).toEqual([2, 3, 4, 5]);
  expect(result.skipped).toBe(1);
});
