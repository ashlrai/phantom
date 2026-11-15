/**
 * RQ-PHX-OWNERLIVESELFTICKRECOVER250S — restores the self-tick wiring from
 * PR #4286: an ordinary `fleet self-tick` pass now runs the owner-live step
 * (the once-per-channel 'Leader is live here' notice) through the real
 * cmdFleetSelfTick/runSelfTick path, immediately after inbox-acks. Every
 * fixture is fake: isolated HOME and runs dirs, injected OwnerThreadOptions
 * with fake transports, and stub seams for the unrelated expensive steps.
 * No real owner thread, transport or account root is ever resolved.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { OWNER_LIVE_NOTICE_TEXT } from '../src/core/comms/owner-live-notice.js';
import type { OwnerChannelTransport, OwnerDelivery, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import {
  acceptOwnerInbound,
  type OwnerThreadOptions,
} from '../src/core/comms/owner-thread.js';
import type { OwnerChannel } from '../src/core/comms/leader-mailbox.js';
import { SELF_TICK_STEP_ORDER, type SelfTickStep, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readSelfTickLast } from '../src/core/fleet/self-tick-last.js';

const NOW = 1_700_000_000_000;
const NOW_MS = () => NOW;
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

/** Fake owner-thread options: isolated runs dir, fake transports and mailbox. */
function ownerFixture(overrides: Partial<OwnerThreadOptions> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-live-tick-'));
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

interface TickFixture {
  home: string;
  runsDir: string;
  output: string[];
  /** Stubs for every step except owner-live, which must use the real binding. */
  steps: Partial<SelfTickSteps>;
  orderNotices: ReturnType<typeof vi.fn>;
}

/** Isolated self-tick fixture: temp home/runs dir, cheap stubs elsewhere. */
function tickFixture(): TickFixture {
  const home = mkdtempSync(join(tmpdir(), 'owner-live-selftick-'));
  roots.push(home);
  const runsDir = join(home, 'runs');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });
  const orderNotices = vi.fn(ok);
  const steps: Partial<SelfTickSteps> = {
    'reset-release': ok, 'lane-autohold': ok, 'stray-stop': ok, 'meter-incident': ok,
    'planner-tick': ok, 'inbox-acks': ok, 'order-notices': orderNotices,
    'needs-triage': ok, 'waste-incident': ok, 'teammate-overdue': ok, 'landed-sweep': ok,
  };
  return { home, runsDir, output: [], steps, orderNotices };
}

const tick = (fx: TickFixture, opts: { apply?: boolean; ownerOptions?: OwnerThreadOptions; runsDir?: string } = {}) =>
  cmdFleetSelfTick(
    ['--json', '--runs-dir', opts.runsDir ?? fx.runsDir, ...(opts.apply === true ? ['--apply'] : [])],
    {
      home: fx.home, now: NOW_MS, steps: fx.steps,
      ...(opts.ownerOptions === undefined ? {} : { ownerOptions: opts.ownerOptions }),
      output: text => fx.output.push(text), error: () => {},
    },
  );

const report = (fx: TickFixture) => JSON.parse(fx.output.at(-1)!) as {
  mode: string; state: string;
  steps: { step: string; state: string; exitCode: number; report: unknown }[];
};
const stepReport = (fx: TickFixture, name: string) =>
  report(fx).steps.find(s => s.step === name);
/** The persisted last-report record's raw step entries. */
const lastSteps = (runsDir: string) =>
  (JSON.parse(readFileSync(join(runsDir, 'queue', 'self-tick-last.json'), 'utf8')) as {
    steps: { step: string; state: string }[];
  }).steps;

describe('self-tick owner-live step (restored #4286 wiring)', () => {
  it('orders owner-live after inbox-acks and before order-notices', async () => {
    const fx = tickFixture();
    const { options } = ownerFixture();
    expect(await tick(fx, { ownerOptions: options })).toBe(0);
    const names = report(fx).steps.map(s => s.step);
    expect(names).toEqual([...SELF_TICK_STEP_ORDER]);
    expect(names.indexOf('owner-live')).toBe(names.indexOf('inbox-acks') + 1);
    expect(names.indexOf('order-notices')).toBe(names.indexOf('owner-live') + 1);
  });

  it('dry-run plans the notice for a verified inbound and sends nothing', async () => {
    const fx = tickFixture();
    const { options, calls, sent } = ownerFixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    expect(await tick(fx, { ownerOptions: options })).toBe(0);
    const step = stepReport(fx, 'owner-live');
    expect(step).toMatchObject({ state: 'ok', exitCode: 0 });
    expect(step!.report).toMatchObject({ v: 1, planned: ['telegram'], sent: [], failed: [] });
    expect(calls.filter(call => call.startsWith('deliver:'))).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('--apply delivers through the guarded fake transport and a repeat dedupes', async () => {
    const fx = tickFixture();
    const { options, sent } = ownerFixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-01');
    expect(await tick(fx, { apply: true, ownerOptions: options })).toBe(0);
    expect(stepReport(fx, 'owner-live')!.report).toMatchObject({ planned: ['telegram'], sent: ['telegram'], failed: [] });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(row => row.text === OWNER_LIVE_NOTICE_TEXT)).toBe(true);
    // Second pass: the outbound already on the thread means nothing is planned.
    fx.output.length = 0;
    expect(await tick(fx, { apply: true, ownerOptions: options })).toBe(0);
    expect(stepReport(fx, 'owner-live')!.report).toMatchObject({ planned: [], sent: [] });
    expect(sent.filter(row => row.idempotencyKey.startsWith('leader-live-telegram:'))).toHaveLength(2);
  });

  it('plans and sends nothing with no inbound or a disabled adapter', async () => {
    const quiet = tickFixture();
    const quietOwner = ownerFixture();
    expect(await tick(quiet, { apply: true, ownerOptions: quietOwner.options })).toBe(0);
    expect(stepReport(quiet, 'owner-live')!.report).toMatchObject({ planned: [], sent: [] });
    expect(quietOwner.calls.filter(call => call.startsWith('deliver:'))).toEqual([]);

    const disabled = tickFixture();
    const offOwner = ownerFixture({ settings: { ...settings, secretHandles: {} } });
    await inbound(offOwner.options, 'telegram', 'fake-tg-inbound-02');
    expect(await tick(disabled, { apply: true, ownerOptions: offOwner.options })).toBe(0);
    expect(stepReport(disabled, 'owner-live')!.report).toMatchObject({ planned: [], sent: [] });
    expect(offOwner.calls.filter(call => call.startsWith('deliver:'))).toEqual([]);
  });

  it('a custom runs dir without owner options skips honestly and never resolves the live thread', async () => {
    const fx = tickFixture();
    const custom = join(fx.home, 'custom-runs');
    mkdirSync(join(custom, 'queue'), { recursive: true });
    // Deliberately no ownerOptions: the step must not touch ownerThreadOptions().
    const code = await tick(fx, { apply: true, runsDir: custom });
    expect(code).toBe(0);
    const step = report(fx).steps.find(s => s.step === 'owner-live');
    expect(step).toMatchObject({ state: 'ok', exitCode: 0 });
    expect(step!.report).toEqual({ reason: 'custom-runs-dir-no-owner-thread' });
    // Later steps still ran; the pass persisted its last-report record.
    expect(fx.orderNotices).toHaveBeenCalledOnce();
    expect(lastSteps(custom).find(s => s.step === 'owner-live')).toMatchObject({ state: 'ok' });
    expect(readSelfTickLast(custom, NOW)).toMatchObject({ state: 'ok', failedSteps: [] });
  });

  it('a failed owner-live step never blocks the later steps', async () => {
    const fx = tickFixture();
    // transports:{} makes every planned send refuse; --apply then exits 1.
    const { options } = ownerFixture({ transports: {} });
    await inbound(options, 'telegram', 'fake-tg-inbound-03');
    expect(await tick(fx, { apply: true, ownerOptions: options })).toBe(1);
    expect(stepReport(fx, 'owner-live')).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(fx.orderNotices).toHaveBeenCalledOnce();
    expect(readSelfTickLast(fx.runsDir, NOW)).toMatchObject({ state: 'ok', failedSteps: ['owner-live'] });
  });

  it('the recorded last report carries the owner-live step in order', async () => {
    const fx = tickFixture();
    const { options } = ownerFixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-04');
    expect(await tick(fx, { ownerOptions: options })).toBe(0);
    expect(lastSteps(fx.runsDir).map(s => s.step)).toEqual([...SELF_TICK_STEP_ORDER]);
    expect(lastSteps(fx.runsDir).find(s => s.step === 'owner-live')).toMatchObject({ state: 'ok' });
  });
});
