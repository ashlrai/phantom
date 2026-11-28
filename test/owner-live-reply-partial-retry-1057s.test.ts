import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { emptyOwnerSettings, OWNER_SECRET_HANDLES, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { OWNER_LIVE_REPLY_INTERVAL_MS, replyHash, sendLeaderReplyToPhone } from '../src/core/comms/owner-live-reply.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'reply-retry-')); roots.push(runsDir);
  const clock = { t: 1_700_000_000_000 };
  const calls: { channel: string; key: string }[] = [];
  let outcome: 'failed' | 'throw' | 'duplicate' = 'failed';
  const transport = (channel: string): OwnerChannelTransport => ({
    async pull() { return []; },
    async deliver(input) {
      calls.push({ channel, key: input.idempotencyKey });
      if (channel === 'telegram') {
        if (outcome === 'throw') throw new Error('failure');
        if (outcome === 'failed') return { status: 'failed', reason: 'failed' };
        return { status: 'duplicate', reason: 'duplicate' };
      }
      return { status: 'sent', reason: 'sent' };
    },
  });
  const options: OwnerThreadOptions = {
    runsDir, now: () => clock.t,
    settings: { ...emptyOwnerSettings(), owners: { imessage: 'owner-one', telegram: 'owner-two' },
      imessageBridge: 'loopback', secretHandles: { telegram: OWNER_SECRET_HANDLES.telegram }, confirmed: true,
      team: [{ channel: 'imessage', id: 'owner-one' }, { channel: 'telegram', id: 'owner-two' }] },
    transports: { imessage: transport('imessage'), telegram: transport('telegram') },
  };
  const state = join(runsDir, 'leader', 'owner-live-reply.json');
  const run = (text = 'Private reply', overrides: Partial<{ apply: boolean; halted: boolean; paused: boolean }> = {}) =>
    sendLeaderReplyToPhone(options, { apply: true, halted: false, paused: false, replies: [{ at: '2026-11-21', text, source: 'plan-log' }], ...overrides });
  return { options, state, calls, clock, run, setOutcome: (value: typeof outcome) => { outcome = value; }, advance: () => { clock.t += OWNER_LIVE_REPLY_INTERVAL_MS; } };
}

it('retries only the failed destination after the hourly interval with its stable key', async () => {
  const f = fixture();
  expect((await f.run()).sent).toEqual(['imessage']);
  expect((await f.run()).reason).toBe('too-soon');
  expect((await f.run('New reply')).reason).toBe('too-soon');
  expect(f.calls).toHaveLength(2);
  f.advance(); f.setOutcome('duplicate');
  expect((await f.run()).sent).toEqual(['telegram']);
  expect(f.calls[2]?.key).toBe(f.calls[0]?.key);
  f.advance(); expect((await f.run()).reason).toBe('already-sent');
  expect(f.calls).toHaveLength(3);
});

it('retries a thrown transport and counts a duplicate as delivered', async () => {
  const f = fixture(); f.setOutcome('throw');
  expect((await f.run()).sent).toEqual(['imessage']);
  f.advance(); f.setOutcome('duplicate');
  expect((await f.run()).sent).toEqual(['telegram']);
  f.advance(); expect((await f.run()).reason).toBe('already-sent');
});

it('respects changed gates and leaves state untouched on a dry run', async () => {
  const f = fixture(); await f.run(); f.advance();
  const before = readFileSync(f.state, 'utf8');
  expect((await f.run(undefined, { halted: true })).reason).toBe('halted');
  expect((await f.run(undefined, { paused: true })).reason).toBe('halted');
  const plan = await f.run(undefined, { apply: false });
  expect(plan.planned).toEqual(['telegram']);
  expect(readFileSync(f.state, 'utf8')).toBe(before);
  f.options.settings.secretHandles.telegram = undefined;
  expect((await f.run()).reason).toBe('already-sent');
  expect(f.calls).toHaveLength(2);
  expect(readFileSync(f.state, 'utf8')).toBe(before);
});

it('preserves legacy dedupe and bounds evidence without storing content or identities', async () => {
  const f = fixture(); mkdirSync(join(f.options.runsDir, 'leader'));
  writeFileSync(f.state, JSON.stringify({ lastSentAt: 0, hashes: [replyHash('Private reply')] }));
  expect((await f.run()).reason).toBe('already-sent');
  expect(f.calls).toHaveLength(0);
  for (let i = 0; i < 55; i++) { await f.run(`Private reply ${i}`); f.advance(); }
  expect(existsSync(f.state)).toBe(true);
  const text = readFileSync(f.state, 'utf8');
  const state = JSON.parse(text) as { hashes: string[]; delivered: Record<string, string[]> };
  expect(state.hashes).toHaveLength(50);
  expect(Object.keys(state.delivered)).toHaveLength(50);
  expect(text).not.toContain('Private reply');
  expect(text).not.toContain('owner-one');
  expect(text).not.toContain('owner-two');
});
