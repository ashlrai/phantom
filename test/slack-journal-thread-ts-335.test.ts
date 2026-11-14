/**
 * RQ-PHX-SLACKJOURNALTS335 -- the Slack observation journal now records the
 * event's `messageTs` (its own Slack `ts`) and `threadTs` (the thread root:
 * `thread_ts` when present, else its own `ts`) so a later stage can bind each
 * inbound request to the same-thread reply that answered it. Metadata only --
 * never text. Fake ids, temp runsDir, fake publish seam; no socket, no Slack
 * API, no credential anywhere.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ingestSlackSocketMessage } from '../src/core/agents/slack-inbound.js';
import { readSlackJournal, recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import type { SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import type { TeamIdentity } from '../src/core/agents/channel-policy.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-journal-ts335-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TEAM: TeamIdentity[] = [{ channel: 'slack', id: 'U0FAKE335' }];

const CONFIG: SlackBridgeConfig = {
  bridgeId: 'slack',
  teamId: 'T0FAKE335',
  ownUserId: 'U0FAKEOWN335',
  ownBotId: 'B0FAKEOWN335',
  botTokenRef: 'phm_SLACK_FAKE335_BOT_TOKEN',
  appTokenRef: 'phm_SLACK_FAKE335_APP_TOKEN',
  map: [{ topic: 'leaders', channel: 'C0FAKE335' }],
};

const NOW = () => new Date('2026-11-14T12:00:00.000Z');

function messageEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message', team: 'T0FAKE335', channel: 'C0FAKE335',
    user: 'U0FAKE335', text: 'FAKE-BODY-MARKER-335', ts: '1700000000.000100', ...overrides,
  };
}

function socketEnvelope(event: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelope_id: 'env-335', type: 'events_api',
    payload: { event_id: 'Ev0FAKE335', event }, ...overrides,
  };
}

function harness(runsDir: string) {
  const published: BusEnvelope[] = [];
  const publish = (env: BusEnvelope) => { published.push(env); return { status: 'posted' as const, id: env.id, cursor: 1 }; };
  return { published, ctx: { config: CONFIG, teamIdentities: TEAM, runsDir, publish, now: NOW } };
}

describe('slack journal messageTs/threadTs (335)', () => {
  it('journals messageTs === threadTs === event.ts for an ingested channel-root message', () => {
    const runsDir = join(root(), 'runs');
    const { ctx } = harness(runsDir);
    const result = ingestSlackSocketMessage(socketEnvelope(messageEvent()), ctx);
    expect(result.decision).toBe('ingested');

    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      decision: 'ingested', bus: 'posted', channelId: 'C0FAKE335', authorId: 'U0FAKE335',
      messageTs: '1700000000.000100', threadTs: '1700000000.000100',
    });
    // The raw row carries the pair as ids -- never the message text.
    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    expect(raw).toContain('"messageTs":"1700000000.000100"');
    expect(raw).toContain('"threadTs":"1700000000.000100"');
    expect(raw).not.toContain('FAKE-BODY-MARKER-335');
  });

  it('journals messageTs = ts and threadTs = thread_ts for an ingested thread reply', () => {
    const runsDir = join(root(), 'runs');
    const { ctx } = harness(runsDir);
    const result = ingestSlackSocketMessage(
      socketEnvelope(messageEvent({ ts: '1700000000.000200', thread_ts: '1700000000.000050' })),
      ctx,
    );
    expect(result.decision).toBe('ingested');

    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries[0]).toMatchObject({
      decision: 'ingested',
      messageTs: '1700000000.000200', threadTs: '1700000000.000050',
    });
  });

  it('journals the ts pair on ignored rows that reached channel validation', () => {
    const runsDir = join(root(), 'runs');
    const { ctx } = harness(runsDir);
    // Passed channel and ts checks; dropped at the team allowlist.
    const refused = ingestSlackSocketMessage(
      socketEnvelope(messageEvent({ user: 'U0FAKE336' })), ctx,
    );
    expect(refused).toMatchObject({ decision: 'ignored', reason: 'untrusted-sender' });

    expect(readSlackJournal({ runsDir }).entries[0]).toMatchObject({
      decision: 'ignored', reason: 'untrusted-sender', channelId: 'C0FAKE335',
      messageTs: '1700000000.000100', threadTs: '1700000000.000100',
    });
  });

  it('keeps the ts pair off ignored rows dropped before channel validation', () => {
    const runsDir = join(root(), 'runs');
    const { ctx } = harness(runsDir);
    // foreign-team is dropped before the channel check even with a well-formed
    // channel + ts on the event.
    const foreign = ingestSlackSocketMessage(
      socketEnvelope(messageEvent({ team: 'T0FAKEOTHER' })), ctx,
    );
    expect(foreign).toMatchObject({ decision: 'ignored', reason: 'foreign-team' });

    const row = readSlackJournal({ runsDir }).entries[0]!;
    expect(row).toMatchObject({ decision: 'ignored', reason: 'foreign-team', channelId: 'C0FAKE335' });
    expect(row).not.toHaveProperty('messageTs');
    expect(row).not.toHaveProperty('threadTs');
  });

  it('never writes a malformed ts value or ts keys to the file', () => {
    const runsDir = join(root(), 'runs');
    const { ctx } = harness(runsDir);
    for (const ts of ['abc', 'x'.repeat(300)]) {
      const result = ingestSlackSocketMessage(socketEnvelope(messageEvent({ ts })), ctx);
      expect(result).toMatchObject({ decision: 'ignored', reason: 'malformed-event' });
    }

    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    expect(raw).not.toContain('messageTs');
    expect(raw).not.toContain('threadTs');
    expect(raw).not.toContain('abc');
    expect(raw).not.toContain('x'.repeat(300));

    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(2);
    for (const row of journal.entries) {
      expect(row).not.toHaveProperty('messageTs');
      expect(row).not.toHaveProperty('threadTs');
    }
  });

  it('keeps a malformed thread_ts value out of the file; the root falls back to the own ts', () => {
    const runsDir = join(root(), 'runs');
    const { ctx } = harness(runsDir);
    // slackEventToBus refuses a present-but-malformed thread_ts, so this lands
    // as an ignored row that did reach channel validation.
    const result = ingestSlackSocketMessage(
      socketEnvelope(messageEvent({ ts: '1700000000.000300', thread_ts: 'abc' })), ctx,
    );
    expect(result).toMatchObject({ decision: 'ignored', reason: 'malformed-event' });

    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    expect(raw).not.toContain('abc');
    expect(readSlackJournal({ runsDir }).entries[0]).toMatchObject({
      decision: 'ignored', reason: 'malformed-event',
      messageTs: '1700000000.000300', threadTs: '1700000000.000300',
    });
  });

  it('reads rows written before this change (no ts fields) as ok with the fields absent', () => {
    const runsDir = join(root(), 'runs');
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    const legacy = JSON.stringify({
      at: '2026-11-13T09:00:00.000Z', envelopeId: 'env-old', eventId: 'Ev0OLD',
      channelId: 'C0FAKE335', authorId: 'U0FAKE335', decision: 'ingested', bus: 'posted',
    });
    writeFileSync(slackJournalPath(runsDir), `${legacy}\n`, { mode: 0o600 });

    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(1);
    const row = journal.entries[0]!;
    expect(row).toMatchObject({ decision: 'ingested', bus: 'posted', channelId: 'C0FAKE335' });
    expect(row).not.toHaveProperty('messageTs');
    expect(row).not.toHaveProperty('threadTs');
  });

  it('writes no message text, display name or token -- metadata only', () => {
    const runsDir = join(root(), 'runs');
    const { ctx } = harness(runsDir);
    // A stray display-name/token field on the event is whitelist-dropped; the
    // text marker is ingested (a normal note) yet never journaled.
    const result = ingestSlackSocketMessage(socketEnvelope(messageEvent({
      text: 'FAKE-BODY-MARKER-335',
      username: 'FAKE-DISPLAY-NAME-335',
      real_name: 'FAKE-REAL-NAME-335',
      bot_access_token: 'xoxb-FAKE-TOKEN-335',
    })), ctx);
    expect(result.decision).toBe('ingested');

    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    for (const banned of ['FAKE-BODY-MARKER-335', 'FAKE-DISPLAY-NAME-335', 'FAKE-REAL-NAME-335', 'xoxb-FAKE-TOKEN-335']) {
      expect(raw).not.toContain(banned);
    }
  });

  it('recordSlackObservation keeps the ts pair only when isSlackTs passes', () => {
    const runsDir = join(root(), 'runs');
    recordSlackObservation({
      at: '2026-11-14T12:00:00.000Z', decision: 'ingested', bus: 'posted',
      channelId: 'C0FAKE335', authorId: 'U0FAKE335',
      messageTs: '1700000000.000400', threadTs: '1700000000.000050',
    }, { runsDir });
    recordSlackObservation({
      at: '2026-11-14T12:00:01.000Z', decision: 'ignored', reason: 'untrusted-sender',
      channelId: 'C0FAKE335', messageTs: 'not-a-ts', threadTs: 'x'.repeat(300),
    }, { runsDir });

    const journal = readSlackJournal({ runsDir });
    expect(journal.state).toBe('ok');
    expect(journal.entries).toHaveLength(2);
    expect(journal.entries[0]).toMatchObject({ decision: 'ignored', reason: 'untrusted-sender' });
    expect(journal.entries[0]).not.toHaveProperty('messageTs');
    expect(journal.entries[0]).not.toHaveProperty('threadTs');
    expect(journal.entries[1]).toMatchObject({
      decision: 'ingested', messageTs: '1700000000.000400', threadTs: '1700000000.000050',
    });
    const raw = readFileSync(slackJournalPath(runsDir), 'utf8');
    expect(raw).not.toContain('not-a-ts');
    expect(raw).not.toContain('x'.repeat(300));
  });
});
