import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation } from '../src/core/agents/slack-journal.js';
import { buildSlackBridgeStatus } from '../src/core/agents/slack-status.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const channelId = 'C0TESTCHAN1';
const threadTs = '1700000000.000100';
const at = '2023-11-14T22:13:20Z';

function fixture(outcomes: Array<'failed' | 'posted' | undefined>) {
  const root = mkdtempSync(join(tmpdir(), 'slack-status-440s-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const stateRoot = join(root, 'state');
  outcomes.forEach((bus, i) => recordSlackObservation({ at, decision: 'ingested', channelId, threadTs,
    messageTs: i === 0 ? threadTs : '1700000010.000100', ...(bus ? { bus } : {}) }, { runsDir }));
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
    ['0'.repeat(64)]: { digest: 'a'.repeat(64), clientId: '11111111-1111-1111-1111-111111111111',
      expiresAt: 9e12, channel: channelId, thread: threadTs, state: 'sent', ts: '1700000050.000100' },
  } }), { mode: 0o600 });
  return buildSlackBridgeStatus({ runsDir, stateRoot, configPath: join(root, 'config'),
    commsPath: join(root, 'comms'), now: () => new Date('2023-11-15T00:00:00Z') });
}

it('keeps a failed ingress unresolved despite a later sent receipt', () => {
  const status = fixture(['failed']);
  expect(status.journal.ingested).toBe(1);
  expect(status.replies).toMatchObject({ state: 'ok', answered: 0, unanswered: 1, oldestUnansweredAt: at,
    unansweredSample: [{ channelId, threadTs, messageTs: threadTs, at }] });
});

it('reserves the reply for a posted request while retaining the failed request', () => {
  const status = fixture(['failed', 'posted']);
  expect(status.journal.ingested).toBe(2);
  expect(status.replies).toMatchObject({ answered: 1, unanswered: 1,
    unansweredSample: [{ channelId, threadTs, messageTs: threadTs, at }] });
});

it('continues binding legacy rows without a bus outcome', () => {
  expect(fixture([undefined]).replies).toMatchObject({ answered: 1, unanswered: 0 });
});
