/**
 * `phm channels` overview (phantom.channels.v1): fixture facts through the
 * pure builder, the CLI over an injected reader, and the default reader on an
 * empty temp home. No real home, no network, no real bridge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildChannelsOverview,
  CHANNELS_OVERVIEW_SCHEMA,
  createDefaultChannelsReader,
  parseInboxAt,
  type ChannelFacts,
  type ChannelOverviewRow,
} from '../src/core/fleet/channels-overview.js';
import type { ChannelHealth, ChannelSource } from '../src/core/fleet/channel-health.js';
import type { ChannelStatusRow, ChannelsStatus } from '../src/core/fleet/channels.js';
import { cmdChannels, cmdChannelsOverview } from '../src/cli/channels.js';

const NOW = new Date('2026-11-17T18:00:00.000Z');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
/** Inbox `at` is the local wall clock "YYYY-MM-DD HH:MM". */
const inboxAt = (h: number): string => {
  const d = new Date(NOW.getTime() - h * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function statusRow(kind: ChannelStatusRow['kind'], patch: Partial<ChannelStatusRow> = {}): ChannelStatusRow {
  return {
    kind, configured: true, credential: 'none-needed', paired: null, received: 0, lastSeenAt: null,
    pendingOutbound: 0, ready: true, ...patch,
  };
}

function health(channel: 'slack' | 'imessage', patch: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    channel, configured: true, processAlive: true, runtimeHost: 'host', lastInboundAt: null, lastReplyAt: null,
    unansweredCount: 0, proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [],
    asOf: NOW.toISOString(), ...patch,
  };
}

/** Every channel connected, with traffic and raw addresses the builder must mask. */
function connectedFacts(): ChannelFacts {
  const status: ChannelsStatus = {
    v: 1, at: NOW.toISOString(), inbox: 'healthy',
    channels: [
      statusRow('email', { credential: 'file', paired: true, lastSeenAt: inboxAt(2) }),
      statusRow('telegram', { credential: 'environment', paired: true, lastSeenAt: inboxAt(1) }),
      statusRow('mobile'), statusRow('desktop', { lastSeenAt: inboxAt(30) }), statusRow('page'), statusRow('cli'),
    ],
  };
  return {
    now: NOW,
    status,
    inbox: [
      { at: inboxAt(1), source: 'telegram' },
      { at: inboxAt(3), source: 'telegram' },
      { at: inboxAt(2), source: 'email' },
      { at: inboxAt(30), source: 'Phantom desktop' }, // outside 24 h
    ],
    health: { schemaVersion: 1, asOf: NOW.toISOString(), channels: [health('slack'), health('imessage')] },
    relay: {
      slack: { inbound: [hoursAgo(5), hoursAgo(1), hoursAgo(26)], replies: [hoursAgo(0.5)] },
      imessage: { inbound: [hoursAgo(4)], replies: [hoursAgo(3)] },
    },
    verified: { email: 2, mobile: 1, slack: 3, imessage: 1 },
    emailConfig: 'ok',
    addresses: {
      telegram: ['123456789'],
      email: ['mason@example.com', 'ops@example.com'],
      imessage: ['+15551234567'],
      slack: ['T0123ABCD'],
    },
  };
}

const byChannel = (rows: ChannelOverviewRow[]) => Object.fromEntries(rows.map((r) => [r.channel, r]));

describe('buildChannelsOverview', () => {
  it('all connected: one row per registry channel with times, 24 h counts and verified senders', () => {
    const view = buildChannelsOverview(connectedFacts());
    expect(view.schema).toBe(CHANNELS_OVERVIEW_SCHEMA);
    expect(view.version).toBe(1);
    expect(view.at).toBe(NOW.toISOString());
    expect(view.counts).toEqual({ connected: 8, 'not-set-up': 0, failing: 0, unknown: 0 });
    // Registry order (RECEIVER_CHANNELS) when every state ties.
    expect(view.channels.map((r) => r.channel)).toEqual(['email', 'telegram', 'imessage', 'mobile', 'desktop', 'page', 'cli', 'slack']);
    const by = byChannel(view.channels);
    expect(by['telegram']).toMatchObject({ state: 'connected', reason: null, next: null, messages24h: 2, verifiedSenders: 1, lastOutboundAt: 'unknown' });
    expect(by['telegram']!.lastInboundAt).toBe(new Date(parseInboxAt(inboxAt(1))).toISOString());
    expect(by['email']).toMatchObject({ messages24h: 1, verifiedSenders: 2 });
    expect(by['desktop']).toMatchObject({ messages24h: 0, verifiedSenders: null });
    expect(by['slack']).toMatchObject({ messages24h: 2, verifiedSenders: 3, lastInboundAt: hoursAgo(1), lastOutboundAt: hoursAgo(0.5) });
    expect(by['imessage']).toMatchObject({ messages24h: 1, verifiedSenders: 1, lastOutboundAt: hoursAgo(3) });
    expect(by['mobile']).toMatchObject({ verifiedSenders: 1, address: null });
  });

  it('keeps a stable wire shape: the same keys on every row', () => {
    const view = buildChannelsOverview(connectedFacts());
    expect(Object.keys(view).sort()).toEqual(['at', 'channels', 'counts', 'schema', 'version']);
    for (const row of view.channels) {
      expect(Object.keys(row).sort()).toEqual([
        'address', 'channel', 'label', 'lastInboundAt', 'lastOutboundAt', 'messages24h', 'next', 'reason', 'state', 'verifiedSenders',
      ]);
    }
  });

  it('one failing: it sorts first and says what is wrong and the one next step', () => {
    const facts = connectedFacts();
    facts.health!.channels[0] = health('slack', { state: 'BLOCKED', processAlive: false, missing: ['slack bridge process not running'] });
    const view = buildChannelsOverview(facts);
    expect(view.counts).toMatchObject({ failing: 1, connected: 7 });
    expect(view.channels[0]).toMatchObject({
      channel: 'slack', state: 'failing', reason: 'slack bridge process not running',
      next: 'start the bridge: `phm channels slack run --seconds 300`',
    });
    // Times still come from receipts, even with the process down.
    expect(view.channels[0]!.lastInboundAt).toBe(hoursAgo(1));
  });

  it('a configured channel with no credential is failing, not "not set up"', () => {
    const facts = connectedFacts();
    facts.status.channels[1] = statusRow('telegram', { credential: 'missing', ready: false, paired: false, next: 'put the bot token in TELEGRAM_BOT_TOKEN' });
    const row = byChannel(buildChannelsOverview(facts).channels)['telegram']!;
    expect(row).toMatchObject({ state: 'failing', reason: 'Telegram credential is missing', next: 'put the bot token in TELEGRAM_BOT_TOKEN', verifiedSenders: 0 });
  });

  it('an invalid email-drop config is failing and its path is scrubbed', () => {
    const facts = connectedFacts();
    facts.emailConfig = 'invalid';
    facts.status.channels[0] = statusRow('email', { configured: false, ready: false, next: 'email-drop config is invalid at /Users/someone/.ashlr-runs/queue/email-drop.json' });
    const row = byChannel(buildChannelsOverview(facts).channels)['email']!;
    expect(row.state).toBe('failing');
    expect(row.next).not.toContain('/Users/someone');
  });

  it('none set up: every remote channel says how to start; built-ins stay connected', () => {
    const facts = connectedFacts();
    facts.status.channels = [
      statusRow('email', { configured: false, credential: 'missing', paired: false, ready: false, next: 'phm channels add email <inboxDir> --from <address>' }),
      statusRow('telegram', { configured: false, credential: 'missing', paired: false, ready: false, next: 'phm channels add telegram <chat-id>' }),
      statusRow('mobile', { configured: false, ready: false, next: 'the phone gateway needs ~/.ashlr/verse-remote.json' }),
      statusRow('desktop'), statusRow('page'), statusRow('cli'),
    ];
    facts.health = { schemaVersion: 1, asOf: NOW.toISOString(), channels: [
      health('slack', { configured: false, processAlive: 'unknown', state: 'BLOCKED', missing: ['slack config section not configured'] }),
      health('imessage', { configured: false, processAlive: 'unknown', state: 'BLOCKED', missing: ['imessage comms configuration not configured'] }),
    ] };
    facts.relay = { slack: { inbound: [], replies: [] }, imessage: { inbound: [], replies: [] } };
    facts.inbox = [];
    facts.addresses = {};
    facts.verified = { email: 0, mobile: 0, slack: 0, imessage: 0 };
    const view = buildChannelsOverview(facts);
    expect(view.counts).toEqual({ connected: 3, 'not-set-up': 5, failing: 0, unknown: 0 });
    expect(view.channels.slice(0, 5).map((r) => r.channel)).toEqual(['email', 'telegram', 'imessage', 'mobile', 'slack']);
    for (const row of view.channels.slice(0, 5)) {
      expect(row.state).toBe('not-set-up');
      expect(row.next).toBeTruthy();
      expect(row.lastInboundAt).toBeNull();
      expect(row.messages24h).toBe(0);
    }
    expect(byChannel(view.channels)['imessage']!.next).toContain('phm imessage doctor');
    expect(byChannel(view.channels)['slack']!.next).toContain('phm channels slack status');
  });

  it('never shows a token, number or address in full', () => {
    const view = buildChannelsOverview(connectedFacts());
    const json = JSON.stringify(view);
    for (const raw of ['123456789', 'mason@example.com', 'ops@example.com', '+15551234567', '5551234567', 'T0123ABCD']) {
      expect(json).not.toContain(raw);
    }
    const by = byChannel(view.channels);
    expect(by['telegram']!.address).toBe('*****6789');
    expect(by['imessage']!.address).toBe('********4567');
    expect(by['email']!.address).toBe('*************.com +1');
    expect(by['slack']!.address).toBe('*****ABCD');
  });

  it('shows unknown as unknown: unreadable health, receipts and inbox', () => {
    const facts = connectedFacts();
    facts.health = null;
    facts.inbox = null;
    facts.relay.imessage = { inbound: 'unknown', replies: 'unknown' };
    facts.verified.slack = 'unknown';
    facts.status.channels[1] = statusRow('telegram', { credential: 'environment', paired: true, lastSeenAt: 'unknown' });
    const view = buildChannelsOverview(facts);
    expect(view.counts.unknown).toBe(2);
    expect(view.channels.slice(0, 2).map((r) => r.channel)).toEqual(['imessage', 'slack']);
    const by = byChannel(view.channels);
    expect(by['imessage']).toMatchObject({ state: 'unknown', reason: 'iMessage health could not be read', lastInboundAt: 'unknown', messages24h: 'unknown' });
    expect(by['slack']).toMatchObject({ verifiedSenders: 'unknown' });
    expect(by['telegram']).toMatchObject({ state: 'connected', lastInboundAt: 'unknown', messages24h: 'unknown' });
  });

  it('keeps verified senders unknown when the pairing stores cannot be read', () => {
    const facts = connectedFacts();
    facts.status.channels[0] = statusRow('email', { credential: 'file', paired: 'unknown', lastSeenAt: inboxAt(2) });
    facts.status.channels[1] = statusRow('telegram', { credential: 'environment', paired: 'unknown', lastSeenAt: inboxAt(1) });
    facts.verified.email = 'unknown';
    const by = byChannel(buildChannelsOverview(facts).channels);
    expect(by['email']!.verifiedSenders).toBe('unknown');
    expect(by['telegram']!.verifiedSenders).toBe('unknown');
    // The channels themselves stay connected — only the sender count is unmeasurable.
    expect(by['email']!.state).toBe('connected');
    expect(by['telegram']!.state).toBe('connected');
  });

  it('maps an UNKNOWN health row to unknown with its reason', () => {
    const facts = connectedFacts();
    facts.health!.channels[1] = health('imessage', { state: 'UNKNOWN', processAlive: 'unknown', missing: ['imessage bridge process liveness unverifiable'] });
    const row = byChannel(buildChannelsOverview(facts).channels)['imessage']!;
    expect(row).toMatchObject({ state: 'unknown', reason: 'imessage bridge process liveness unverifiable' });
  });
});

describe('phm channels (overview CLI)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('--json prints phantom.channels.v1', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    expect(await cmdChannelsOverview(['--json'], async () => connectedFacts())).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as { schema: string; version: number; channels: unknown[] };
    expect(parsed.schema).toBe(CHANNELS_OVERVIEW_SCHEMA);
    expect(parsed.version).toBe(1);
    expect(parsed.channels).toHaveLength(8);
  });

  it('prints a table with failing first, plain words and masked addresses', async () => {
    const facts = connectedFacts();
    facts.health!.channels[1] = health('imessage', { state: 'DEGRADED', missing: ['imessage reply overdue'] });
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    expect(await cmdChannelsOverview([], async () => facts)).toBe(0);
    expect(out[0]).toMatch(/^channel\s+state\s+last in\s+last out\s+24h\s+verified\s+address$/);
    expect(out[1]).toMatch(/^iMessage\s+failing\s+4h ago\s+3h ago\s+1\s+1\s+\*+4567$/);
    expect(out.join('\n')).toContain('iMessage next: a text is waiting for a reply');
    expect(out.join('\n')).not.toContain('15551234567');
  });

  it('rejects unknown flags with exit 2', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdChannelsOverview(['--bogus'], async () => connectedFacts())).toBe(2);
  });

  it('--help still prints usage, naming the bare form', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    expect(await cmdChannels(['--help'])).toBe(0);
    expect(out[0]).toContain('usage: phm channels [--json]');
  });
});

describe('default reader', () => {
  const roots: string[] = [];
  afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('reads an empty home without guessing: built-ins connected, the rest not set up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'channels-overview-'));
    roots.push(root);
    const calls: string[] = [];
    const source = (name: string, configured: boolean): ChannelSource => ({
      configMissing: () => (configured ? [] : [`${name} config`]),
      processAlive: () => false,
      inbound: () => { calls.push(`${name}:inbound`); return []; },
      replies: () => { calls.push(`${name}:replies`); return []; },
    });
    const reader = createDefaultChannelsReader({
      cfg: {} as never, homeDir: root, runsDir: join(root, '.ashlr-runs'), env: {}, now: () => NOW,
      sources: { slack: source('slack', false), imessage: source('imessage', true) },
      mobileDevices: () => 0,
    });
    const facts = await reader();
    // Health stopped early for both; the reader still read each store exactly once.
    expect(calls.sort()).toEqual(['imessage:inbound', 'imessage:replies', 'slack:inbound', 'slack:replies']);
    const view = buildChannelsOverview(facts);
    const by = byChannel(view.channels);
    expect(by['slack']).toMatchObject({ state: 'not-set-up', messages24h: 0, lastInboundAt: null });
    expect(by['imessage']).toMatchObject({ state: 'failing', next: 'run `phm imessage poll --apply` to take waiting texts' });
    expect(by['cli']).toMatchObject({ state: 'connected', verifiedSenders: null });
    expect(by['telegram']).toMatchObject({ state: 'not-set-up', address: null });
    expect(by['mobile']).toMatchObject({ state: 'not-set-up', verifiedSenders: 0 });
    expect(view.channels).toHaveLength(8);
  });

  it('propagates an unreadable pairing store as unknown verified senders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'channels-overview-'));
    roots.push(root);
    const runsDir = join(root, '.ashlr-runs');
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'queue', 'telegram-pair.json'), '{broken');
    writeFileSync(join(runsDir, 'queue', 'email-paired.json'), '{broken');
    const source = (name: string): ChannelSource => ({
      configMissing: () => [`${name} config`],
      processAlive: () => false,
      inbound: () => [],
      replies: () => [],
    });
    const reader = createDefaultChannelsReader({
      cfg: {} as never, homeDir: root, runsDir, env: {}, now: () => NOW,
      sources: { slack: source('slack'), imessage: source('imessage') },
      mobileDevices: () => 0,
    });
    const view = buildChannelsOverview(await reader());
    const by = byChannel(view.channels);
    expect(by['telegram']!.verifiedSenders).toBe('unknown');
    expect(by['email']!.verifiedSenders).toBe('unknown');
  });
});
