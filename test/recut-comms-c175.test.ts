/**
 * RQ-PHX-RECUTCOMMSC175 — thin check through the recovered entry points of
 * #5124 (RQ-PHX-RECUTCOMMSC167, itself carrying #4286 RQ-PHX-OWNERLIVENOTICE09):
 * the once-per-channel "Leader is live here, reply to talk to me." owner notice.
 * Sends only ever happen through the guarded sendOwnerReply path under --apply;
 * a comms pause reports every channel held as 'halted' and delivers nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_LIVE_NOTICE_TEXT,
  planOwnerLiveNotices,
  sendOwnerLiveNotices,
} from '../src/core/comms/owner-live-notice.js';
import type { OwnerChannelTransport, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerCommsStatus, readOwnerThread, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const NOW = 1_700_000_000_000;
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const settings: OwnerThreadSettings = {
  owners: {
    desktop: 'fake-owner-desk-123', telegram: 'fake-owner-tg-123', email: 'email:fake-owner@example.invalid',
    imessage: 'fake-owner-imsg-123', slack: 'fake-owner-slack-123',
  },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN', email: 'phm_EMAIL_CREDENTIAL', slack: 'phm_SLACK_BOT_TOKEN' },
  imessageBridge: 'loopback',
  confirmed: true,
  team: [
    { channel: 'bus', id: 'fake-owner-desk-123' },
    { channel: 'telegram', id: 'fake-owner-tg-123' },
    { channel: 'email', id: 'email:fake-owner@example.invalid' },
    { channel: 'imessage', id: 'fake-owner-imsg-123' },
    { channel: 'slack', id: 'fake-owner-slack-123' },
  ],
};

function fixture(overrides: Partial<OwnerThreadOptions> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'recut-c175-'));
  roots.push(runsDir);
  const deliveries: string[] = [];
  const transport = (name: string): OwnerChannelTransport => ({
    async pull() { return []; },
    async deliver(input) {
      deliveries.push(`${name}:${input.idempotencyKey}`);
      return { status: 'sent', reason: 'ok' };
    },
  });
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW,
    settings, halted: false, paused: false,
    transports: {
      desktop: transport('desktop'), telegram: transport('telegram'), email: transport('email'),
      imessage: transport('imessage'), slack: transport('slack'),
    },
    mailbox: { async accept() { return { status: 'accepted', requestId: 'fake' }; } },
    ...overrides,
  };
  return { options, deliveries };
}

describe('recut c175: owner-live notice through the recovered exports', () => {
  it('plans one guarded notice for an enabled channel with an inbound', async () => {
    const { options, deliveries } = fixture();
    await acceptOwnerInbound({
      channel: 'telegram', senderId: settings.owners.telegram!, text: 'fake owner ping',
      idempotencyKey: 'fake-tg-inbound-01', at: NOW,
    }, options);
    expect(
      planOwnerLiveNotices(readOwnerThread(options).messages, readOwnerCommsStatus(options).adapters),
    ).toEqual([{ channel: 'telegram', replyTo: 'fake-tg-inbound-01', idempotencyKey: 'leader-live-telegram' }]);
    const report = await sendOwnerLiveNotices(options, { apply: false });
    expect(report.planned).toEqual(['telegram']);
    expect(report.sent).toEqual([]);
    expect(deliveries).toEqual([]);
  });

  it('a comms pause holds every planned channel as halted and delivers nothing', async () => {
    const { options, deliveries } = fixture({ paused: true });
    await acceptOwnerInbound({
      channel: 'telegram', senderId: settings.owners.telegram!, text: 'fake owner ping',
      idempotencyKey: 'fake-tg-inbound-02', at: NOW,
    }, options);
    const report = await sendOwnerLiveNotices(options, { apply: true });
    expect(report.halted).toBe(true);
    expect(report.planned).toEqual([]);
    expect(report.sent).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.skipped.find(row => row.channel === 'telegram')?.reason).toBe('halted');
    expect(deliveries).toEqual([]);
  });

  it('the notice text is the fixed leader-live line', () => {
    expect(OWNER_LIVE_NOTICE_TEXT).toBe('Leader is live here, reply to talk to me.');
  });
});
