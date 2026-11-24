import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listOwnerThreadArchives, readOwnerThreadHistory } from '../src/core/comms/owner-thread-archive.js';
import { acceptOwnerInbound, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-history-')); roots.push(runsDir);
  const dir = join(runsDir, 'leader'); mkdirSync(dir, { mode: 0o700 });
  return { runsDir, dir };
}
function message(seq: number, text = `fake message ${seq}`) {
  return { seq, id: `m${seq}`, idempotencyKey: `message-${seq}`, channel: 'desktop', senderId: 'owner', direction: 'inbound', at: '2026-01-01', text };
}
function archive(dir: string, first: number, last: number, messages: unknown[]) {
  writeFileSync(join(dir, `owner-thread-archive-${first}-${last}.json`), JSON.stringify({ v: 1, threadId: 'owner', messages }), { mode: 0o600 });
}
it('lists regular archives and pages, skipping damaged files and scrubbing text', () => {
  const f = fixture();
  archive(f.dir, 1, 2, [message(1), message(2, `token=${'a'.repeat(30)}`)]);
  archive(f.dir, 3, 4, [message(3), message(4)]);
  writeFileSync(join(f.dir, 'owner-thread-archive-5-5.json'), '{');
  writeFileSync(join(f.dir, 'owner-thread-archive-6-6.json'), 'x'.repeat(2 * 1_048_576 + 1));
  writeFileSync(join(f.dir, 'owner-thread-archive-7-7.json.bak'), '{}');
  symlinkSync(join(f.dir, 'owner-thread-archive-1-2.json'), join(f.dir, 'owner-thread-archive-8-8.json'));
  expect(listOwnerThreadArchives(f).map(a => a.firstSeq)).toEqual([1, 3, 5, 6]);
  const result = readOwnerThreadHistory(f, { limit: 3 });
  expect(result).toMatchObject({ archives: 4, skipped: 2 });
  expect(result.messages.map(m => m.seq)).toEqual([2, 3, 4]);
  expect(result.messages[0]!.text).toContain('[REDACTED]');
  expect(readOwnerThreadHistory(f, { before: 4, limit: 2 }).messages.map(m => m.seq)).toEqual([2, 3]);
  expect(listOwnerThreadArchives({ runsDir: join(f.runsDir, 'missing') })).toEqual([]);
});
it('applies the shared thread view filters to archived pages', () => {
  const f = fixture();
  archive(f.dir, 1, 3, [
    { seq: 1, id: 'm1', idempotencyKey: 'k1', channel: 'desktop', senderId: 'owner', direction: 'inbound', at: '2026-01-01T00:00:00.000Z', text: 'deploy the fix' },
    { seq: 2, id: 'm2', idempotencyKey: 'k2', channel: 'telegram', senderId: 'owner', direction: 'outbound', at: '2026-01-02T00:00:00.000Z', text: 'shipped it' },
    { seq: 3, id: 'm3', idempotencyKey: 'k3', channel: 'email', senderId: 'owner', direction: 'inbound', at: 'not-a-date', text: 'please review the fix' },
  ]);
  const seqs = (page: Parameters<typeof readOwnerThreadHistory>[1]) => readOwnerThreadHistory(f, page).messages.map(m => m.seq);
  expect(seqs({ channel: 'telegram' })).toEqual([2]);
  expect(seqs({ direction: 'outbound' })).toEqual([2]);
  // The unparseable `at` on seq 3 never satisfies a since floor or a beforeAt ceiling.
  expect(seqs({ since: Date.parse('2026-01-01T12:00:00.000Z') })).toEqual([2]);
  // seq 2 sits exactly at the ceiling — exclusive, like every other comms read's --before.
  expect(seqs({ beforeAt: Date.parse('2026-01-02T00:00:00.000Z') })).toEqual([1]);
  expect(seqs({ since: Date.parse('2026-01-01T12:00:00.000Z'), beforeAt: Date.parse('2026-01-03T00:00:00.000Z') })).toEqual([2]);
  expect(seqs({ contains: 'DEPLOY' })).toEqual([1]);
  expect(seqs({ contains: 'the fix' })).toEqual([1, 3]);
  expect(seqs({ channel: 'email', direction: 'inbound' })).toEqual([3]);
  expect(seqs({ before: 3, contains: 'fix' })).toEqual([1]);
  expect(seqs({ contains: 'fix', limit: 1 })).toEqual([3]);
  const filtered = readOwnerThreadHistory(f, { channel: 'slack' });
  expect(filtered.messages).toEqual([]);
  expect(filtered).toMatchObject({ archives: 1, skipped: 0 });
});
it('reads archives produced by real rotation', async () => {
  const f = fixture();
  const options: OwnerThreadOptions = { runsDir: f.runsDir, busRoot: join(f.runsDir, 'bus'), capacity: { messages: 4, bytes: 1_048_576 },
    settings: { owners: { desktop: 'local-owner' }, secretHandles: {}, confirmed: true, team: [{ channel: 'bus', id: 'local-owner' }] },
    mailbox: { async accept() { return { status: 'accepted' }; } } };
  for (let n = 1; n <= 8; n++) {
    expect((await acceptOwnerInbound({ channel: 'desktop', senderId: 'local-owner', text: `fake message ${n}`, idempotencyKey: `message-${n}`, at: 1_700_000_000_000 }, options)).status).toBe('accepted');
  }
  expect(readOwnerThreadHistory(f).messages.map(m => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
});
