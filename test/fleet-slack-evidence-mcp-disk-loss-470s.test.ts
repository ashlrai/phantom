import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetSlackEvidence } from '../src/mcp/fleet-slack-evidence.js';

const thread = '1731000000.000100';
const channelId = 'C0FAKE0001';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
const messageTs = '1731000010.000100';
const sibling = '1731000020.000100';
const privateSentinel = 'private-fixture-sentinel';
const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fleet_slack_evidence real disk loss over MCP', () => {
  it.each(['journal', 'sends', 'both'] as const)('re-reads after %s failure and recovers in the same session', async (failure) => {
    const root = mkdtempSync(join(tmpdir(), 'slack-mcp-disk-loss-'));
    roots.push(root);
    const runsDir = join(root, 'runs');
    const stateRoot = join(root, 'state');
    const journal = join(runsDir, 'slack-bridge', 'journal.jsonl');
    const sends = join(stateRoot, 'messages.json');
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true });
    mkdirSync(stateRoot);
    const journalBody = [messageTs, sibling].map((ts, i) => JSON.stringify({
      at: `2024-11-07T12:00:0${i}.000Z`, decision: 'ingested', bus: 'posted',
      channelId, threadTs: thread, messageTs: ts, reason: privateSentinel, requestId: fakeRequestId(`470s:${ts}`),
    })).join('\n') + '\n';
    const sendsBody = JSON.stringify({ version: 1, messages: {
      [replyKey(fakeRequestId(`470s:${messageTs}`))]: { channel: channelId, thread, state: 'sent', ts: '1731002390.000100', clientId: privateSentinel },
    } });
    const restore = (path: string, body: string) => {
      rmSync(path, { recursive: true, force: true });
      writeFileSync(path, body, { mode: 0o600 });
    };
    restore(journal, journalBody);
    restore(sends, sendsBody);
    let clock = '2024-11-07T18:00:00.000Z';
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
      slackEvidence: input => readFleetSlackEvidence(input, { runsDir, stateRoot, now: () => new Date(clock) }) });
    const client = new Client({ name: 'disk-loss-test', version: '1.0.0' });
    clients.push(client);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async () => {
      const result = await client.callTool({ name: 'fleet_slack_evidence',
        arguments: { thread, channelId, messageTs, maxAgeSeconds: 60 } });
      expect(result.isError).not.toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(root);
      expect(serialized).not.toContain(privateSentinel);
      expect(serialized).not.toMatch(/EISDIR|ENOENT|unreadable Slack journal/);
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    };
    const healthy = await call();
    expect(healthy).toMatchObject({ thread, collectionScope: { thread, channelId },
      selection: { channelId, messageTs }, asOf: clock, sources: { journal: 'ok', sends: 'ok' },
      counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 } });
    expect(healthy.rows).toHaveLength(1);
    expect(healthy.rows[0]).toMatchObject({ channelId, threadTs: thread, messageTs, outcome: 'answered' });

    for (const path of [failure !== 'sends' && journal, failure !== 'journal' && sends]) {
      if (path) { rmSync(path); mkdirSync(path); }
    }
    clock = '2024-11-07T18:01:00.000Z';
    const degraded = await call();
    expect(degraded).toMatchObject({ thread, collectionScope: { thread, channelId },
      selection: { channelId, messageTs }, asOf: clock,
      sources: { journal: failure === 'sends' ? 'ok' : 'degraded', sends: failure === 'journal' ? 'ok' : 'missing' } });
    expect(degraded.scope).toContain('does not prove current runtime reachability, durable task ownership, or execution');
    expect(degraded.counts.answered).toBe(0);
    expect(degraded.rows.every((row: { messageTs: string; outcome: string; replyTs?: string }) =>
      row.messageTs === messageTs && row.outcome !== 'answered' && row.replyTs === undefined)).toBe(true);
    if (failure === 'sends') {
      // A missing send source leaves the readable ingress as unanswered, not proof of no reply.
      expect(degraded.rows).toHaveLength(1);
      expect(degraded.rows[0]).toMatchObject({ channelId, threadTs: thread, messageTs, outcome: 'unanswered' });
      expect(degraded.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
      expect(degraded.freshness.verdict).toBe('stale');
    } else {
      expect(degraded.rows).toEqual([]);
      expect(degraded.counts).toEqual({ total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 });
      expect(degraded.freshness.verdict).toBe('unknown');
    }
    restore(journal, journalBody);
    restore(sends, sendsBody);
    clock = '2024-11-07T18:02:00.000Z';
    const recovered = await call();
    expect(recovered).toMatchObject({ asOf: clock, selection: { channelId, messageTs },
      sources: { journal: 'ok', sends: 'ok' }, counts: healthy.counts, rows: healthy.rows });
  });
});
