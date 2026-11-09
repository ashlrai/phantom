/**
 * RQ-PHX-OWNERLIVENOTICE09 — the once-per-channel "Leader is live here,
 * reply to talk to me." notice. A channel earns exactly one reply through
 * the guarded sendOwnerReply path when its adapter is enabled, the thread
 * carries at least one inbound on it, and no outbound has landed there yet.
 * Desktop never gets one; a repeat run plans nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOwnerLive } from '../src/cli/fleet-owner-live.js';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  OWNER_LIVE_NOTICE_TEXT,
  planOwnerLiveNotices,
  sendOwnerLiveNotices,
} from '../src/core/comms/owner-live-notice.js';
import type { OwnerAdapterStatus, OwnerChannelTransport, OwnerDelivery, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import {
  acceptOwnerInbound,
  readOwnerCommsStatus,
  readOwnerThread,
  sendOwnerReply,
  type OwnerThreadMessage,
  type OwnerThreadOptions,
} from '../src/core/comms/owner-thread.js';
import type { OwnerChannel } from '../src/core/comms/leader-mailbox.js';
import { SELF_TICK_STEP_ORDER, type SelfTickStepName, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

const NOW = 1_700_000_000_000;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

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
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-live-'));
  roots.push(runsDir);
  const calls: string[] = [];
  const sent: OwnerDelivery[] = [];
  const transport = (name: string): OwnerChannelTransport => ({
    async pull() { calls.push(`pull:${name}`); return []; },
    async deliver(input) {
      calls.push(`deliver:${name}`);
      if (sent.some(row => row.idempotencyKey === input.idempotencyKey)) return { status: 'duplicate', reason: 'dup' };
      sent.push(input);
      return { status: 'sent', reason: 'ok' };
    },
  });
  const seen = new Set<string>();
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW,
    settings, halted: false, paused: false,
    transports: {
      desktop: transport('desktop'), telegram: transport('telegram'), email: transport('email'),
      imessage: transport('imessage'), slack: transport('slack'),
    },
    mailbox: { async accept(message) {
      calls.push(`mailbox:${message.idempotencyKey}`);
      if (seen.has(message.idempotencyKey)) return { status: 'duplicate' };
      seen.add(message.idempotencyKey);
      return { status: 'accepted', requestId: message.idempotencyKey };
    } },
    ...overrides,
  };
  return { options, calls, sent };
}

const inbound = async (options: OwnerThreadOptions, channel: OwnerChannel, key: string) =>
  acceptOwnerInbound({
    channel, senderId: settings.owners[channel]!, text: `fake inbound on ${channel}`,
    idempotencyKey: key, at: NOW,
  }, options);

const adapters = (options: OwnerThreadOptions): OwnerAdapterStatus[] => readOwnerCommsStatus(options).adapters;
const messages = (options: OwnerThreadOptions): OwnerThreadMessage[] => readOwnerThread(options).messages;

describe('owner-live notice planning', () => {
  it('plans nothing when no channel has an inbound', async () => {
    const { options } = fixture();
    const report = await sendOwnerLiveNotices(options, { apply: false });
    expect(report.planned).toEqual([]);
    expect(report.sent).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.skipped.map(row => row.channel)).toEqual(['telegram', 'email', 'imessage', 'slack']);
    expect(report.skipped.every(row => row.reason === 'no-inbound')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('fake inbound');
  });

  it('plans exactly one notice for an enabled channel with one inbound', async () => {
    const { options } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    expect(planOwnerLiveNotices(messages(options), adapters(options))).toEqual([
      { channel: 'telegram', replyTo: 'fake-tg-inbound-01', idempotencyKey: 'leader-live-telegram' },
    ]);
  });

  it('answers the earliest inbound when a channel has several', async () => {
    const { options } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    await inbound(options, 'telegram', 'fake-tg-inbound-02');
    const [plan] = planOwnerLiveNotices(messages(options), adapters(options));
    expect(plan).toMatchObject({ channel: 'telegram', replyTo: 'fake-tg-inbound-01' });
  });

  it('never plans a notice for desktop', async () => {
    const { options } = fixture();
    await inbound(options, 'desktop', 'fake-desk-inbound01');
    const report = await sendOwnerLiveNotices(options, { apply: false });
    expect(report.planned).toEqual([]);
    expect(report.skipped.every(row => row.channel !== 'desktop')).toBe(true);
  });

  it('plans nothing for a channel that already has an outbound', async () => {
    const { options } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    await sendOwnerReply({ text: 'an earlier answer', replyTo: 'fake-tg-inbound-01', idempotencyKey: 'reply-early-0001' }, options);
    const report = await sendOwnerLiveNotices(options, { apply: false });
    expect(report.planned).toEqual([]);
    expect(report.skipped.find(row => row.channel === 'telegram')?.reason).toBe('already-replied');
  });

  it('plans nothing on a channel whose adapter is disabled', async () => {
    const { options } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const off: OwnerThreadOptions = {
      ...options, settings: { ...settings, secretHandles: {} },
    };
    const report = await sendOwnerLiveNotices(off, { apply: false });
    expect(report.planned).toEqual([]);
    expect(report.skipped.find(row => row.channel === 'telegram')?.reason).toBe('disabled');
  });
});

describe('owner-live notice sending', () => {
  it('dry-run plans but sends nothing', async () => {
    const { options, calls } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const report = await sendOwnerLiveNotices(options, { apply: false });
    expect(report.planned).toEqual(['telegram']);
    expect(report.sent).toEqual([]);
    expect(calls.filter(call => call.startsWith('deliver:'))).toEqual([]);
  });

  it('apply sends the fixed notice once and a second apply is a no-op', async () => {
    const { options, calls, sent } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const first = await sendOwnerLiveNotices(options, { apply: true });
    expect(first.planned).toEqual(['telegram']);
    expect(first.sent).toEqual(['telegram']);
    expect(first.failed).toEqual([]);
    expect(sent).toHaveLength(2); // telegram plus the desktop fanout copy
    expect(sent.map(row => row.idempotencyKey)).toEqual(['leader-live-telegram:telegram', 'leader-live-telegram:desktop']);
    expect(sent.every(row => row.text === OWNER_LIVE_NOTICE_TEXT)).toBe(true);
    expect(sent[0]?.ownerId).toBe('fake-owner-tg-123');
    const second = await sendOwnerLiveNotices(options, { apply: true });
    expect(second.planned).toEqual([]);
    expect(second.sent).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.skipped.find(row => row.channel === 'telegram')?.reason).toBe('already-replied');
    expect(sent).toHaveLength(2);
    expect(calls.filter(call => call.startsWith('deliver:'))).toHaveLength(2);
  });

  it('sends one notice per live channel when several have inbounds', async () => {
    const { options, sent } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    await inbound(options, 'slack', 'fake-sl-inbound-01');
    const report = await sendOwnerLiveNotices(options, { apply: true });
    expect(report.planned).toEqual(['telegram', 'slack']);
    expect(report.sent).toEqual(['telegram', 'slack']);
    expect(sent.map(row => row.idempotencyKey)).toEqual([
      'leader-live-telegram:telegram', 'leader-live-telegram:desktop',
      'leader-live-slack:slack', 'leader-live-slack:desktop',
    ]);
  });

  it('reports a refused send in failed, not sent', async () => {
    const { options } = fixture({ transports: {} });
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const report = await sendOwnerLiveNotices(options, { apply: true });
    expect(report.planned).toEqual(['telegram']);
    expect(report.sent).toEqual([]);
    expect(report.failed).toEqual([{ channel: 'telegram', reason: 'refused' }]);
  });

  it('KILL halts every plan and no transport is ever called', async () => {
    const { options, calls, sent } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const home = mkdtempSync(join(tmpdir(), 'owner-live-kill-'));
    roots.push(home);
    mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
    writeFileSync(join(home, '.ashlr', 'KILL'), 'kill switch armed\n', { mode: 0o600 });
    vi.stubEnv('HOME', home);
    const report = await sendOwnerLiveNotices(options, { apply: true });
    expect(report.halted).toBe(true);
    expect(report.planned).toEqual([]);
    expect(report.sent).toEqual([]);
    expect(report.skipped.every(row => row.reason === 'halted')).toBe(true);
    expect(calls.filter(call => call.startsWith('deliver:'))).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('ashlr fleet owner-live', () => {
  const run = async (args: string[], options: OwnerThreadOptions) => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdFleetOwnerLive(args, {
      options, output: text => out.push(text), error: text => err.push(text),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints the plan as JSON and sends nothing without --apply', async () => {
    const { options, calls } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    const { code, out } = await run(['--json'], options);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ v: 1, planned: ['telegram'], sent: [], failed: [] });
    expect(calls.filter(call => call.startsWith('deliver:'))).toEqual([]);
  });

  it('--apply sends and exits 0; a refused send exits 1', async () => {
    const { options } = fixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    expect((await run(['--apply', '--json'], options)).code).toBe(0);
    const dead = fixture({ transports: {} });
    await inbound(dead.options, 'telegram', 'fake-tg-inbound-01');
    const refused = await run(['--apply'], dead.options);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('failed=1');
  });

  it('exits 2 on unknown flags, duplicates and bad --runs-dir', async () => {
    const { options } = fixture();
    for (const args of [
      ['--bogus'], ['--apply', '--apply'], ['--json', '--json'],
      ['--runs-dir'], ['--runs-dir', 'relative/dir'], ['positional'],
    ]) {
      const { code, err } = await run(args, options);
      expect(code, args.join(' ')).toBe(2);
      expect(err).toContain('Usage: ashlr fleet owner-live');
    }
    expect((await run(['--help'], options)).code).toBe(0);
  });
});

describe('self-tick owner-live step', () => {
  let home: string;
  let runsDir: string;
  const stubs = (order: SelfTickStepName[], over: Partial<SelfTickSteps> = {}): SelfTickSteps => ({
    ...(Object.fromEntries(SELF_TICK_STEP_ORDER.map(name => [name, async () => {
      order.push(name);
      return { exitCode: 0, output: '{}' };
    }])) as SelfTickSteps),
    ...over,
  });

  it('runs owner-live after inbox-acks and before order-notices', async () => {
    home = mkdtempSync(join(tmpdir(), 'owner-live-tick-'));
    runsDir = join(home, 'runs');
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    const order: SelfTickStepName[] = [];
    const code = await cmdFleetSelfTick(['--json', '--runs-dir', runsDir], {
      home, now: () => NOW, steps: stubs(order), output: () => {},
    });
    expect(code).toBe(0);
    expect(order).toEqual([...SELF_TICK_STEP_ORDER]);
    expect(order.indexOf('owner-live')).toBe(order.indexOf('inbox-acks') + 1);
    expect(order.indexOf('owner-live')).toBe(order.indexOf('order-notices') - 1);
  });

  it('passes --apply through only on apply ticks', async () => {
    home = mkdtempSync(join(tmpdir(), 'owner-live-tick-'));
    runsDir = join(home, 'runs');
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    for (const apply of [true, false]) {
      const argvs: string[][] = [];
      const steps: SelfTickSteps = { ...stubs([]), 'owner-live': async argv => { argvs.push([...argv]); return { exitCode: 0, output: '{}' }; } };
      const code = await cmdFleetSelfTick(
        ['--json', '--runs-dir', runsDir, ...(apply ? ['--apply'] : [])],
        { home, now: () => NOW, steps, output: () => {} },
      );
      expect(code).toBe(0);
      expect(argvs[0]).toEqual(['--json', ...(apply ? ['--apply'] : []), '--runs-dir', runsDir]);
    }
  });

  it('a throwing owner-live step does not stop later steps', async () => {
    home = mkdtempSync(join(tmpdir(), 'owner-live-tick-'));
    runsDir = join(home, 'runs');
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    const order: SelfTickStepName[] = [];
    let output = '';
    const code = await cmdFleetSelfTick(['--apply', '--json', '--runs-dir', runsDir], {
      home, now: () => NOW, output: text => { output = text; },
      steps: stubs(order, { 'owner-live': async () => { order.push('owner-live'); throw new Error('fake failure'); } }),
    });
    expect(code).toBe(1);
    expect(order).toEqual([...SELF_TICK_STEP_ORDER]);
    const report = JSON.parse(output) as { steps: { step: string; state: string }[] };
    expect(report.steps.find(step => step.step === 'owner-live')).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(report.steps.filter(step => step.state === 'ok')).toHaveLength(8);
  });
});
