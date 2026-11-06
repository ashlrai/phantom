/**
 * RQ-AGENTNET-SLACK-1 -- Slack bridge adapter (main PR: mapping, inbound
 * parsing, offline CLI). Synthetic fixtures only; no socket, no Slack API,
 * no credential anywhere. The token injection and post path are the -sec PR.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadAgentNetworkConfig, loadCommsConfirmation, parseSlackThreadRef, slackChannelForTopic,
  slackThreadRef, slackTopicForChannel, type SlackBridgeConfig,
} from '../src/core/agents/slack-network.js';
import {
  ingestSlackSocketMessage, slackEventToBus, unwrapSlackSocketEnvelope,
} from '../src/core/agents/slack-inbound.js';
import {
  evaluateSlackAudience, slackAudienceRecipients, slackBackoffMs, slackOutboundPlan,
  slackRetriesExhausted, slackSendDecision, SLACK_BACKOFF_CAP_MS, SLACK_BACKOFF_MAX_ATTEMPTS,
  SLACK_MEMBER_CAP, type SlackAudienceSnapshot,
} from '../src/core/agents/slack-audience.js';
import { readSlackJournal, recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { buildSlackBridgeStatus, buildSlackMapReport } from '../src/core/agents/slack-status.js';
import { type TeamIdentity } from '../src/core/agents/channel-policy.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { cmdChannels } from '../src/cli/channels.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentnet-slack-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEAM: TeamIdentity[] = [
  { channel: 'slack', id: 'U0TEAMHUMAN' },
  { channel: 'slack', id: 'B0TEMAGENT' },
  { channel: 'slack', id: 'U0TEAMATE' },
];

const CONFIG: SlackBridgeConfig = {
  bridgeId: 'slack',
  teamId: 'T0WORKSPACE',
  ownUserId: 'U0BRIDGEBOT',
  ownBotId: 'B0BRIDGEBOT',
  botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN',
  appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN',
  map: [{ topic: 'leaders', channel: 'C0AGENTNET' }],
};

const TOML = `[team]
identities = [
  { channel = "slack", id = "U0TEAMHUMAN" },
  { channel = "slack", id = "B0TEMAGENT" },
  { channel = "slack", id = "U0TEAMATE" },
]

[slack]
team_id = "T0WORKSPACE"
own_user_id = "U0BRIDGEBOT"
own_bot_id = "B0BRIDGEBOT"
bot_token_ref = "phm_SLACK_AGENTNET_BOT_TOKEN"
app_token_ref = "phm_SLACK_AGENTNET_APP_TOKEN"

[[slack.map]]
topic = "leaders"
channel = "C0AGENTNET"
`;

function tomlDir(text: string = TOML): { home: string; path: string } {
  const home = root();
  const path = join(home, 'agent-network.toml');
  writeFileSync(path, text, { mode: 0o600 });
  return { home, path };
}

function messageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message', team: 'T0WORKSPACE', channel: 'C0AGENTNET',
    user: 'U0TEAMHUMAN', text: 'ship it', ts: '1712345678.000100', ...overrides,
  };
}

function socketEnvelope(event: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelope_id: 'env-1', type: 'events_api',
    payload: { event_id: 'Ev0TEST', event }, ...overrides,
  };
}

// ---------------------------------------------------------------------------
// agent-network.toml [slack] parsing
// ---------------------------------------------------------------------------

describe('agent-network.toml [slack]', () => {
  it('parses bridge config, token ref names and the topic<->channel map', () => {
    const { path } = tomlDir();
    const config = loadAgentNetworkConfig({ path });
    expect(config.state).toBe('ok');
    expect(config.slack).toEqual(CONFIG);
    expect(config.teamIdentities).toHaveLength(3);
    expect(slackChannelForTopic(CONFIG, 'leaders')).toBe('C0AGENTNET');
    expect(slackTopicForChannel(CONFIG, 'C0AGENTNET')).toBe('leaders');
    expect(slackChannelForTopic(CONFIG, 'other')).toBeUndefined();
    expect(slackTopicForChannel(CONFIG, 'C0OTHER')).toBeUndefined();
  });

  it('reports missing and malformed files distinctly', () => {
    expect(loadAgentNetworkConfig({ path: join(root(), 'absent.toml') }).state).toBe('missing');
    const { path } = tomlDir('this = [is not toml');
    const config = loadAgentNetworkConfig({ path });
    expect(config.state).toBe('invalid');
    expect(config.teamIdentities).toEqual([]);
    expect(config.slack).toBeUndefined();
  });

  it('fails closed on unknown keys, bad ids, bad refs and duplicates', () => {
    const cases: [string, string][] = [
      ['unknown key', `${TOML}\n[slack.extra]\nx = 1\n`],
      ['missing team_id', TOML.replace('team_id = "T0WORKSPACE"\n', '')],
      ['lowercase team_id', TOML.replace('T0WORKSPACE', 't0workspace')],
      ['bad channel id', TOML.replace('C0AGENTNET', 'channel-name')],
      ['dm channel id', TOML.replace('C0AGENTNET', 'D0DMCHANNEL')],
      ['non-phm ref', TOML.replace('phm_SLACK_AGENTNET_BOT_TOKEN', 'xoxb-not-a-ref')],
      ['duplicate topic', `${TOML}\n[[slack.map]]\ntopic = "leaders"\nchannel = "C0ANOTHER"\n`],
      ['duplicate channel', `${TOML}\n[[slack.map]]\ntopic = "another"\nchannel = "C0AGENTNET"\n`],
      ['secret-shaped bridge id', TOML.replace('team_id', 'bridge_id = "has space"\nteam_id')],
    ];
    for (const [name, text] of cases) {
      const { path } = tomlDir(text);
      expect(loadAgentNetworkConfig({ path }).slack, name).toBe('invalid');
    }
  });

  it('reads comms.toml confirmation only as a strict boolean', () => {
    const home = root();
    const comms = join(home, 'comms.toml');
    writeFileSync(comms, 'confirmedByMason = true\n');
    expect(loadCommsConfirmation({ path: comms })).toBe(true);
    writeFileSync(comms, 'confirmedByMason = "true"\n');
    expect(loadCommsConfirmation({ path: comms })).toBe(false);
    expect(loadCommsConfirmation({ path: join(home, 'absent.toml') })).toBe(false);
  });

  it('round-trips the slack:<team>:<channel>:<ts> thread ref', () => {
    const ref = slackThreadRef('T0WORKSPACE', 'C0AGENTNET', '1712345678.000100');
    expect(ref).toBe('slack:T0WORKSPACE:C0AGENTNET:1712345678.000100');
    expect(parseSlackThreadRef(ref)).toEqual({ teamId: 'T0WORKSPACE', channelId: 'C0AGENTNET', rootTs: '1712345678.000100' });
    expect(parseSlackThreadRef('slack:T0WORKSPACE:C0AGENTNET:not-a-ts')).toBeUndefined();
    expect(parseSlackThreadRef('incident-42')).toBeUndefined();
    expect(parseSlackThreadRef(42)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inbound: Socket Mode event -> bus envelope (pure decisions)
// ---------------------------------------------------------------------------

describe('slackEventToBus', () => {
  const ctx = { config: CONFIG, teamIdentities: TEAM };

  it('maps an allowlisted member message to a channel-aware envelope', () => {
    const decided = slackEventToBus(messageEvent(), ctx);
    expect(decided.status).toBe('ingest');
    if (decided.status !== 'ingest') return;
    const env = decided.envelope;
    expect(env.id).toBe('slack-T0WORKSPACE-C0AGENTNET-1712345678.000100');
    expect(env.from).toBe('slack:U0TEAMHUMAN');
    expect(env.to).toBe('leaders');
    expect(env.channel).toBe('slack');
    expect(env.channel_ref).toBe('slack:T0WORKSPACE:C0AGENTNET:1712345678.000100');
    expect(env.sender).toEqual({ agent_id: 'U0TEAMHUMAN', vendor: 'slack', human: true, team: true });
    expect(env.external).toBe(false);
    expect(env.origin_bridge).toBeUndefined();
    const body = env.body as Record<string, unknown>;
    expect(body['kind']).toBe('note');
    expect(body['text']).toBe('ship it');
    expect(body['thread']).toBe('slack:T0WORKSPACE:C0AGENTNET:1712345678.000100');
  });

  it('threads replies under the root ts', () => {
    const decided = slackEventToBus(messageEvent({ thread_ts: '1712345678.000050' }), ctx);
    expect(decided.status).toBe('ingest');
    if (decided.status !== 'ingest') return;
    expect(decided.envelope.channel_ref).toBe('slack:T0WORKSPACE:C0AGENTNET:1712345678.000050');
    expect((decided.envelope.body as Record<string, unknown>)['thread']).toBe('slack:T0WORKSPACE:C0AGENTNET:1712345678.000050');
  });

  it('accepts app_mention and allowlisted bot messages as team traffic', () => {
    const mention = slackEventToBus({ ...messageEvent(), type: 'app_mention' }, ctx);
    expect(mention.status).toBe('ingest');
    const bot = slackEventToBus(
      messageEvent({ subtype: 'bot_message', user: undefined, bot_id: 'B0TEMAGENT' }), ctx,
    );
    expect(bot.status).toBe('ingest');
    if (bot.status === 'ingest') expect(bot.envelope.sender).toMatchObject({ agent_id: 'B0TEMAGENT', human: false, team: true });
  });

  it('ignores non-team, unmapped, self and unallowlisted traffic by reason only', () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['foreign workspace', messageEvent({ team: 'T0OTHER' }), 'foreign-team'],
      ['unmapped channel', messageEvent({ channel: 'C0LOBBY' }), 'unmapped-channel'],
      ['stranger user', messageEvent({ user: 'U0STRANGER' }), 'untrusted-sender'],
      ['own bot echo', messageEvent({ subtype: 'bot_message', bot_id: 'B0BRIDGEBOT' }), 'self-message'],
      ['own user echo', messageEvent({ user: 'U0BRIDGEBOT' }), 'self-message'],
      ['own bot echo even when allowlisted', messageEvent({ subtype: 'bot_message', bot_id: 'B0BRIDGEBOT' }), 'self-message'],
      ['message_changed', messageEvent({ subtype: 'message_changed' }), 'unsupported-subtype'],
      ['reaction', messageEvent({ type: 'reaction_added' }), 'unsupported-event-type'],
      ['empty text', messageEvent({ text: '   ' }), 'empty-text'],
      ['secret-shaped text', messageEvent({ text: 'token: xoxb-FAKE-EXAMPLE-1234567890abcdef' }), 'secret-shaped-text'],
      ['hidden event', messageEvent({ hidden: true }), 'hidden-event'],
      ['bad ts', messageEvent({ ts: 'not-a-ts' }), 'malformed-event'],
      ['no author', messageEvent({ user: undefined }), 'malformed-event'],
    ];
    for (const [name, event, reason] of cases) {
      const decided = slackEventToBus(event, ctx);
      expect(decided.status, name).toBe('ignore');
      if (decided.status === 'ignore') expect(decided.reason, name).toBe(reason);
    }
  });

  it('lets an allowlisted bot in while still dropping the bridge bot from [team]', () => {
    const team = [...TEAM, { channel: 'slack' as const, id: 'B0BRIDGEBOT' }];
    const decided = slackEventToBus(
      messageEvent({ subtype: 'bot_message', bot_id: 'B0BRIDGEBOT' }),
      { config: CONFIG, teamIdentities: team },
    );
    expect(decided.status).toBe('ignore');
    if (decided.status === 'ignore') expect(decided.reason).toBe('self-message');
  });
});

// ---------------------------------------------------------------------------
// Composed ingest: journal + local bus append
// ---------------------------------------------------------------------------

describe('ingestSlackSocketMessage', () => {
  it('journals and publishes an accepted event; ignores record reason only', () => {
    const runsDir = join(root(), 'runs');
    const published: BusEnvelope[] = [];
    const publish = (env: BusEnvelope) => { published.push(env); return { status: 'posted' as const, id: env.id, cursor: 1 }; };
    const accepted = ingestSlackSocketMessage(socketEnvelope(messageEvent()), {
      config: CONFIG, teamIdentities: TEAM, runsDir, publish,
      now: () => new Date('2026-11-05T12:00:00Z'),
    });
    expect(accepted.decision).toBe('ingested');
    expect(accepted.bus).toBe('posted');
    expect(accepted.envelopeId).toBe('env-1');
    expect(accepted.eventId).toBe('Ev0TEST');
    expect(published).toHaveLength(1);

    const refused = ingestSlackSocketMessage(socketEnvelope(messageEvent({ user: 'U0STRANGER' })), {
      config: CONFIG, teamIdentities: TEAM, runsDir, publish,
      now: () => new Date('2026-11-05T12:00:01Z'),
    });
    expect(refused.decision).toBe('ignored');
    expect(refused.reason).toBe('untrusted-sender');
    expect(published).toHaveLength(1);

    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(2);
    const [refusedRow, acceptedRow] = journal.entries;
    expect(refusedRow).toMatchObject({ decision: 'ignored', reason: 'untrusted-sender', channelId: 'C0AGENTNET', authorId: 'U0STRANGER' });
    expect(acceptedRow).toMatchObject({ decision: 'ingested', bus: 'posted', channelId: 'C0AGENTNET', authorId: 'U0TEAMHUMAN' });
    // The journal carries ids and reason codes -- never message text.
    expect(JSON.stringify(journal.entries)).not.toContain('ship it');
  });

  it('unwraps only events_api envelopes', () => {
    expect(unwrapSlackSocketEnvelope(socketEnvelope(messageEvent()))).toMatchObject({ envelopeId: 'env-1', eventId: 'Ev0TEST' });
    expect(unwrapSlackSocketEnvelope({ type: 'interactive', payload: {} })).toEqual({ reason: 'unsupported-envelope-type' });
    expect(unwrapSlackSocketEnvelope('garbage')).toEqual({ reason: 'unsupported-envelope-type' });
    const result = ingestSlackSocketMessage({ type: 'disconnect' }, { config: CONFIG, teamIdentities: TEAM, runsDir: join(root(), 'runs') });
    expect(result.decision).toBe('ignored');
    expect(result.reason).toBe('unsupported-envelope-type');
  });
});

// ---------------------------------------------------------------------------
// Audience evaluation and outbound planning
// ---------------------------------------------------------------------------

const INTERNAL_SNAPSHOT: SlackAudienceSnapshot = {
  conversation: { is_channel: true, is_group: false, is_ext_shared: false },
  members: [
    { id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true },
    { id: 'U0TEAMHUMAN', team_id: 'T0WORKSPACE' },
    { id: 'B0TEMAGENT', team_id: 'T0WORKSPACE', is_bot: true },
  ],
};

describe('evaluateSlackAudience', () => {
  it('posts only to a proved team-only channel', () => {
    const result = evaluateSlackAudience(CONFIG, TEAM, 'C0AGENTNET', INTERNAL_SNAPSHOT);
    expect(result).toMatchObject({ status: 'postable', external: false, memberCount: 3 });
    expect(slackAudienceRecipients(CONFIG, INTERNAL_SNAPSHOT)).toEqual(['U0TEAMHUMAN', 'B0TEMAGENT']);
  });

  it('refuses shared, Connect, DM, guest, foreign, unknown-bot and unproved audiences', () => {
    const cases: [string, SlackAudienceSnapshot, string][] = [
      ['ext shared', { conversation: { is_ext_shared: true }, members: INTERNAL_SNAPSHOT.members }, 'shared-channel'],
      ['pending shared', { conversation: { is_pending_ext_shared: true }, members: INTERNAL_SNAPSHOT.members }, 'shared-channel'],
      ['org shared', { conversation: { is_shared: true }, members: INTERNAL_SNAPSHOT.members }, 'shared-channel'],
      ['dm', { conversation: { is_im: true }, members: [{ id: 'U0TEAMHUMAN', team_id: 'T0WORKSPACE' }] }, 'direct-message'],
      ['mpim', { conversation: { is_mpim: true }, members: [{ id: 'U0TEAMHUMAN', team_id: 'T0WORKSPACE' }] }, 'direct-message'],
      ['other workspace context', { conversation: { context_team_id: 'T0OTHER' }, members: INTERNAL_SNAPSHOT.members }, 'wrong-workspace'],
      ['foreign member', { conversation: {}, members: [{ id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true }, { id: 'U0EXTERNAL', team_id: 'T0OTHER' }] }, 'external-member'],
      ['guest member', { conversation: {}, members: [{ id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true }, { id: 'U0GUEST', team_id: 'T0WORKSPACE', is_ultra_restricted: true }] }, 'guest-member'],
      ['stranger member', { conversation: {}, members: [{ id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true }, { id: 'U0CONNECT', team_id: 'T0WORKSPACE', is_stranger: true }] }, 'external-member'],
      ['deleted member', { conversation: {}, members: [{ id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true }, { id: 'U0GONE', team_id: 'T0WORKSPACE', deleted: true }] }, 'deleted-member'],
      ['unknown bot', { conversation: {}, members: [{ id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true }, { id: 'B0UNKNOWN', team_id: 'T0WORKSPACE', is_bot: true }] }, 'unknown-bot'],
      ['unlisted human', { conversation: {}, members: [{ id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true }, { id: 'U0COWORKER', team_id: 'T0WORKSPACE' }] }, 'member-not-allowlisted'],
      ['no binding', { conversation: {}, members: [{ id: 'U0BRIDGEBOT', team_id: 'T0WORKSPACE', is_bot: true }, { id: 'U0TEAMHUMAN' }] }, 'unproved-member'],
      ['snapshot of another channel', { conversation: { id: 'C0OTHER' }, members: INTERNAL_SNAPSHOT.members }, 'mismatched-channel'],
    ];
    for (const [name, snapshot, reason] of cases) {
      const result = evaluateSlackAudience(CONFIG, TEAM, 'C0AGENTNET', snapshot);
      expect(result.status, name).toBe('refused');
      expect(result.reason, name).toBe(reason);
    }
    expect(evaluateSlackAudience(CONFIG, TEAM, 'C0AGENTNET', { conversation: {}, members: [] })).toMatchObject({ status: 'uncertain', reason: 'empty-membership' });
    const big = { conversation: {}, members: Array.from({ length: SLACK_MEMBER_CAP + 1 }, (_v, i) => ({ id: `U0PAD${i}`, team_id: 'T0WORKSPACE' })) };
    expect(evaluateSlackAudience(CONFIG, TEAM, 'C0AGENTNET', big)).toMatchObject({ status: 'uncertain', reason: 'membership-incomplete' });
  });
});

describe('slackOutboundPlan', () => {
  const note = (overrides: Record<string, unknown> = {}): BusEnvelope => ({
    id: 'n1', from: 'agent-x', to: 'leaders', priority: 'P2', ttl: 60_000,
    body: { kind: 'note', text: 'hello team' }, ...overrides,
  });

  it('plans a channel post for a mapped topic', () => {
    const decided = slackOutboundPlan(note(), CONFIG);
    expect(decided).toEqual({ ok: true, plan: { channel: 'C0AGENTNET', text: 'hello team', broadcast: false, topic: 'leaders' } });
  });

  it('maps slack thread refs to thread_ts and refuses foreign refs', () => {
    const threaded = slackOutboundPlan(note({ body: { kind: 'note', text: 're', thread: 'slack:T0WORKSPACE:C0AGENTNET:1712345678.000050' } }), CONFIG);
    expect(threaded).toMatchObject({ ok: true, plan: { channel: 'C0AGENTNET', threadTs: '1712345678.000050' } });
    expect(slackOutboundPlan(note({ body: { kind: 'note', text: 're', thread: 'slack:T0WORKSPACE:C0OTHER:1712345678.000050' } }), CONFIG)).toEqual({ ok: false, reason: 'foreign-thread-ref' });
    const alien = slackOutboundPlan(note({ body: { kind: 'note', text: 're', thread: 'incident-42' } }), CONFIG);
    expect(alien.ok).toBe(true);
    if (alien.ok) expect(alien.plan.threadTs).toBeUndefined();
  });

  it('refuses loops, external envelopes and unmappable content', () => {
    expect(slackOutboundPlan(note({ origin_bridge: 'slack' }), CONFIG)).toEqual({ ok: false, reason: 'own-bridge' });
    expect(slackOutboundPlan(note({ external: true }), CONFIG)).toEqual({ ok: false, reason: 'external-envelope' });
    expect(slackOutboundPlan(note({ to: 'other' }), CONFIG)).toEqual({ ok: false, reason: 'unmapped-topic' });
    expect(slackOutboundPlan(note({ body: { kind: 'work.post', jobId: 'j', title: 't', repo: 'a/b', claimKeys: [] } }), CONFIG)).toEqual({ ok: false, reason: 'unsupported-body-kind' });
    expect(slackOutboundPlan(note({ body: { kind: 'note', text: 'xoxb-FAKE-EXAMPLE-1234567890abcdef' } }), CONFIG)).toEqual({ ok: false, reason: 'secret-shaped-text' });
    expect(slackOutboundPlan(note({ body: { kind: 'note', text: '   ' } }), CONFIG)).toEqual({ ok: false, reason: 'empty-text' });
  });

  it('composes a send decision only after a proved audience', () => {
    const postable = evaluateSlackAudience(CONFIG, TEAM, 'C0AGENTNET', INTERNAL_SNAPSHOT);
    expect(postable.status).toBe('postable');
    const decision = slackSendDecision({
      recipients: slackAudienceRecipients(CONFIG, INTERNAL_SNAPSHOT),
      teamIdentities: TEAM, external: postable.external, confirmedByMason: false,
    });
    expect(decision.status).toBe('drafted');
    expect(slackSendDecision({
      recipients: slackAudienceRecipients(CONFIG, INTERNAL_SNAPSHOT),
      teamIdentities: TEAM, external: false, confirmedByMason: true,
    }).status).toBe('sent');
  });
});

describe('slackBackoffMs', () => {
  it('honors Retry-After up to its cap and jitters otherwise', () => {
    expect(slackBackoffMs({ attempt: 0, retryAfterSeconds: 5, random: () => 0 })).toBe(5000);
    expect(slackBackoffMs({ attempt: 0, retryAfterSeconds: 9999, random: () => 0 })).toBe(300_000);
    const jittered = slackBackoffMs({ attempt: 0, retryAfterSeconds: 5, random: () => 0.999 });
    expect(jittered).toBeGreaterThanOrEqual(5000);
    expect(jittered).toBeLessThan(5250);
    for (const [attempt, ceiling] of [[0, 1000], [1, 2000], [3, 8000], [10, SLACK_BACKOFF_CAP_MS]] as const) {
      const delay = slackBackoffMs({ attempt, random: () => 1 - Number.EPSILON });
      expect(delay).toBeLessThanOrEqual(ceiling);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
    expect(slackRetriesExhausted(SLACK_BACKOFF_MAX_ATTEMPTS - 1)).toBe(false);
    expect(slackRetriesExhausted(SLACK_BACKOFF_MAX_ATTEMPTS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

describe('slack journal', () => {
  it('appends bounded metadata records and reads newest first', () => {
    const runsDir = join(root(), 'runs');
    recordSlackObservation({ at: '2026-11-05T11:00:00Z', decision: 'ignored', reason: 'untrusted-sender', channelId: 'C0AGENTNET' }, { runsDir });
    recordSlackObservation({ at: '2026-11-05T11:01:00Z', decision: 'ingested', bus: 'posted', authorId: 'U0TEAMHUMAN' }, { runsDir });
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries.map((e) => e.at)).toEqual(['2026-11-05T11:01:00Z', '2026-11-05T11:00:00Z']);
    expect(readFileSync(slackJournalPath(runsDir), 'utf8')).not.toContain('ship it');
  });

  it('reports missing and survives garbage lines as degraded', () => {
    const runsDir = join(root(), 'runs');
    expect(readSlackJournal({ runsDir }).state).toBe('missing');
    const path = slackJournalPath(runsDir);
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    writeFileSync(path, 'not json\n{"at":"2026-11-05T11:00:00Z","decision":"ignored","reason":"x"}\n', { mode: 0o600 });
    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('degraded');
    expect(journal.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// phm channels slack status|map --json
// ---------------------------------------------------------------------------

describe('channels slack CLI', () => {
  it('status reports a missing config without failing', async () => {
    const missing = join(root(), 'agent-network.toml');
    const status = buildSlackBridgeStatus({ configPath: missing, runsDir: join(root(), 'runs'), commsPath: join(root(), 'comms.toml') });
    expect(status.config.state).toBe('missing');
    expect(status.slackSection).toBe('absent');
    expect(status.ready).toBe(false);
    expect(status.next).toContain('agent-network.toml');
  });

  it('status reports the bridge, refs, mappings, identities and journal', async () => {
    const { path } = tomlDir();
    const runsDir = join(root(), 'runs');
    recordSlackObservation({ at: '2026-11-05T11:00:00Z', decision: 'ingested', bus: 'posted' }, { runsDir });
    const status = buildSlackBridgeStatus({ configPath: path, runsDir, commsPath: join(root(), 'comms.toml') });
    expect(status.config.state).toBe('ok');
    expect(status.bridge).toEqual({ id: 'slack', teamId: 'T0WORKSPACE', ownUserId: 'U0BRIDGEBOT', ownBotId: 'B0BRIDGEBOT' });
    expect(status.credentials).toEqual({ custody: 'phantom-secrets', botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN' });
    expect(status.mappings).toEqual([{ topic: 'leaders', channel: 'C0AGENTNET' }]);
    expect(status.teamIdentities).toEqual({ slack: 3, total: 3 });
    expect(status.comms.confirmedByMason).toBe(false);
    expect(status.journal).toMatchObject({ state: 'ok', ingested: 1, ignored: 0, lastAt: '2026-11-05T11:00:00Z' });
    expect(status.ready).toBe(true);
    expect(status.next).toContain('-sec');
  });

  it('map prints the tables, routes a topic and refuses unknown ones', async () => {
    const { path } = tomlDir();
    const report = buildSlackMapReport({ configPath: path, commsPath: join(root(), 'comms.toml'), topic: 'leaders' });
    expect(report.dryRun).toBe(true);
    expect(report.mappings).toEqual([{ topic: 'leaders', channel: 'C0AGENTNET', threadRefExample: 'slack:T0WORKSPACE:C0AGENTNET:<root_ts>' }]);
    expect(report.route).toEqual({ topic: 'leaders', ok: true, channel: 'C0AGENTNET' });
    expect(report.audienceGates.length).toBeGreaterThan(0);
    const refused = buildSlackMapReport({ configPath: path, commsPath: join(root(), 'comms.toml'), topic: 'nowhere' });
    expect(refused.route).toEqual({ topic: 'nowhere', ok: false, reason: 'unmapped-topic' });
  });

  it('map evaluates a snapshot and drafts while comms is unconfirmed', async () => {
    const { path } = tomlDir();
    const report = buildSlackMapReport({
      configPath: path, commsPath: join(root(), 'comms.toml'),
      topic: 'leaders', snapshot: INTERNAL_SNAPSHOT,
    });
    expect(report.audience).toMatchObject({ status: 'postable' });
    expect(report.sendPolicy).toMatchObject({ status: 'drafted' });
    const shared = buildSlackMapReport({
      configPath: path, commsPath: join(root(), 'comms.toml'),
      topic: 'leaders', snapshot: { conversation: { is_ext_shared: true }, members: INTERNAL_SNAPSHOT.members },
    });
    expect(shared.audience).toMatchObject({ status: 'refused', reason: 'shared-channel', external: true });
    expect(shared.sendPolicy).toMatchObject({ status: 'refused' });
  });

  it('dispatches through cmdChannels with usage discipline', async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => { out.push(String(line ?? '')); });
    const errOut: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => { errOut.push(String(line ?? '')); });
    try {
      expect(await cmdChannels(['slack', '--help'])).toBe(0);
      expect(out.join('\n')).toContain('usage: phm channels slack status');
      out.length = 0;
      expect(await cmdChannels(['slack', 'bogus'])).toBe(2);
      expect(await cmdChannels(['slack', 'status', '--bogus'])).toBe(2);
      expect(await cmdChannels(['slack', 'map', '--snapshot'])).toBe(2);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});
