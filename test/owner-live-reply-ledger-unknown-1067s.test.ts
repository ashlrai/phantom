import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import { OWNER_LIVE_REPLY_INTERVAL_MS, replyHash, sendLeaderReplyToPhone } from '../src/core/comms/owner-live-reply.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'reply-unknown-')); roots.push(runsDir);
  const clock = { t: 1_700_000_000_000 };
  const calls = { n: 0 };
  const settings = { ...emptyOwnerSettings(), owners: { imessage: 'fake-owner' }, imessageBridge: 'loopback' as const, confirmed: true, team: [{ channel: 'imessage' as const, id: 'fake-owner' }] };
  const transports = { imessage: { async pull() { return []; }, async deliver() { calls.n++; return { status: 'sent' as const, reason: 'sent' }; } } };
  const options: OwnerThreadOptions = { runsDir, now: () => clock.t, settings, transports };
  const run = (text = 'First reply', apply = true) => sendLeaderReplyToPhone(options, { apply, halted: false, paused: false, replies: [{ at: '2026-11-21', text, source: 'plan-log' }] });
  const dir = join(runsDir, 'leader'); const state = join(dir, 'owner-live-reply.json');
  const put = (body: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(state, body); };
  return { clock, calls, run, put, state, dir, lock: join(dir, 'owner-live-reply.lock') };
}

it('absent ledger permits first delivery', async () => {
  const f = fixture();
  expect((await f.run()).reason).toBe('sent');
  expect(f.calls.n).toBe(1);
});
const h = replyHash('First reply');
const broken: [string, string][] = [
  ['malformed JSON', '{not json'],
  ['array root', '[]'],
  ['non-string hash', JSON.stringify({ lastSentAt: 0, hashes: [1] })],
  ['evidence not an array', JSON.stringify({ lastSentAt: 0, hashes: [h], delivered: { [h]: 'imessage' } })],
  ['unknown channel in evidence', JSON.stringify({ lastSentAt: 0, hashes: [h], delivered: { [h]: ['fax'] } })],
];
for (const [name, body] of broken) {
  it(`unknown history (${name}): no send, bytes preserved, dry-run not planned, lock released`, async () => {
    const f = fixture();
    f.put(body);
    for (const r of [await f.run('First reply', false), await f.run(), await f.run('Other reply')]) expect(r.reason).toBe('not-delivered');
    expect(f.calls.n).toBe(0);
    expect(readFileSync(f.state, 'utf8')).toBe(body);
    expect(existsSync(f.lock)).toBe(false);
    expect(existsSync(`${f.state}.tmp`)).toBe(false);
  });
}

it('a non-ENOENT read error (directory at the ledger path) is unknown history', async () => {
  const f = fixture();
  mkdirSync(f.state, { recursive: true });
  expect((await f.run()).reason).toBe('not-delivered');
  expect(f.calls.n).toBe(0);
  expect(existsSync(f.lock)).toBe(false);
  rmSync(f.state, { recursive: true });
  expect((await f.run()).reason).toBe('sent');
});

it('legacy hashes without destination evidence stay deduped', async () => {
  const f = fixture();
  f.put(JSON.stringify({ lastSentAt: 0, hashes: [h] }));
  expect((await f.run()).reason).toBe('already-sent');
  expect(f.calls.n).toBe(0);
});

it('repairing the ledger with valid evidence suppresses a repeat, then a distinct update delivers', async () => {
  const f = fixture();
  f.put('garbage');
  expect((await f.run()).reason).toBe('not-delivered');
  f.put(JSON.stringify({ lastSentAt: f.clock.t, hashes: [h], delivered: { [h]: ['imessage'] } }));
  expect((await f.run()).reason).toBe('already-sent');
  f.clock.t += OWNER_LIVE_REPLY_INTERVAL_MS;
  expect((await f.run('Distinct update')).reason).toBe('sent');
  expect(f.calls.n).toBe(1);
});
