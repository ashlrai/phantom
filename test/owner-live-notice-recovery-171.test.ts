/**
 * RQ-PHX-OWNERLIVENOTICERECOVER171 — recovery coverage for the once-per-channel
 * "Leader is live here" notice from PR #5124 @ 5945d7b2. Bounded subset of the
 * source suite (test/owner-live-notice.test.ts): disabled/no-inbound channels
 * send nothing, an enabled inbound plans one notice, dry-run does no transport
 * IO, apply reaches the guarded sendOwnerReply path once, a repeat apply is a
 * no-op, and halt/pause are respected. All transports are fakes; nothing sends.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetOwnerLive } from '../src/cli/fleet-owner-live.js';
import { OWNER_LIVE_NOTICE_TEXT, sendOwnerLiveNotices } from '../src/core/comms/owner-live-notice.js';
import type { OwnerChannelTransport, OwnerDelivery, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import type { OwnerChannel } from '../src/core/comms/leader-mailbox.js';

const NOW = 1_700_000_000_000;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const settings: OwnerThreadSettings = {
  owners: { desktop: 'fake-owner-desk', telegram: 'fake-owner-tg', email: 'email:fake@example.invalid', imessage: 'fake-owner-imsg', slack: 'fake-owner-slack' },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN', email: 'phm_EMAIL_CREDENTIAL', slack: 'phm_SLACK_BOT_TOKEN' },
  imessageBridge: 'loopback', confirmed: true,
  team: [
    { channel: 'bus', id: 'fake-owner-desk' }, { channel: 'telegram', id: 'fake-owner-tg' },
    { channel: 'email', id: 'email:fake@example.invalid' }, { channel: 'imessage', id: 'fake-owner-imsg' },
    { channel: 'slack', id: 'fake-owner-slack' },
  ],
};

function fixture(overrides: Partial<OwnerThreadOptions> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-live-171-'));
  roots.push(runsDir);
  const sent: OwnerDelivery[] = [];
  const transport = (): OwnerChannelTransport => ({
    async pull() { return []; },
    async deliver(input) {
      if (sent.some(row => row.idempotencyKey === input.idempotencyKey)) return { status: 'duplicate', reason: 'dup' };
      sent.push(input);
      return { status: 'sent', reason: 'ok' };
    },
  });
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW,
    settings, halted: false, paused: false,
    transports: { desktop: transport(), telegram: transport(), email: transport(), imessage: transport(), slack: transport() },
    mailbox: { async accept(message) { return { status: 'accepted', requestId: message.idempotencyKey }; } },
    ...overrides,
  };
  return { options, sent };
}

const inbound = (options: OwnerThreadOptions, channel: OwnerChannel, key: string) =>
  acceptOwnerInbound({ channel, senderId: settings.owners[channel]!, text: `fake inbound ${key}`, idempotencyKey: key, at: NOW }, options);

describe('owner-live notice recovery', () => {
  it('plans nothing and sends nothing with no inbound or disabled adapters', async () => {
    const { options, sent } = fixture();
    const report = await sendOwnerLiveNotices(options, { apply: true });
    expect(report.planned).toEqual([]);
    expect(report.sent).toEqual([]);
    expect(sent).toEqual([]);
    const off = fixture({ settings: { ...settings, secretHandles: {} } });
    await inbound(off.options, 'telegram', 'fake-tg-inbound-01');
    const disabled = await sendOwnerLiveNotices(off.options, { apply: true });
    expect(disabled.planned).toEqual([]);
    expect(disabled.sent).toEqual([]);
    expect(disabled.skipped.find(row => row.channel === 'telegram')?.reason).toBe('disabled');
    expect(off.sent).toEqual([]);
  });

  it('dry-run plans the notice but does no transport IO; apply sends once via sendOwnerReply', async () => {
    const { options, sent } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const dry = await sendOwnerLiveNotices(options, { apply: false });
    expect(dry.planned).toEqual(['telegram']);
    expect(dry.sent).toEqual([]);
    expect(sent).toEqual([]);
    const first = await sendOwnerLiveNotices(options, { apply: true });
    expect(first.sent).toEqual(['telegram']);
    expect(sent.map(row => row.idempotencyKey)).toEqual(['leader-live-telegram:telegram', 'leader-live-telegram:desktop']);
    expect(sent.every(row => row.text === OWNER_LIVE_NOTICE_TEXT)).toBe(true);
  });

  it('a repeated apply does not duplicate; desktop inbound never plans', async () => {
    const { options, sent } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    await inbound(options, 'desktop', 'fake-desk-inbound1');
    await sendOwnerLiveNotices(options, { apply: true });
    const again = await sendOwnerLiveNotices(options, { apply: true });
    expect(again.planned).toEqual([]);
    expect(again.sent).toEqual([]);
    expect(again.skipped.find(row => row.channel === 'telegram')?.reason).toBe('already-replied');
    expect(sent).toHaveLength(2);
    const prior = fixture();
    await inbound(prior.options, 'telegram', 'fake-tg-inbound-01');
    await sendOwnerReply({ text: 'earlier answer', replyTo: 'fake-tg-inbound-01', idempotencyKey: 'reply-early-01' }, prior.options);
    expect((await sendOwnerLiveNotices(prior.options, { apply: false })).planned).toEqual([]);
  });

  it('halt and pause are respected: no plan, no send, halted report', async () => {
    for (const hold of [{ halted: true }, { paused: true }]) {
      const { options, sent } = fixture();
      await inbound(options, 'telegram', 'fake-tg-inbound-01');
      const held = await sendOwnerLiveNotices({ ...options, ...hold }, { apply: true });
      expect(held.halted).toBe(true);
      expect(held.planned).toEqual([]);
      expect(held.sent).toEqual([]);
      expect(sent).toEqual([]);
    }
  });

  it('cmdFleetOwnerLive is dry-run by default and --apply exits nonzero on refusal', async () => {
    const { options, sent } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const run = async (args: string[]) => {
      const out: string[] = [], err: string[] = [];
      const code = await cmdFleetOwnerLive(args, { options, output: t => out.push(t), error: t => err.push(t) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const dry = await run(['--json']);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out)).toMatchObject({ v: 1, planned: ['telegram'], sent: [] });
    expect(sent).toEqual([]);
    expect((await run(['--apply', '--json'])).code).toBe(0);
    expect(sent).toHaveLength(2);
    const dead = fixture({ transports: {} });
    await inbound(dead.options, 'telegram', 'fake-tg-inbound-01');
    const out: string[] = [];
    const code = await cmdFleetOwnerLive(['--apply'], { options: dead.options, output: t => out.push(t), error: () => {} });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('failed=1');
    expect((await run(['--bogus'])).code).toBe(2);
  });
});
