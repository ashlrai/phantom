/**
 * RQ-PHX-RECUTFLEETCLIC474 (supersedes #6248): `phm fleet slack-trace` exit 0
 * requires durable bus ingress per row, the same join fleet slack-evidence
 * enforces. Exercises cmdFleetSlackTrace end to end against on-disk journal
 * and send-store fixtures; plainly synthetic ids only, no Slack access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetSlackTrace } from '../src/cli/fleet-slack-trace.js';
import { recordSlackObservation } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const CHANNEL = 'C0FAKE0474';
const THREAD = '1732000000.000100';
const MESSAGE = '1732000010.000100';
const REPLY = '1732000050.000100';
const AT = new Date(1732000010000).toISOString();
const NOW = new Date(1732000100000);
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function seed(bus?: 'posted' | 'duplicate' | 'failed') {
  const root = mkdtempSync(join(tmpdir(), 'recut-fleetcli-c474-'));
  roots.push(root);
  const deps = { runsDir: join(root, 'runs'), stateRoot: join(root, 'state'), now: () => NOW };
  expect(recordSlackObservation({
    at: AT, decision: 'ingested', channelId: CHANNEL, threadTs: THREAD,
    messageTs: MESSAGE, authorId: 'U0FAKE0474', requestId: fakeRequestId('c474'),
    ...(bus !== undefined ? { bus } : {}),
  }, deps)).toBe('recorded');
  mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(deps.stateRoot, 'messages.json'), JSON.stringify({
    version: 1,
    messages: {
      [replyKey(fakeRequestId('c474'))]: {
        digest: '0'.repeat(64), clientId: '33333333-3333-3333-3333-333333333333', expiresAt: 9e12,
        channel: CHANNEL, thread: THREAD, state: 'sent', ts: REPLY, text: 'synthetic-private-message-c474',
      },
    },
  }), { mode: 0o600 });
  return deps;
}

async function trace(deps: ReturnType<typeof seed>) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetSlackTrace(['--thread', THREAD, '--json'], deps);
  return { code, body: JSON.parse(String(log.mock.calls[0]![0])) };
}

describe('fleet slack-trace durable-ingress gate (recut c474)', () => {
  it('exits 0 when an ingested request has posted bus ingress and a sent reply under its reply key', async () => {
    const { code, body } = await trace(seed('posted'));
    expect(code).toBe(0);
    expect(body.rows[0]).toMatchObject({ ingress: 'posted', outcome: 'answered', replyTs: REPLY });
    expect(body.sources).toEqual({ journal: 'ok', sends: 'ok' });
  });

  it('exits 1 when the request carries reply evidence but no durable bus ingress receipt', async () => {
    const { code, body } = await trace(seed());
    expect(code).toBe(1);
    expect(body.rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'uncertain' });
    expect(body.rows[0].replyTs).toBeUndefined();
  });
});
