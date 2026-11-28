import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyOwnerSettings, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { OWNER_LIVE_REPLY_INTERVAL_MS, sendLeaderReplyToPhone } from '../src/core/comms/owner-live-reply.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'reply-failure-')); roots.push(runsDir);
  const clock = { now: 1_700_000_000_000 };
  const keys: string[] = [];
  let outcome: 'failed' | 'throw' | 'sent' | 'duplicate' = 'failed';
  const transport: OwnerChannelTransport = {
    async pull() { return []; },
    async deliver(input) {
      keys.push(input.idempotencyKey);
      if (outcome === 'throw') throw new Error('fake failure');
      return { status: outcome, reason: outcome };
    },
  };
  const options: OwnerThreadOptions = {
    runsDir, now: () => clock.now,
    settings: { ...emptyOwnerSettings(), owners: { imessage: 'fake-owner' }, imessageBridge: 'loopback',
      confirmed: true, team: [{ channel: 'imessage', id: 'fake-owner' }] },
    transports: { imessage: transport },
  };
  const state = join(runsDir, 'leader', 'owner-live-reply.json');
  const run = (text = 'Fake reply', overrides: Partial<{ apply: boolean; halted: boolean; paused: boolean }> = {}) =>
    sendLeaderReplyToPhone(options, { apply: true, halted: false, paused: false, replies: [{ at: '2026-11-21', text, source: 'plan-log' }], ...overrides });
  return { options, clock, keys, state, run, transport, setOutcome: (value: typeof outcome) => { outcome = value; } };
}

it.each(['failed', 'throw'] as const)('recovers after %s with the original key and enforces the successful interval', async outcome => {
  const f = fixture(); f.setOutcome(outcome);
  expect((await f.run()).reason).toBe('not-delivered');
  expect(JSON.parse(readFileSync(f.state, 'utf8')).lastSentAt).toBe(0);
  f.clock.now += 1; f.setOutcome('duplicate');
  expect((await f.run()).reason).toBe('sent');
  expect(f.keys[1]).toBe(f.keys[0]);
  expect((await f.run('Another fake reply')).reason).toBe('too-soon');
});

it('recovers when a missing transport is restored', async () => {
  const f = fixture(); f.options.transports = {};
  expect((await f.run()).reason).toBe('not-delivered');
  f.options.transports = { imessage: f.transport }; f.setOutcome('sent'); f.clock.now += 1;
  expect((await f.run()).sent).toEqual(['imessage']);
  expect(f.keys).toHaveLength(1);
});

it('preserves an earlier success timestamp across a failed attempt', async () => {
  const f = fixture(); f.setOutcome('sent'); await f.run('First fake reply');
  const previous = f.clock.now;
  f.clock.now += OWNER_LIVE_REPLY_INTERVAL_MS; f.setOutcome('failed');
  expect((await f.run()).reason).toBe('not-delivered');
  expect(JSON.parse(readFileSync(f.state, 'utf8')).lastSentAt).toBe(previous);
  f.setOutcome('sent'); f.clock.now += 1;
  expect((await f.run()).reason).toBe('sent');
});

it('does not send or mutate state when halted, paused, or planning', async () => {
  const f = fixture();
  expect((await f.run(undefined, { halted: true })).reason).toBe('halted');
  expect((await f.run(undefined, { paused: true })).reason).toBe('halted');
  expect((await f.run(undefined, { apply: false })).reason).toBe('planned');
  expect(f.keys).toHaveLength(0);
  expect(existsSync(f.state)).toBe(false);
});
