/**
 * RQ-OWNERLIVEN22WQ8: owner-live.status.v1 names why each phone channel is
 * off, and the newest leader reply goes out once an hour, once per text,
 * only to a channel that is on.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyOwnerSettings, type OwnerChannelTransport, type OwnerDelivery, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { sendLeaderReplyToPhone, OWNER_LIVE_REPLY_INTERVAL_MS } from '../src/core/comms/owner-live-reply.js';
import { readOwnerLiveStatus } from '../src/core/comms/owner-live-status.js';
import type { OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
const none = { halted: false, paused: false };

const onSettings: OwnerThreadSettings = {
  ...emptyOwnerSettings(),
  owners: { imessage: 'owner-phone' },
  imessageBridge: 'loopback',
  confirmed: true,
  team: [{ channel: 'imessage', id: 'owner-phone' }],
};

function fixture(settings: OwnerThreadSettings, clock: { t: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'owner-live-'));
  roots.push(dir);
  const sent: OwnerDelivery[] = [];
  const transport: OwnerChannelTransport = { async pull() { return []; }, async deliver(input) { sent.push(input); return { status: 'sent', reason: 'sent' }; } };
  const options: OwnerThreadOptions = { runsDir: dir, settings, now: () => clock.t, transports: { imessage: transport } };
  return { options, sent };
}
const reply = (text: string) => [{ at: '2026-11-21 07:00', text, source: 'plan-log' as const }];
const run = (options: OwnerThreadOptions, text: string) => sendLeaderReplyToPhone(options, { apply: true, replies: reply(text), ...none });

describe('owner-live status', () => {
  it('gives four plain reasons naming the deciding key when everything is off', () => {
    const status = readOwnerLiveStatus(emptyOwnerSettings(), none);
    expect(status.schema).toBe('owner-live.status.v1');
    expect(status.channels.map(c => c.channel)).toEqual(['telegram', 'email', 'imessage', 'slack']);
    for (const c of status.channels) {
      expect(c.state).toBe('not-set-up');
      expect(c.reason).not.toBe('disabled');
      expect(c.nextStep).toBeTruthy();
      expect(c.decidedBy.every(d => d.value === 'not set')).toBe(true);
    }
    expect(status.channels.find(c => c.channel === 'imessage')?.decidedBy.map(d => d.key).join()).toContain('bridge');
    expect(status.line).toBe('Phone updates: off (iMessage not set up)');
  });

  it('never prints the owner id', () => {
    expect(JSON.stringify(readOwnerLiveStatus(onSettings, none))).not.toContain('owner-phone');
  });

  it('is on only with a confirmed, team-bound owner', () => {
    expect(readOwnerLiveStatus(onSettings, none).channels[2]?.state).toBe('on');
    expect(readOwnerLiveStatus({ ...onSettings, confirmed: false }, none).channels[2]?.state).toBe('off');
    expect(readOwnerLiveStatus({ ...onSettings, team: [] }, none).channels[2]?.nextStep).toContain('[team]');
    expect(readOwnerLiveStatus(onSettings, { halted: false, paused: true }).channels[2]?.state).toBe('off');
  });
});

describe('owner-live reply send', () => {
  it('sends a new reply once, and the same reply an hour later sends nothing', async () => {
    const clock = { t: 1_700_000_000_000 };
    const { options, sent } = fixture(onSettings, clock);
    expect((await run(options, 'All quiet.')).reason).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ownerId).toBe('owner-phone');
    clock.t += OWNER_LIVE_REPLY_INTERVAL_MS + 1;
    expect((await run(options, 'All  quiet.')).reason).toBe('already-sent');
    expect(sent).toHaveLength(1);
  });

  it('sends at most one message per hour', async () => {
    const clock = { t: 1_700_000_000_000 };
    const { options, sent } = fixture(onSettings, clock);
    await run(options, 'First.');
    clock.t += 60_000;
    expect((await run(options, 'Second.')).reason).toBe('too-soon');
    clock.t += OWNER_LIVE_REPLY_INTERVAL_MS;
    expect((await run(options, 'Second.')).reason).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('sends nothing without a binding', async () => {
    const { options, sent } = fixture({ ...onSettings, owners: {}, team: [] }, { t: 1_700_000_000_000 });
    const result = await run(options, 'Hello.');
    expect(result.reason).toBe('no-channel-on');
    expect(result.skipped).toHaveLength(4);
    expect(sent).toHaveLength(0);
  });

  it('plans but does not send on a dry run', async () => {
    const { options, sent } = fixture(onSettings, { t: 1_700_000_000_000 });
    const result = await sendLeaderReplyToPhone(options, { apply: false, replies: reply('Plan.'), ...none });
    expect(result.reason).toBe('planned');
    expect(sent).toHaveLength(0);
  });
});
