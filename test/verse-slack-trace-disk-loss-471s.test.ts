import { Agent, createServer, request } from 'node:http';
import { Duplex } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { createFleetSlackTraceApi } from '../src/core/verse/fleet-slack-trace-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const thread = '1731000000.000100';
const channel = 'C0FAKE0001';
const target = '1731000010.000100';
const sibling = '1731000020.000100';
const sentinel = 'private-fixture-body';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slack-http-471s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true }); mkdirSync(stateRoot);
  const journal = join(runsDir, 'slack-bridge', 'journal.jsonl');
  const sends = join(stateRoot, 'messages.json');
  const row = (messageTs: string, at: string) => JSON.stringify({ at, decision: 'ingested', bus: 'posted',
    channelId: channel, threadTs: thread, messageTs, requestId: fakeRequestId(`471s:${messageTs}`), text: sentinel });
  const journalBody = [row(target, '2024-11-07T12:00:00.000Z'),
    row(sibling, '2024-11-07T17:59:50.000Z')].join('\n') + '\n';
  const sendsBody = JSON.stringify({ version: 1, messages: { [replyKey(fakeRequestId(`471s:${target}`))]: { channel, thread, state: 'sent',
    ts: '1731002390.000100', clientId: sentinel } } });
  const restore = (path: string, body: string) => { rmSync(path, { recursive: true, force: true }); writeFileSync(path, body); };
  const restoreAll = () => { restore(journal, journalBody); restore(sends, sendsBody); };
  restoreAll();
  const now = () => new Date('2024-11-07T18:00:00.000Z');
  const api = createFleetSlackTraceApi(() => readSlackRequestTrace({ runsDir, stateRoot, now }),
    (requested, options) => readSlackEvidenceBundle(requested, { ...options, runsDir, stateRoot, now }));
  const server = createServer((req, res) => { void api({} as VerseApiContext, req, res,
    '/api/verse/fleet/control/slack-trace', req.method ?? 'GET'); });
  // Paired streams exercise Node's HTTP client/server parsers without opening a socket.
  const connection = () => {
    const client = new Duplex({ read() {}, write(chunk, _encoding, done) { peer.push(chunk); done(); },
      final(done) { peer.push(null); done(); } });
    const peer = new Duplex({ read() {}, write(chunk, _encoding, done) { client.push(chunk); done(); },
      final(done) { client.push(null); done(); } });
    server.emit('connection', peer);
    return client;
  };
  const agent = new Agent();
  agent.createConnection = connection;
  const call = async (message?: string) => {
    const params = new URLSearchParams({ thread, channel, maxAgeSeconds: '60' });
    if (message) params.set('message', message);
    const { status, text } = await new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const req = request({ agent, path: `/api/verse/fleet/control/slack-trace?${params}` }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      });
      req.on('error', reject); req.end();
    });
    expect(status).toBe(200);
    for (const forbidden of [root, sentinel, 'EISDIR', 'ENOENT', 'VERIFIED', 'RUNNING', 'ASSIGNED']) expect(text).not.toContain(forbidden);
    return JSON.parse(text);
  };
  return { journal, sends, journalBody, restore, restoreAll, call };
}

it.each(['journal', 'sends', 'both'] as const)('presents %s loss and recovery on the same HTTP handler', async failure => {
  const f = await fixture();
  const healthy = await f.call(target);
  expect(healthy).toMatchObject({ selection: { channelId: channel, messageTs: target },
    sources: { journal: 'ok', sends: 'ok' }, counts: { total: 1, answered: 1 },
    freshness: { verdict: 'stale' }, truncated: false });
  expect(healthy.rows).toHaveLength(1);
  expect(healthy.rows[0]).toMatchObject({ channelId: channel, threadTs: thread, messageTs: target, outcome: 'answered' });
  expect(healthy.scope).toContain('does not prove current runtime reachability, durable task ownership, or execution');
  const absent = await f.call('1731999999.000100');
  expect(absent).toMatchObject({ rows: [], counts: { total: 0, answered: 0 }, freshness: { verdict: 'unknown' },
    sources: { journal: 'ok', sends: 'ok' } });
  for (const path of [failure !== 'sends' && f.journal, failure !== 'journal' && f.sends]) {
    if (path) { rmSync(path); mkdirSync(path); }
  }
  const degraded = await f.call(target);
  expect(degraded.sources).toEqual({ journal: failure === 'sends' ? 'ok' : 'degraded',
    sends: failure === 'journal' ? 'ok' : 'missing' });
  expect(degraded.counts.answered).toBe(0);
  expect(degraded.freshness.verdict).toBe(failure === 'sends' ? 'stale' : 'unknown');
  expect(degraded.rows.every((row: { messageTs: string; outcome: string; replyTs?: string }) =>
    row.messageTs === target && row.outcome !== 'answered' && row.replyTs === undefined)).toBe(true);
  if (failure !== 'sends') expect(degraded.rows).toEqual([]);
  else expect(degraded.rows[0]).toMatchObject({ messageTs: target, outcome: 'unanswered' });
  f.restoreAll();
  const recovered = await f.call(target);
  expect(recovered).toMatchObject({ sources: healthy.sources, counts: healthy.counts, rows: healthy.rows,
    freshness: healthy.freshness });
});

it('distinguishes an empty readable store and applies truncation after exact selection', async () => {
  const f = await fixture();
  f.restore(f.journal, '');
  const empty = await f.call(target);
  expect(empty).toMatchObject({ sources: { journal: 'ok', sends: 'ok' }, rows: [],
    counts: { total: 0, answered: 0 }, freshness: { verdict: 'unknown' }, truncated: false });
  const rows = Array.from({ length: 26 }, (_, i) => JSON.stringify({ at: '2024-11-07T12:00:00.000Z',
    decision: 'ingested', bus: 'posted', channelId: channel, threadTs: thread,
    messageTs: `17310001${String(i).padStart(2, '0')}.000100`, requestId: fakeRequestId(`471s:${i}`) })).join('\n') + '\n';
  f.restore(f.journal, rows);
  const all = await f.call();
  expect(all).toMatchObject({ counts: { total: 26 }, truncated: true });
  expect(all.rows).toHaveLength(20);
  const selected = await f.call('1731000100.000100');
  expect(selected).toMatchObject({ counts: { total: 1 }, truncated: false });
  expect(selected.rows).toHaveLength(1);
  expect(selected.rows[0].messageTs).toBe('1731000100.000100');
});
