import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readOwnerThreadHistory } from '../src/core/comms/owner-thread-archive.js';
import type { OwnerThreadMessage } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-history-overlap-')); roots.push(runsDir);
  const dir = join(runsDir, 'leader'); mkdirSync(dir, { mode: 0o700 });
  return { runsDir, dir };
}
function message(seq: number, text = `fake message ${seq}`): OwnerThreadMessage {
  return {
    seq, id: `m${seq}`, idempotencyKey: `idem-${seq}-owner-thread`, channel: 'desktop',
    senderId: 'owner', direction: 'inbound', at: '2026-01-01T00:00:00.000Z', text,
  };
}
function archive(dir: string, first: number, last: number, messages: unknown[]) {
  writeFileSync(join(dir, `owner-thread-archive-${first}-${last}.json`),
    JSON.stringify({ v: 1, threadId: 'owner', messages }), { mode: 0o600 });
}
const seqs = (result: ReturnType<typeof readOwnerThreadHistory>) => result.messages.map(m => m.seq);

it('merges identical copies from overlapping archives so the page holds unique rows', () => {
  const f = fixture();
  // Written out of sorted order: enumeration order must not matter.
  archive(f.dir, 8, 12, [8, 9, 10, 11, 12].map(seq => {
    const copy = message(seq);
    if (seq === 12) copy.text = `token=${'a'.repeat(30)}`;
    return copy;
  }));
  archive(f.dir, 1, 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(seq => message(seq)));
  const result = readOwnerThreadHistory(f, { limit: 4 });
  expect(result).toMatchObject({ archives: 2, skipped: 0 });
  expect(seqs(result)).toEqual([9, 10, 11, 12]);
  expect(new Set(seqs(result)).size).toBe(4);
  expect(result.messages[3]!.text).toContain('[REDACTED]');
});

it('pages backward through overlaps without repeating a message', () => {
  const f = fixture();
  archive(f.dir, 1, 10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(seq => message(seq)));
  archive(f.dir, 8, 12, [8, 9, 10, 11, 12].map(seq => message(seq)));
  const pages: number[][] = [];
  let before: number | undefined;
  for (let page = 0; page < 4; page++) {
    const result = readOwnerThreadHistory(f, { limit: 4, ...(before === undefined ? {} : { before }) });
    if (result.messages.length === 0) break;
    pages.push(seqs(result));
    before = result.messages[0]!.seq;
  }
  expect(pages).toEqual([[9, 10, 11, 12], [5, 6, 7, 8], [1, 2, 3, 4]]);
  expect(pages.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

it('keeps conflicting same-seq copies as distinct rows in deterministic order', () => {
  const f = fixture();
  archive(f.dir, 1, 10, [message(9, 'overlap copy'), message(10)]);
  archive(f.dir, 7, 9, [message(8), message(9, 'newer archive copy')]);
  const first = readOwnerThreadHistory(f, { limit: 3 });
  const second = readOwnerThreadHistory(f, { limit: 3 });
  expect(first.messages.map(m => [m.seq, m.text])).toEqual([
    [9, 'newer archive copy'], [9, 'overlap copy'], [10, 'fake message 10'],
  ]);
  expect(second.messages).toEqual(first.messages);
});

it('leaves non-overlapping archives and damaged or linked files unchanged', () => {
  const f = fixture();
  archive(f.dir, 1, 3, [1, 2, 3].map(seq => message(seq)));
  archive(f.dir, 4, 6, [4, 5, 6].map(seq => message(seq)));
  archive(f.dir, 7, 7, [message(7, 'same text')]);
  archive(f.dir, 8, 8, [message(8, 'same text')]);
  writeFileSync(join(f.dir, 'owner-thread-archive-9-9.json'), '{');
  symlinkSync(join(f.dir, 'owner-thread-archive-1-3.json'), join(f.dir, 'owner-thread-archive-10-10.json'));
  const result = readOwnerThreadHistory(f, { limit: 10 });
  expect(result).toMatchObject({ archives: 5, skipped: 1 });
  expect(seqs(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});
