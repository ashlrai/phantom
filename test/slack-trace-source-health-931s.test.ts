import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const channel = 'C0FAKE0931';
const thread = '1731000000.000100';
const now = new Date('2025-11-07T18:00:00.000Z');
const ids = [0, 1, 2, 3].map(i => fakeRequestId(`931s:${i}`));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slack-source-931s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(stateRoot);
  for (let i = 0; i < ids.length; i++) {
    expect(recordSlackObservation({ at: '2025-11-07T17:00:00.000Z', decision: 'ingested',
      channelId: channel, threadTs: thread, messageTs: `17310000${10 + i}.000100`,
      bus: i === 3 ? 'failed' : 'posted', requestId: ids[i]! }, { runsDir })).toBe('recorded');
  }
  return { runsDir, stateRoot, journal: slackJournalPath(runsDir), store: join(stateRoot, 'messages.json') };
}

function verify(f: ReturnType<typeof fixture>, state: 'ok' | 'missing' | 'degraded', outcomes: string[]) {
  const journal = readFileSync(f.journal);
  const store = existsSync(f.store) ? readFileSync(f.store) : null;
  const result = readSlackRequestTrace({ runsDir: f.runsDir, stateRoot: f.stateRoot, now: () => now });
  expect(result.sources).toEqual({ journal: 'ok', sends: state });
  expect(result.asOf).toBe(now.toISOString());
  expect(result.rows.map(row => row.outcome)).toEqual(outcomes);
  expect(result.counts).toEqual({ total: 4, answered: outcomes.filter(x => x === 'answered').length,
    uncertain: outcomes.filter(x => x === 'uncertain').length, busFailed: 1,
    unanswered: outcomes.filter(x => x === 'unanswered').length });
  expect(readFileSync(f.journal)).toEqual(journal);
  expect(existsSync(f.store) ? readFileSync(f.store) : null).toEqual(store);
  const output = JSON.stringify(result);
  for (const id of ids) expect(output).not.toContain(id);
  expect(output).not.toContain(f.stateRoot);
}

it.each([
  ['missing', null, 'missing'],
  ['invalid JSON', '{invalid', 'degraded'],
  ['truncated JSON', '{"version":1,"messages":', 'degraded'],
  ['oversized', ' '.repeat(1024 * 1024 + 1), 'degraded'],
  ['healthy empty', '{"version":1,"messages":{}}', 'ok'],
] as const)('handles %s send evidence without changing the files', (_name, body, state) => {
  const f = fixture();
  if (body !== null) writeFileSync(f.store, body);
  const outcome = state === 'ok' ? 'unanswered' : 'uncertain';
  verify(f, state, [outcome, outcome, outcome, 'bus-failed']);
});

it('keeps validated sent and attempted evidence when another store row is damaged', () => {
  const f = fixture();
  writeFileSync(f.store, JSON.stringify({ version: 1, messages: {
    [replyKey(ids[0]!)]: { channel, thread, state: 'sent', ts: '1731000050.000100' },
    [replyKey(ids[1]!)]: { channel, thread, state: 'attempted' },
    ['f'.repeat(64)]: { channel: 'invalid', state: 'sent' },
  } }));
  verify(f, 'degraded', ['answered', 'uncertain', 'uncertain', 'bus-failed']);
});
