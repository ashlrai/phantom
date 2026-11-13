/**
 * RQ-PHX-OWNERLIVESTAGEQUALIFY287S — qualification evidence for EXISTING
 * owner PR #5340 (RQ-PHX-OWNERLIVESELFTICKRECOVER250S), restoring the
 * self-tick owner-live stage from original #4286. The suite self-skips on
 * trees without the stage (master before #5340 merges). All roots are
 * temporary, owner transports are fake, and the owner-thread options factory
 * is a tripwire: a custom runs dir without ownerOptions must never resolve
 * real owner-thread options or transports.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { OWNER_LIVE_NOTICE_TEXT } from '../src/core/comms/owner-live-notice.js';
import type { OwnerChannelTransport, OwnerDelivery, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import type { OwnerChannel } from '../src/core/comms/leader-mailbox.js';
import { SELF_TICK_STEP_ORDER, type SelfTickStep } from '../src/core/fleet/self-tick.js';

const ownerOptionsFactory = vi.hoisted(() => vi.fn(() => {
  throw new Error('ownerThreadOptions resolved without injected ownerOptions');
}));
vi.mock('../src/cli/comms-owner-thread.js', () => ({ ownerThreadOptions: ownerOptionsFactory }));

const NOW = 1_700_000_000_000;
const NOW_MS = () => NOW;
const hasOwnerStage = (SELF_TICK_STEP_ORDER as readonly string[]).includes('owner-live');
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

const settings: OwnerThreadSettings = {
  owners: {
    desktop: 'fake-owner-desk-287', telegram: 'fake-owner-tg-287', email: 'email:fake-owner-287@example.invalid',
    imessage: 'fake-owner-imsg-287', slack: 'fake-owner-slack-287',
  },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN', email: 'phm_EMAIL_CREDENTIAL', slack: 'phm_SLACK_BOT_TOKEN' },
  imessageBridge: 'loopback',
  confirmed: true,
  team: [
    { channel: 'bus', id: 'fake-owner-desk-287' },
    { channel: 'telegram', id: 'fake-owner-tg-287' },
    { channel: 'email', id: 'email:fake-owner-287@example.invalid' },
    { channel: 'imessage', id: 'fake-owner-imsg-287' },
    { channel: 'slack', id: 'fake-owner-slack-287' },
  ],
};

function ownerFixture(overrides: Partial<OwnerThreadOptions> = {}, refuse = false) {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-live-stage-287-'));
  roots.push(runsDir);
  const calls: string[] = [];
  const sent: OwnerDelivery[] = [];
  const transport = (name: string): OwnerChannelTransport => ({
    async pull() { calls.push(`pull:${name}`); return []; },
    async deliver(input) {
      calls.push(`deliver:${name}`);
      if (refuse) return { status: 'refused', reason: 'fake-refuse-287' };
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

type TickDeps = NonNullable<Parameters<typeof cmdFleetSelfTick>[1]>;
type TickSteps = NonNullable<TickDeps['steps']>;
interface TickFixture {
  home: string;
  runsDir: string;
  output: string[];
  steps: TickSteps;
  orderNotices: ReturnType<typeof vi.fn>;
}

function tickFixture(): TickFixture {
  const home = mkdtempSync(join(tmpdir(), 'owner-live-stage-tick-287-'));
  roots.push(home);
  const runsDir = join(home, 'runs');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  const ok: SelfTickStep = async () => ({ exitCode: 0, output: '{}' });
  const orderNotices = vi.fn(ok);
  const steps: TickSteps = {
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
  report(fx).steps.find(step => step.step === name);

describe.skipIf(!hasOwnerStage)('self-tick owner-live stage qualification (PR #5340)', () => {
  it('custom --runs-dir without ownerOptions never resolves owner-thread options or transports', async () => {
    const fx = tickFixture();
    const custom = join(fx.home, 'custom-runs');
    mkdirSync(join(custom, 'queue'), { recursive: true });
    ownerOptionsFactory.mockClear();

    expect(await tick(fx, { apply: true, runsDir: custom })).toBe(0);
    expect(ownerOptionsFactory).not.toHaveBeenCalled();
    expect(stepReport(fx, 'owner-live')).toMatchObject({
      state: 'ok', exitCode: 0,
      report: { reason: 'custom-runs-dir-no-owner-thread' },
    });
    expect(fx.orderNotices).toHaveBeenCalledOnce();
  });

  it('explicit ownerOptions reaches the real owner-live verb: dry-run plans, apply sends once per live channel, repeat dedupes', async () => {
    const fx = tickFixture();
    const { options, calls, sent } = ownerFixture();
    await inbound(options, 'telegram', 'fake-tg-inbound-287');
    await inbound(options, 'slack', 'fake-sl-inbound-287');
    ownerOptionsFactory.mockClear();

    expect(await tick(fx, { ownerOptions: options })).toBe(0);
    expect(stepReport(fx, 'owner-live')!.report).toMatchObject({
      v: 1, planned: ['telegram', 'slack'], sent: [], failed: [],
    });
    expect(calls.filter(call => call.startsWith('deliver:'))).toEqual([]);
    expect(sent).toEqual([]);

    fx.output.length = 0;
    expect(await tick(fx, { apply: true, ownerOptions: options })).toBe(0);
    expect(stepReport(fx, 'owner-live')!.report).toMatchObject({
      v: 1, planned: ['telegram', 'slack'], sent: ['telegram', 'slack'], failed: [],
    });
    expect(sent.map(row => row.idempotencyKey)).toEqual([
      'leader-live-telegram:telegram', 'leader-live-telegram:desktop',
      'leader-live-slack:slack', 'leader-live-slack:desktop',
    ]);
    expect(sent.every(row => row.text === OWNER_LIVE_NOTICE_TEXT)).toBe(true);
    expect(ownerOptionsFactory).not.toHaveBeenCalled();

    fx.output.length = 0;
    expect(await tick(fx, { apply: true, ownerOptions: options })).toBe(0);
    expect(stepReport(fx, 'owner-live')!.report).toMatchObject({ planned: [], sent: [], failed: [] });
    expect(sent).toHaveLength(4);
    expect(calls.filter(call => call.startsWith('deliver:'))).toHaveLength(4);
  });

  it('a refused owner-live apply fails its step but later stages still run', async () => {
    const fx = tickFixture();
    const { options, sent } = ownerFixture({}, true);
    await inbound(options, 'telegram', 'fake-tg-refused-287');

    expect(await tick(fx, { apply: true, ownerOptions: options })).toBe(1);
    expect(stepReport(fx, 'owner-live')).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(stepReport(fx, 'owner-live')!.report).toMatchObject({ planned: ['telegram'], sent: [], failed: [{ channel: 'telegram' }] });
    expect(sent).toEqual([]);
    expect(fx.orderNotices).toHaveBeenCalledOnce();
    expect(report(fx).steps.map(step => step.step)).toEqual([...SELF_TICK_STEP_ORDER]);
    expect(report(fx).steps.find(step => step.step === 'order-notices')).toMatchObject({ state: 'ok' });
  });
});
