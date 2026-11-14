/** RQ-PHX-SLACKMCPJOURNAL343S: fleet_slack_replies over real on-disk state; no injected reader, nothing sent. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { recordSlackObservation } from '../src/core/agents/slack-journal.js';
import { buildSlackBridgeStatus } from '../src/core/agents/slack-status.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../src/core/verse/preferences.js';
const CH = 'C0FAKE0343A';
const NOW_MS = Date.parse('2026-11-12T22:29:00Z');
const ts = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;
const [A, B, C] = [ts('2026-11-12T22:20:00Z'), ts('2026-11-12T22:21:00Z'), ts('2026-11-12T22:10:00Z')]; // C: wrong thread, no request
let home = '';
const runsDir = () => join(home, 'runs');
const stateRoot = () => join(home, 'fleet', 'slack-transport');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'slack-mcp-343s-'));
  Object.entries({ ASHLR_HOME: home, ASHLR_RUNS_DIR: runsDir(), HOME: home }).forEach(([k, v]) => vi.stubEnv(k, v));
  vi.useFakeTimers({ now: NOW_MS, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
/** Fresh server and SDK client per read, so the reconnect is part of the proof. */
async function readTool(): Promise<Record<string, unknown>> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}) });
  const client = new Client({ name: 'slack-journal-343s', version: '1.0.0' });
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const result = await client.callTool({ name: 'fleet_slack_replies', arguments: {} });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}
/** Production store shape (version 1, 64-hex keys), written by the private atomic writer. */
function writeReceipts(rows: Array<{ channel: string; state: 'attempted' | 'sent'; thread?: string; ts?: string }>): void {
  ensurePrivateDirectory(stateRoot());
  const messages = Object.fromEntries(rows.map((row, i) => [String(i).padStart(64, '0'),
    { digest: 'a'.repeat(64), clientId: '11111111-1111-1111-1111-111111111111', expiresAt: NOW_MS + 864e5, ...row }]));
  writePrivateFileAtomic(join(stateRoot(), 'messages.json'), JSON.stringify({ version: 1, messages }));
}
it('answers only the request whose thread gets a durable sent receipt, across reconnection', async () => {
  const seen = [['2026-11-12T22:20:00.000Z', A], ['2026-11-12T22:21:00.000Z', B]] as const;
  for (const [at, t] of seen) {
    recordSlackObservation({ at, decision: 'ingested', channelId: CH, messageTs: t, threadTs: t, bus: 'posted' }, { runsDir: runsDir() });
  }
  const [reqA, reqB] = seen.map(([at, t]) => ({ channelId: CH, threadTs: t, messageTs: t, at }));

  // An attempted receipt is intent, never an answer: both requests stay unanswered.
  writeReceipts([{ channel: CH, thread: A, state: 'attempted' }]);
  expect(await readTool()).toEqual({
    asOf: new Date(NOW_MS).toISOString(), state: 'ok', answered: 0, unanswered: 2, oldestUnansweredAt: reqA!.at,
    uncertainSends: 1, rejected: 0, futureDated: 0, unansweredSample: [reqA, reqB],
  });

  // Clock advances: thread A gets a sent reply; a sent reply on thread C reaches no request.
  vi.setSystemTime(NOW_MS + 60_000);
  writeReceipts([
    { channel: CH, thread: A, state: 'sent', ts: ts('2026-11-12T22:26:00Z') },
    { channel: CH, thread: C, state: 'sent', ts: ts('2026-11-12T22:27:00Z') },
  ]);
  const after = await readTool();
  expect(after).toMatchObject({
    asOf: new Date(NOW_MS + 60_000).toISOString(), answered: 1, unanswered: 1, uncertainSends: 0, unansweredSample: [reqB],
  });

  // Same disk state through the in-process status builder: identical replies projection.
  const status = buildSlackBridgeStatus({ runsDir: runsDir(), stateRoot: stateRoot() });
  expect(after).toEqual({ asOf: status.at, ...status.replies });
});
