/**
 * RQ-PHX-SLACKIGNOREDREASONS337: `phm channels slack status` must say WHY
 * observed events were ignored, not just `ignored=N` -- the journal already
 * stores a static reason code per ignored row, so an all-ignored bridge is a
 * named blocker instead of "Slack is not responding". The status surface
 * buckets ignored rows by code ('unspecified' when the row has none,
 * 'invalid-reason' for a stored string that is not a bounded code -- it is
 * never echoed back), orders count desc then reason asc, caps the table at 8
 * rows and reports the omitted distinct-reason count; a ready bridge that
 * ignored everything names the top reason in `next`.
 * Fake ids only; no sockets, credentials or message text.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation } from '../src/core/agents/slack-journal.js';
import { buildSlackBridgeStatus } from '../src/core/agents/slack-status.js';

const CH = 'C0FAKE0003';
const USER = 'U0FAKE0003';
const TS = '1700000000.000300';
const NOW = new Date('2026-11-14T00:00:00Z');

const READY_TOML = `[team]
identities = [
  { channel = "slack", id = "U0FAKE0003" },
]

[slack]
team_id = "T0FAKE0003"
own_user_id = "U0FAKE0004"
own_bot_id = "B0FAKE0004"
bot_token_ref = "phm_SLACK_AGENTNET_BOT_TOKEN"
app_token_ref = "phm_SLACK_AGENTNET_APP_TOKEN"

[[slack.map]]
topic = "leaders"
channel = "C0FAKE0004"
`;

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slack-ignored-337-'));
  roots.push(dir);
  return { runsDir: join(dir, 'runs'), stateRoot: join(dir, 'state'), configPath: join(dir, 'agent-network.toml'), commsPath: join(dir, 'comms.toml') };
}

function ignored(runsDir: string, at: string, reason?: string): void {
  recordSlackObservation(
    { at, decision: 'ignored', channelId: CH, authorId: USER, messageTs: TS, threadTs: TS, ...(reason === undefined ? {} : { reason }) },
    { runsDir },
  );
}

const status = (p: ReturnType<typeof setup>) => buildSlackBridgeStatus({ ...p, now: () => NOW });

describe('slack status ignored reasons (337)', () => {
  it('buckets ignored events by reason code with the newest at per bucket', () => {
    const p = setup();
    ignored(p.runsDir, '2026-11-14T01:00:00Z', 'author-not-allowlisted');
    ignored(p.runsDir, '2026-11-14T01:01:00Z', 'channel-unmapped');
    ignored(p.runsDir, '2026-11-14T01:02:00Z', 'author-not-allowlisted');
    ignored(p.runsDir, '2026-11-14T01:03:00Z');
    ignored(p.runsDir, '2026-11-14T01:04:00Z', 'Bad Reason!');
    ignored(p.runsDir, '2026-11-14T01:05:00Z', 'author-not-allowlisted');
    const s = status(p);
    expect(s.journal.ignoredReasons).toEqual([
      { reason: 'author-not-allowlisted', count: 3, lastAt: '2026-11-14T01:05:00Z' },
      { reason: 'channel-unmapped', count: 1, lastAt: '2026-11-14T01:01:00Z' },
      { reason: 'invalid-reason', count: 1, lastAt: '2026-11-14T01:04:00Z' },
      { reason: 'unspecified', count: 1, lastAt: '2026-11-14T01:03:00Z' },
    ]);
    expect(s.journal.ignoredReasonsOmitted).toBe(0);
    // The malformed stored reason is reported as a code, never echoed.
    expect(JSON.stringify(s.journal)).not.toContain('Bad Reason!');
    // The additive table leaves every existing journal and replies field intact.
    expect(s.journal.state).toBe('ok');
    expect(s.journal.ingested).toBe(0);
    expect(s.journal.ignored).toBe(6);
    expect(s.journal.lastAt).toBe('2026-11-14T01:05:00Z');
    expect(s.replies).toMatchObject({ state: 'ok', answered: 0, unanswered: 0, oldestUnansweredAt: null, uncertainSends: 0, rejected: 0, futureDated: 0 });
    expect(s.replies.unansweredSample).toEqual([]);
  });

  it('caps the table at 8 rows and counts the omitted distinct reasons', () => {
    const p = setup();
    // Ten buckets: nine at count 2 and one at count 1. Count-desc ordering keeps
    // eight of the tied pairs; the omitted count is distinct reasons (2), not
    // the 3 ignored events those reasons represent.
    for (const name of ['reason-a', 'reason-b', 'reason-c', 'reason-d', 'reason-e', 'reason-f', 'reason-g', 'reason-h', 'reason-i']) {
      ignored(p.runsDir, '2026-11-14T02:00:00Z', name);
      ignored(p.runsDir, '2026-11-14T02:30:00Z', name);
    }
    ignored(p.runsDir, '2026-11-14T02:45:00Z', 'reason-zz');
    const s = status(p);
    expect(s.journal.ignored).toBe(19);
    expect(s.journal.ignoredReasons).toHaveLength(8);
    expect(s.journal.ignoredReasons).toEqual(
      ['reason-a', 'reason-b', 'reason-c', 'reason-d', 'reason-e', 'reason-f', 'reason-g', 'reason-h']
        .map((reason) => ({ reason, count: 2, lastAt: '2026-11-14T02:30:00Z' })),
    );
    expect(s.journal.ignoredReasonsOmitted).toBe(2);
  });

  it('names the top ignored reason in next when a ready bridge ignored everything', () => {
    const p = setup();
    writeFileSync(p.configPath, READY_TOML, { mode: 0o600 });
    ignored(p.runsDir, '2026-11-14T03:00:00Z', 'author-not-allowlisted');
    ignored(p.runsDir, '2026-11-14T03:01:00Z', 'channel-unmapped');
    ignored(p.runsDir, '2026-11-14T03:02:00Z', 'author-not-allowlisted');
    const s = status(p);
    expect(s.ready).toBe(true);
    expect(s.journal.ingested).toBe(0);
    expect(s.next).toBe('ready, but every observed event was ignored (top reason: author-not-allowlisted); fix that before expecting replies');
  });

  it('keeps the probe next step while any event was ingested', () => {
    const p = setup();
    writeFileSync(p.configPath, READY_TOML, { mode: 0o600 });
    recordSlackObservation({ at: '2026-11-14T04:00:00Z', decision: 'ingested', channelId: CH, authorId: USER, messageTs: TS, threadTs: TS }, { runsDir: p.runsDir });
    ignored(p.runsDir, '2026-11-14T04:01:00Z', 'author-not-allowlisted');
    const s = status(p);
    expect(s.journal.ingested).toBe(1);
    expect(s.journal.ignoredReasons).toEqual([{ reason: 'author-not-allowlisted', count: 1, lastAt: '2026-11-14T04:01:00Z' }]);
    expect(s.next).toBe('mapping is ready; run phm channels slack probe --json for authenticated identity, then phm channels slack run --seconds 60 --json');
  });

  it('reports an empty table when the journal is absent and never buckets ingested rows', () => {
    const p = setup();
    expect(status(p).journal).toEqual({ state: 'missing', ingested: 0, ignored: 0, lastAt: null, ignoredReasons: [], ignoredReasonsOmitted: 0 });
    // A stray reason field on an ingested row is never an ignore cause.
    recordSlackObservation({ at: '2026-11-14T05:00:00Z', decision: 'ingested', reason: 'stale-reason-field', channelId: CH, authorId: USER, messageTs: TS, threadTs: TS }, { runsDir: p.runsDir });
    const s = status(p);
    expect(s.journal.ingested).toBe(1);
    expect(s.journal.ignoredReasons).toEqual([]);
    expect(s.journal.ignoredReasonsOmitted).toBe(0);
  });
});
