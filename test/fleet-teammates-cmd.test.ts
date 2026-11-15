import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetTeammates } from '../src/cli/fleet-teammates.js';
import type { TeammateChatEvent } from '../src/core/fleet/teammate-status.js';
import type { AshlrConfig } from '../src/core/types.js';

const SELF = '+15555550199';
const DOT = '+15555550100';

const cfg = {
  comms: { enabled: true, imessageHandle: SELF, imessageAllow: [SELF, DOT] },
  a2a: {
    enabled: true,
    counterparts: [{
      localOptIn: true, remoteOptInEvidence: 'consent-record-reference', channel: 'imessage', scope: ['dot-agent'],
    }],
  },
} as unknown as AshlrConfig;

const activity = async (): Promise<TeammateChatEvent[]> => [
  { handle: DOT, fromMe: false, ts: Date.parse('2026-11-04T20:00:00Z') },
  { handle: DOT, fromMe: true, ts: Date.parse('2026-11-04T21:00:00Z') },
  { handle: DOT, fromMe: false, ts: Date.parse('2026-11-04T22:00:00Z') },
  { handle: DOT, fromMe: false, ts: Date.parse('2026-11-04T23:00:00Z') },
];

afterEach(() => vi.restoreAllMocks());

describe('cmdFleetTeammates', () => {
  it('prints the report struct under --json with a masked handle and unanswered count', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetTeammates(['--json'], { cfg, probe: () => 'ok', activity })).toBe(0);
    const report = JSON.parse(log.mock.calls[0]![0] as string);
    expect(report.v).toBe(1);
    expect(report.chatDb).toBe('ok');
    expect(report.teammates).toHaveLength(1);
    expect(report.teammates[0]).toMatchObject({
      name: 'dot-agent', channel: 'imessage', handleMasked: '********0100',
      offPlanCapacity: true, unanswered: 2, source: 'a2a-config',
      lastInboundAt: '2026-11-04T23:00:00.000Z', lastOutboundAt: '2026-11-04T21:00:00.000Z',
    });
    // The raw handle never leaves the read path.
    expect(log.mock.calls[0]![0]).not.toContain(DOT);
  });

  it('prints a human table by default and still exits 0 when chat.db is blocked', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetTeammates([], { cfg, probe: () => 'blocked_full_disk_access' })).toBe(0);
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('dot-agent');
    expect(out).toContain('********0100');
    expect(out).toContain('off-plan');
    expect(out).toContain('chat.db: blocked_full_disk_access');
    expect(out).not.toContain(DOT);
  });

  it('prints usage on --help and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetTeammates(['--help'], { cfg })).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('Usage: ashlr fleet teammates');
  });
});
