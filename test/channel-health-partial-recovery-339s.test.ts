import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetChannelHealth } from '../src/cli/fleet-channel-health.js';
import type { ChannelHealthReport, ChannelSource } from '../src/core/fleet/channel-health.js';

// RQ-PHX-CHANNELPARTIALRECOVER339S: a failed Slack observation must not
// discard independently readable iMessage evidence, and a later read of the
// same sources must report recovered evidence instead of retained failure.

const T0 = new Date('2026-11-14T04:00:00.000Z');
const T1 = new Date('2026-11-14T04:30:00.000Z');
const PRIVATE = '/Users/fake-owner/Library/Private/agent-net/slack-journal.jsonl';
const MIN = 60_000;

interface Counters { slackEvidence: number; slackInbound: number; imessageInbound: number }

function fixture() {
  let clock = T0;
  let slackDown = true;
  const reads: Counters = { slackEvidence: 0, slackInbound: 0, imessageInbound: 0 };
  const slack: ChannelSource = {
    configMissing: () => [],
    processAlive: () => true,
    inbound: () => { reads.slackInbound++; return []; },
    inboundEvidence: async () => {
      reads.slackEvidence++;
      if (slackDown) throw new Error(`EACCES ${PRIVATE}`);
      return { store: 'ok', rows: [] };
    },
    replies: () => [],
  };
  const imessage: ChannelSource = {
    configMissing: () => [],
    processAlive: () => true,
    inbound: () => {
      reads.imessageInbound++;
      return [new Date(clock.getTime() - 5 * MIN).toISOString()];
    },
    replies: () => [],
  };
  const deps = { now: () => clock, host: 'fake-host', sources: { slack, imessage } };
  const run = () => cmdFleetChannelHealth(['--json'], deps);
  const jsonOut = (log: ReturnType<typeof vi.spyOn>) =>
    JSON.parse(String(log.mock.calls.at(-1)?.[0])) as ChannelHealthReport;
  return {
    reads, deps, run, jsonOut,
    heal: () => { slackDown = false; clock = T1; },
    at: (d: Date) => { clock = d; },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('channel health partial observation failure and recovery', () => {
  it('a failed Slack read keeps iMessage evidence, then a fresh read reports recovery', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await f.run()).toBe(1);
    const first = f.jsonOut(log);
    expect(first.asOf).toBe(T0.toISOString());
    const slackRow = first.channels.find((c) => c.channel === 'slack')!;
    const imsgRow = first.channels.find((c) => c.channel === 'imessage')!;
    expect(first.channels.filter((c) => c.state === 'UNKNOWN')).toHaveLength(1);
    expect(slackRow).toMatchObject({ state: 'UNKNOWN', configured: true, processAlive: true });
    expect(slackRow.missing).toEqual(['slack receipt source unreadable']);
    expect(imsgRow.state).toBe('LIVE');
    expect(imsgRow.lastInboundAt).toBe(new Date(T0.getTime() - 5 * MIN).toISOString());
    expect(imsgRow.unansweredCount).toBe(1);

    f.heal();
    expect(await f.run()).toBe(0);
    const second = f.jsonOut(log);
    expect(second.asOf).toBe(T1.toISOString());
    const healedSlack = second.channels.find((c) => c.channel === 'slack')!;
    const healedImsg = second.channels.find((c) => c.channel === 'imessage')!;
    expect(healedSlack).toMatchObject({ state: 'LIVE', asOf: T1.toISOString(), unansweredCount: 0 });
    expect(healedSlack.missing).toEqual([]);
    expect(healedSlack.proof.requestCoverage).toBe('idle');
    expect(healedImsg.state).toBe('LIVE');
    expect(healedImsg.lastInboundAt).toBe(new Date(T1.getTime() - 5 * MIN).toISOString());

    // Each invocation reread the injected sources; nothing was replayed.
    expect(f.reads).toEqual({ slackEvidence: 2, slackInbound: 0, imessageInbound: 2 });

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    const errOut = err.mock.calls.map((c) => String(c[0])).join('\n');
    for (const text of [out, errOut]) {
      expect(text).not.toContain(PRIVATE);
      expect(text).not.toContain('/Users/fake-owner');
    }
  });

  it('reversed: a failed iMessage read keeps Slack evidence and recovers the same way', async () => {
    let clock = T0;
    let imsgDown = true;
    const reads = { slackEvidence: 0, imessageInbound: 0 };
    const slack: ChannelSource = {
      configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [],
      inboundEvidence: () => { reads.slackEvidence++; return { store: 'ok' as const, rows: [] }; },
    };
    const imessage: ChannelSource = {
      configMissing: () => [], processAlive: () => true, replies: () => [],
      inbound: async () => {
        reads.imessageInbound++;
        if (imsgDown) throw new Error(`EACCES ${PRIVATE}`);
        return [new Date(clock.getTime() - 5 * MIN).toISOString()];
      },
    };
    const deps = { now: () => clock, host: 'fake-host', sources: { slack, imessage } };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await cmdFleetChannelHealth(['--json'], deps)).toBe(1);
    const first = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as ChannelHealthReport;
    const slackRow = first.channels.find((c) => c.channel === 'slack')!;
    const imsgRow = first.channels.find((c) => c.channel === 'imessage')!;
    expect(first.channels.filter((c) => c.state === 'UNKNOWN')).toHaveLength(1);
    expect(slackRow.state).toBe('LIVE');
    expect(slackRow.proof.durableIngress).toEqual({ posted: 0, duplicate: 0, failed: 0, unverified: 0 });
    expect(imsgRow).toMatchObject({ state: 'UNKNOWN', configured: true, processAlive: true });
    expect(imsgRow.missing).toEqual(['imessage receipt source unreadable']);

    imsgDown = false;
    clock = T1;
    expect(await cmdFleetChannelHealth(['--json'], deps)).toBe(0);
    const second = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as ChannelHealthReport;
    expect(second.asOf).toBe(T1.toISOString());
    expect(second.channels.find((c) => c.channel === 'imessage')).toMatchObject({
      state: 'LIVE', asOf: T1.toISOString(),
      lastInboundAt: new Date(T1.getTime() - 5 * MIN).toISOString(),
    });
    expect(reads).toEqual({ slackEvidence: 2, imessageInbound: 2 });

    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    const errOut = err.mock.calls.map((c) => String(c[0])).join('\n');
    for (const text of [out, errOut]) {
      expect(text).not.toContain(PRIVATE);
      expect(text).not.toContain('/Users/fake-owner');
    }
  });
});
