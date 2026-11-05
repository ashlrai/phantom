import { describe, expect, it } from 'vitest';
import {
  maskHandle, readChatActivity, readTeammates, type TeammateChatEvent,
} from '../src/core/fleet/teammate-status.js';
import type { AshlrConfig } from '../src/core/types.js';

const SELF = '+15555550199';
const DOT = '+15555550100';
const T = (s: string): number => Date.parse(s);

const cfg = (over: Record<string, unknown> = {}): AshlrConfig => ({
  comms: { enabled: true, imessageHandle: SELF, imessageAllow: [SELF, DOT] },
  ...over,
} as unknown as AshlrConfig);

const a2aCounterpart = {
  enabled: true,
  counterparts: [{
    localOptIn: true, remoteOptInEvidence: 'consent-record-reference', channel: 'imessage', scope: ['dot-agent'],
  }],
};

const events = (rows: Array<[string, boolean, string]>): TeammateChatEvent[] =>
  rows.map(([handle, fromMe, iso]) => ({ handle, fromMe, ts: T(iso) }));

const okDeps = (activity?: (handles: string[]) => Promise<TeammateChatEvent[]>) => ({
  probe: () => 'ok' as const,
  activity: activity ?? (async () => []),
});

describe('maskHandle', () => {
  it('keeps the last 4 characters and stars the rest', () => {
    expect(maskHandle(DOT)).toBe('********0100');
    expect(maskHandle('teammate@example.invalid')).toBe('********************alid');
    expect(maskHandle('+1-555-0100')).toBe('*******0100');
  });

  it('fully masks handles of 4 characters or fewer', () => {
    expect(maskHandle('abcd')).toBe('****');
    expect(maskHandle('ab')).toBe('****');
    expect(maskHandle('  x  ')).toBe('****');
  });
});

describe('readTeammates', () => {
  it('reports an a2a iMessage counterpart with inbound/outbound times and unanswered count', async () => {
    const report = await readTeammates(cfg({ a2a: a2aCounterpart }), okDeps(async () => events([
      [DOT, false, '2026-11-04T20:00:00Z'],
      [DOT, true, '2026-11-04T21:00:00Z'],
      [DOT, false, '2026-11-04T22:00:00Z'],
      [DOT, false, '2026-11-04T23:00:00Z'],
    ])));
    expect(report.chatDb).toBe('ok');
    expect(report.teammates).toHaveLength(1);
    expect(report.teammates[0]).toEqual({
      name: 'dot-agent',
      channel: 'imessage',
      handleMasked: '********0100',
      offPlanCapacity: true,
      lastInboundAt: '2026-11-04T23:00:00.000Z',
      lastOutboundAt: '2026-11-04T21:00:00.000Z',
      unanswered: 2,
      source: 'a2a-config',
    });
  });

  it('names the counterpart from the matching declared teammates entry when present', async () => {
    const report = await readTeammates(cfg({
      a2a: a2aCounterpart,
      teammates: [{ name: 'dot-agent', handle: DOT, offPlanCapacity: false }],
    }), okDeps());
    expect(report.teammates).toHaveLength(1);
    expect(report.teammates[0]!.name).toBe('dot-agent');
    expect(report.teammates[0]!.handleMasked).toBe('********0100');
    expect(report.teammates[0]!.offPlanCapacity).toBe(false);
    expect(report.teammates[0]!.source).toBe('a2a-config');
  });

  it('lists a declared teammate and non-self allowlist handles with source allowlist', async () => {
    const report = await readTeammates(cfg({
      comms: { enabled: true, imessageHandle: SELF, imessageAllow: [SELF, 'teammate@example.invalid'] },
      teammates: [{ name: 'Dot', handle: DOT }],
    }), okDeps(async () => events([
      [DOT, false, '2026-11-04T22:00:00Z'],
      [DOT, false, '2026-11-04T23:00:00Z'],
    ])));
    expect(report.teammates.map((t) => t.name)).toEqual(['Dot', '********************alid']);
    expect(report.teammates[0]).toMatchObject({ channel: 'imessage', source: 'allowlist', unanswered: 2, lastOutboundAt: null });
    expect(report.teammates[1]).toMatchObject({ channel: 'imessage', source: 'allowlist', unanswered: 0 });
    // The self handle is never a teammate.
    expect(report.teammates.every((t) => t.handleMasked !== maskHandle(SELF))).toBe(true);
  });

  it.each(['blocked_full_disk_access', 'missing'] as const)('returns the roster with null times when chat.db is %s', async (state) => {
    let called = false;
    const report = await readTeammates(cfg({ a2a: a2aCounterpart }), {
      probe: () => state,
      activity: async () => { called = true; return []; },
    });
    expect(report.chatDb).toBe(state);
    expect(called).toBe(false);
    expect(report.teammates).toHaveLength(1);
    expect(report.teammates[0]).toMatchObject({
      name: 'dot-agent', handleMasked: '********0100', lastInboundAt: null, lastOutboundAt: null, unanswered: 0,
    });
  });

  it('handles a non-imessage counterpart and an empty config without throwing', async () => {
    const emailOnly = await readTeammates(cfg({
      a2a: {
        enabled: true,
        counterparts: [{ localOptIn: true, remoteOptInEvidence: 'ref', channel: 'email', scope: ['pen-pal'] }],
      },
    }), okDeps());
    expect(emailOnly.teammates[0]).toMatchObject({
      name: 'pen-pal', channel: 'email', handleMasked: null, lastInboundAt: null, unanswered: 0, source: 'a2a-config',
    });
    const empty = await readTeammates({} as AshlrConfig, okDeps());
    expect(empty.teammates).toEqual([]);
  });

  it('never throws when the activity seam fails', async () => {
    const report = await readTeammates(cfg({ a2a: a2aCounterpart }), {
      probe: () => 'ok' as const,
      activity: async () => { throw new Error('sqlite exploded'); },
    });
    expect(report.teammates[0]).toMatchObject({ lastInboundAt: null, lastOutboundAt: null, unanswered: 0 });
  });
});

describe('readChatActivity', () => {
  it('returns [] off darwin or for empty/blank handles without spawning sqlite', async () => {
    expect(await readChatActivity([])).toEqual([]);
    expect(await readChatActivity(['  '])).toEqual([]);
    if (process.platform !== 'darwin') {
      expect(await readChatActivity([DOT])).toEqual([]);
    }
  });
});
