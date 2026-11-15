import { describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import type { ChannelHealth } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-14T12:00:00.000Z');
const absent = (): never => { throw new Error('fake unavailable reader'); };
function channel(name: 'slack' | 'imessage', coverage: 'idle' | 'verified' | 'unproven'): ChannelHealth {
  return {
    channel: name, configured: true, processAlive: true, runtimeHost: 'fake-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: coverage === 'unproven' ? 2 : 0,
    proof: { requestCoverage: coverage, futureDatedCount: 0 },
    state: 'LIVE', missing: [], asOf: now.toISOString(),
  };
}
function recheck(channels: ChannelHealth[]) {
  const deps: FleetRecheckDeps = {
    now: () => now, homeDir: () => '/home/fake', readRuntimeIdentity: absent,
    readFleetBoard: absent, listWorkBoard: absent, listCoordination: absent,
    listLiveWorkers: absent, readTailnetPeers: absent, readPool: absent,
    readOrders: absent, readLaneTargets: absent,
    readChannelHealth: () => ({ schemaVersion: 1, asOf: now.toISOString(), channels }),
  };
  return readFleetRecheck(deps);
}

describe('PR #5633 bridge coverage recut', () => {
  it('preserves request proof through the real reader and reply without changing verdicts', async () => {
    const idle = await recheck([channel('slack', 'idle'), channel('imessage', 'idle')]);
    const result = await recheck([channel('slack', 'unproven'), channel('imessage', 'verified')]);
    expect(result.overall).toEqual(idle.overall);
    expect(result.sections.bridge.state).toBe(idle.sections.bridge.state);
    expect(result.sections.bridge.missing).toEqual(idle.sections.bridge.missing);
    expect(result.sections.bridge.channels).toMatchObject([
      { channel: 'slack', requestCoverage: 'unproven', unansweredCount: 2 },
      { channel: 'imessage', requestCoverage: 'verified', unansweredCount: 0 },
    ]);
    const reply = formatRecheckReply(result);
    expect(reply).toContain('Slack: 2 requests without a bound reply');
    expect(reply).toContain('IMessage: recent requests answered in thread');
    expect(reply.indexOf('Bridge:')).toBeLessThan(reply.indexOf('Slack:'));
    expect(reply.indexOf('IMessage:')).toBeLessThan(reply.indexOf('Task:'));
    expect(reply.length).toBeLessThanOrEqual(900);
  });

  it('omits idle proof and records an absent required channel explicitly', async () => {
    const result = await recheck([channel('slack', 'idle')]);
    expect(result.sections.bridge.channels[0]).not.toHaveProperty('requestCoverage');
    expect(result.sections.bridge.channels[0]).not.toHaveProperty('unansweredCount');
    expect(result.sections.bridge.channels[1]).toMatchObject({
      channel: 'imessage', state: 'UNKNOWN', requestCoverage: 'unknown', unansweredCount: null,
    });
    expect(result.sections.bridge.state).toBe('BLOCKED');
    expect(formatRecheckReply(result)).not.toMatch(/Slack:|IMessage:/);
  });

  it('drops coverage first when space is tight, keeping newer computers and pool evidence', async () => {
    const result = await recheck([channel('slack', 'unproven'), channel('imessage', 'verified')]);
    let found = false;
    for (let length = 0; length < 900; length++) {
      result.sections.runtime.host = 'x'.repeat(length);
      const reply = formatRecheckReply(result);
      if (!reply.includes('Slack:') && reply.includes('Computers:') && reply.includes('Pool:')) {
        expect(reply.length).toBeLessThanOrEqual(900);
        expect(reply).not.toContain('IMessage:');
        expect(reply).toContain('UNKNOWN:');
        expect(reply.endsWith('…')).toBe(false);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
