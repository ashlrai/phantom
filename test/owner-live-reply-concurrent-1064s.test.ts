import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyOwnerSettings, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { OWNER_LIVE_REPLY_INTERVAL_MS, sendLeaderReplyToPhone } from '../src/core/comms/owner-live-reply.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(deliver: OwnerChannelTransport['deliver']) {
  const runsDir = mkdtempSync(join(tmpdir(), 'reply-serial-')); roots.push(runsDir);
  const clock = { t: 1_700_000_000_000 };
  const options: OwnerThreadOptions = {
    runsDir, now: () => clock.t,
    settings: { ...emptyOwnerSettings(), owners: { imessage: 'fake-owner' }, imessageBridge: 'loopback', confirmed: true,
      team: [{ channel: 'imessage', id: 'fake-owner' }] },
    transports: { imessage: { async pull() { return []; }, deliver } },
  };
  const run = (text = 'First reply', apply = true) => sendLeaderReplyToPhone(options, {
    apply, halted: false, paused: false, replies: [{ at: '2026-11-21', text, source: 'plan-log' }],
  });
  return { runsDir, clock, run, state: join(runsDir, 'leader', 'owner-live-reply.json'), lock: join(runsDir, 'leader', 'owner-live-reply.lock') };
}

it('serializes overlapping sends and preserves the completed record', async () => {
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const f = fixture(async () => { calls++; if (calls === 1) { enter(); await waiting; } return { status: 'sent', reason: 'sent' }; });
  const first = f.run();
  await entered;
  expect((await f.run('Other reply')).reason).toBe('not-delivered');
  expect(calls).toBe(1);
  expect(existsSync(f.state)).toBe(false);
  finish();
  expect((await first).reason).toBe('sent');
  const saved = readFileSync(f.state, 'utf8');
  expect(existsSync(f.lock)).toBe(false);
  expect((await f.run()).reason).toBe('already-sent');
  expect(readFileSync(f.state, 'utf8')).toBe(saved);
  f.clock.t += OWNER_LIVE_REPLY_INTERVAL_MS;
  expect((await f.run('New reply')).reason).toBe('sent');
  expect(calls).toBe(2);
});

it('releases the lock after a throwing transport and permits retry', async () => {
  let calls = 0;
  const f = fixture(async () => { if (++calls === 1) throw new Error('fake failure'); return { status: 'sent', reason: 'sent' }; });
  expect((await f.run()).reason).toBe('not-delivered');
  expect(existsSync(f.lock)).toBe(false);
  expect((await f.run()).reason).toBe('sent');
  expect(calls).toBe(2);
});

it('does not create state or lock on dry-run and refuses an unavailable lock', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { status: 'sent', reason: 'sent' }; });
  expect((await f.run('First reply', false)).reason).toBe('planned');
  expect(existsSync(join(f.runsDir, 'leader'))).toBe(false);
  mkdirSync(f.lock, { recursive: true });
  expect((await f.run()).reason).toBe('not-delivered');
  expect(existsSync(f.state)).toBe(false);
  expect(calls).toBe(0);
});
