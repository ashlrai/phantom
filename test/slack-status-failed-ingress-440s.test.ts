import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { recordSlackObservation } from '../src/core/agents/slack-journal.js';
import { buildSlackBridgeStatus } from '../src/core/agents/slack-status.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const channelId = 'C0TESTCHAN1';
const threadTs = '1700000000.000100';
const at = '2023-11-14T22:13:20Z';

const ridFor = (i: number) => fakeRequestId(`440s:${i}`);
function fixture(outcomes: Array<'failed' | 'posted' | undefined>, keyed = true) {
  const root = mkdtempSync(join(tmpdir(), 'slack-status-440s-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const stateRoot = join(root, 'state');
  outcomes.forEach((bus, i) => recordSlackObservation({ at, decision: 'ingested', channelId, threadTs,
    messageTs: i === 0 ? threadTs : '1700000010.000100', ...(keyed ? { requestId: ridFor(i) } : {}), ...(bus ? { bus } : {}) }, { runsDir }));
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
    [replyKey(ridFor(outcomes.length - 1))]: { digest: 'a'.repeat(64), clientId: '11111111-1111-1111-1111-111111111111',
      expiresAt: 9e12, channel: channelId, thread: threadTs, state: 'sent', ts: '1700000050.000100' },
  } }), { mode: 0o600 });
  return buildSlackBridgeStatus({ runsDir, stateRoot, configPath: join(root, 'config'),
    commsPath: join(root, 'comms'), now: () => new Date('2023-11-15T00:00:00Z') });
}

it('keeps a failed ingress unresolved despite a later sent receipt', () => {
  const status = fixture(['failed']);
  expect(status.journal.ingested).toBe(1);
  // A failed ingress is its own class: not ordinary-unanswered, never answered, never dropped.
  expect(status.replies).toMatchObject({ state: 'ok', answered: 0, unanswered: 0, busFailed: 1, oldestUnansweredAt: null,
    unansweredSample: [], busFailedSample: [{ channelId, threadTs, messageTs: threadTs, at }] });
});

it('reserves the reply for a posted request while retaining the failed request', () => {
  const status = fixture(['failed', 'posted']);
  expect(status.journal.ingested).toBe(2);
  expect(status.replies).toMatchObject({ answered: 1, unanswered: 0, busFailed: 1,
    unansweredSample: [], busFailedSample: [{ channelId, threadTs, messageTs: threadTs, at }] });
});

it('a keyed row without a bus outcome is uncertain, never answered (answered needs posted|duplicate ingress)', () => {
  expect(fixture([undefined]).replies).toMatchObject({ answered: 0, unanswered: 0, unverified: 0, uncertainRequests: 1 });
  expect(fixture(['posted']).replies).toMatchObject({ answered: 1, uncertainRequests: 0 });
  expect(fixture(['duplicate']).replies).toMatchObject({ answered: 1, uncertainRequests: 0 });
});

it('reports legacy rows without a requestId as unverified, never answered by a same-thread receipt', () => {
  expect(fixture([undefined], false).replies).toMatchObject({ answered: 0, unanswered: 0, unverified: 1 });
  // A failed unidentified row is counted in BOTH unverified and busFailed (counters overlap by design).
  expect(fixture(['failed'], false).replies).toMatchObject({ unanswered: 0, unverified: 1, busFailed: 1 });
});
