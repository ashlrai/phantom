/**
 * RQ-PHX-RECUTCOMMSC167 — thin check through the recovered entry point of
 * #4286 (RQ-PHX-OWNERLIVENOTICE09): the once-per-channel "Leader is live
 * here" notice. Sends only ever happen through the guarded sendOwnerReply
 * path under --apply; a dry run plans but delivers nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetOwnerLive } from '../../src/cli/fleet-owner-live.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../../src/cli/fleet-subcommand-registry.js';
import { OWNER_LIVE_NOTICE_TEXT, sendOwnerLiveNotices } from '../../src/core/comms/owner-live-notice.js';
import type { OwnerChannelTransport, OwnerThreadSettings } from '../../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, type OwnerThreadOptions } from '../../src/core/comms/owner-thread.js';

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

function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'recut-c167-'));
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
  };
  return { options, deliveries };
}

describe('recut c167: owner-live notice through the recovered entry point', () => {
  it('dry run plans the notice but the apply gate delivers nothing', async () => {
    const { options, deliveries } = fixture();
    await acceptOwnerInbound({
      channel: 'telegram', senderId: settings.owners.telegram!, text: 'fake owner ping',
      idempotencyKey: 'fake-tg-inbound-01', at: NOW,
    }, options);
    const report = await sendOwnerLiveNotices(options, { apply: false });
    expect(report.planned).toEqual(['telegram']);
    expect(report.sent).toEqual([]);
    expect(deliveries).toEqual([]);
  });

  it('cmdFleetOwnerLive --json reports the plan and sends nothing without --apply', async () => {
    const { options, deliveries } = fixture();
    await acceptOwnerInbound({
      channel: 'telegram', senderId: settings.owners.telegram!, text: 'fake owner ping',
      idempotencyKey: 'fake-tg-inbound-02', at: NOW,
    }, options);
    const out: string[] = [];
    const code = await cmdFleetOwnerLive(['--json'], { options, output: text => out.push(text), error: () => {} });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ v: 1, planned: ['telegram'], sent: [], failed: [] });
    expect(deliveries).toEqual([]);
  });

  it('--apply sends the fixed text once through the guarded reply path', async () => {
    const { options, deliveries } = fixture();
    await acceptOwnerInbound({
      channel: 'telegram', senderId: settings.owners.telegram!, text: 'fake owner ping',
      idempotencyKey: 'fake-tg-inbound-03', at: NOW,
    }, options);
    const report = await sendOwnerLiveNotices(options, { apply: true });
    expect(report.sent).toEqual(['telegram']);
    expect(deliveries).toEqual(['telegram:leader-live-telegram:telegram', 'desktop:leader-live-telegram:desktop']);
    const again = await sendOwnerLiveNotices(options, { apply: true });
    expect(again.planned).toEqual([]);
    expect(deliveries).toHaveLength(2);
  });

  it('the fleet registry resolves the owner-live verb', async () => {
    const loaded = await FLEET_SUBCOMMAND_LOADERS['owner-live']!();
    expect(loaded['cmdFleetOwnerLive']).toBe(cmdFleetOwnerLive);
    expect(OWNER_LIVE_NOTICE_TEXT).toBe('Leader is live here, reply to talk to me.');
  });
});
