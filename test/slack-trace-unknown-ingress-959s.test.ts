import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey, storeRow } from './helpers/slack-causal.js';

const channel = 'C0FAKE0959';
const thread = '1731000000.000100';
const message = '1731000010.000100';
const reply = '1731000050.000100';
const at = new Date(1731000010000).toISOString();
const now = () => new Date(1731000100000);
const requestId = fakeRequestId('unknown-ingress-959s');
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(bus?: 'posted' | 'duplicate' | 'failed', send?: 'attempted' | 'sent') {
  const root = mkdtempSync(join(tmpdir(), 'slack-trace-959s-'));
  roots.push(root);
  const deps = { runsDir: join(root, 'runs'), stateRoot: join(root, 'state'), now };
  expect(recordSlackObservation({
    at, decision: 'ingested', channelId: channel, threadTs: thread, messageTs: message,
    authorId: 'U0FAKE0959', requestId, ...(bus ? { bus } : {}),
  }, deps)).toBe('recorded');
  mkdirSync(deps.stateRoot, { recursive: true });
  const messages = send ? { [replyKey(requestId)]: storeRow({
    channel, thread, state: send, ...(send === 'sent' ? { ts: reply } : {}),
  }) } : {};
  const store = join(deps.stateRoot, 'messages.json');
  writeFileSync(store, JSON.stringify({ version: 1, messages }));
  return { deps, paths: [slackJournalPath(deps.runsDir), store] };
}

describe('Slack trace unknown ingress', () => {
  it.each([undefined, 'attempted', 'sent'] as const)(
    'reports uncertainty with %s send evidence without modifying stores', (send) => {
      const { deps, paths } = fixture(undefined, send);
      const before = paths.map((path) => readFileSync(path));
      const trace = readSlackRequestTrace(deps);
      expect(trace.rows).toHaveLength(1);
      expect(trace.rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'uncertain' });
      expect(trace.rows[0]).not.toHaveProperty('replyTs');
      expect(trace.counts).toEqual({ total: 1, answered: 0, uncertain: 1, busFailed: 0, unanswered: 0 });
      expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
      const output = JSON.stringify(trace);
      for (const privateValue of [requestId, 'U0FAKE0959', deps.runsDir, deps.stateRoot]) {
        expect(output).not.toContain(privateValue);
      }
      expect(paths.map((path) => readFileSync(path))).toEqual(before);
    },
  );

  it.each(['posted', 'duplicate'] as const)('keeps %s without a send unanswered', (bus) => {
    expect(readSlackRequestTrace(fixture(bus).deps).rows[0]).toMatchObject({ ingress: bus, outcome: 'unanswered' });
  });

  it('preserves failed ingress precedence even with a sent receipt', () => {
    expect(readSlackRequestTrace(fixture('failed', 'sent').deps).rows[0]).toMatchObject({ ingress: 'failed', outcome: 'bus-failed' });
  });

  it('accepts a posted request with a same-thread sent receipt', () => {
    expect(readSlackRequestTrace(fixture('posted', 'sent').deps).rows[0]).toMatchObject({ ingress: 'posted', outcome: 'answered', replyTs: reply });
  });
});
