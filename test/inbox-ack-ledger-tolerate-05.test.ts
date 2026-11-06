import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { acknowledgeInboxEntries, inboxAckEntry, type InboxAck } from '../src/core/fleet/inbox-ack.js';

const roots: string[] = [];
const at = '2026-11-02T05:00:00.000Z';
const line = (id: string) => `${at} [src:desktop id:${id}] hello`;
const torn = '{"entryId":"desk-aaaa","sta';
function fixture(ledger: string) {
  const root = mkdtempSync(join(tmpdir(), 'inbox-ack-ledger-05-'));
  roots.push(root);
  mkdirSync(join(root, 'queue'));
  const path = join(root, 'queue', 'inbox-acks.jsonl');
  writeFileSync(path, ledger, { mode: 0o600 });
  return { root, path };
}
const rows = (path: string) => readFileSync(path, 'utf8').trimEnd().split('\n');
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it('preserves a torn row while separating new records and honoring previous acknowledgements', async () => {
  const previous = JSON.stringify({ entryId: 'desk-aaaaaaaaaaaaaaaa', status: 'acked' });
  const { root, path } = fixture(`${previous}\n${torn}`);
  const send = vi.fn(async (_ack: InboxAck) => {});
  await acknowledgeInboxEntries([line('desk-aaaaaaaaaaaaaaaa'), line('desk-0123456789abcdef')], root, at, { desktop: send });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toMatchObject({ entryId: 'desk-0123456789abcdef', channel: 'desktop' });
  expect(rows(path).filter(row => row !== torn).map(row => JSON.parse(row))).toEqual([
    { entryId: 'desk-aaaaaaaaaaaaaaaa', status: 'acked' },
    { entryId: 'desk-0123456789abcdef', status: 'acked' },
  ]);
  expect(rows(path)[1]).toBe(torn);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it('ignores malformed shapes and records a new acknowledgement', async () => {
  const { root, path } = fixture('null\n42\n{"status":"acked"}\n{"entryId":"desk-0123456789abcdef","status":42}\n');
  const send = vi.fn(async (_ack: InboxAck) => {});
  await acknowledgeInboxEntries([line('desk-0123456789abcdef')], root, at, { desktop: send });
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(rows(path).at(-1)!)).toEqual({ entryId: 'desk-0123456789abcdef', status: 'acked' });
});

it('deduplicates repeated calls with malformed lines present', async () => {
  const { root, path } = fixture(torn);
  const send = vi.fn(async (_ack: InboxAck) => {});
  for (let call = 0; call < 2; call++) {
    await acknowledgeInboxEntries([line('desk-0123456789abcdef')], root, at, { desktop: send });
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(rows(path)).toHaveLength(2);
});

it('records legacy entries as skipped even after a torn row', async () => {
  const { root, path } = fixture(torn);
  const legacy = 'legacy entry with no channel';
  const send = vi.fn(async (_ack: InboxAck) => {});
  await acknowledgeInboxEntries([legacy], root, at, { desktop: send });
  expect(send).not.toHaveBeenCalled();
  expect(JSON.parse(rows(path)[1]!)).toEqual({ entryId: inboxAckEntry(legacy, at).entryId,
    status: 'skipped', reason: 'legacy entry has no channel' });
});
