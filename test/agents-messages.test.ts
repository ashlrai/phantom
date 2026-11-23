import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENTS_MESSAGES_USAGE, runAgentsMessagesCli } from '../src/cli/agents-messages.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildAgentsMessages, formatAgentsMessagesText, readAgentsMessages, type AgentsMessages } from '../src/core/fleet/agents-messages.js';
import { AGENT_MESSAGES_PATH, createFleetLiveMapApi } from '../src/core/verse/fleet-live-map-api.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), NOW = T0 + 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Said = [at: number, from: string, to: string, body: Record<string, unknown>];
function store(said: Said[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'agents-messages-'));
  roots.push(root);
  said.forEach(([at, from, to, body], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: 'P2', ttl: 86_400_000, body },
    { root, now: () => at }).status).toBe('posted'));
  return root;
}
const read = (root: string, input: { since?: string; before?: string; limit?: string } = {}) => {
  const result = readAgentsMessages(input, { root, now: () => NOW });
  if (!result.ok) throw new Error(result.error);
  return result.result;
};
const chat: Said[] = [[T0, 'leader', 'claude', { text: 'please look at the build', thread: 'build' }],
  [T0 + 1_000, 'claude', 'leader', { text: 'on it?' }], [T0 + 2_000, 'leader', 'claude', { text: 'thanks, next the docs' }]];

describe('phm agents messages', () => {
  it('an empty bus: no messages, no lines, schema and version in stable key order', () => {
    const none = read(store());
    expect(none).toEqual({ schema: 'agents.messages.v1', version: 1, generatedAt: '2026-11-18T12:01:00.000Z', since: '2026-11-18T11:01:00.000Z',
      source: 'missing', messages: [], pairs: [], matched: 0, skipped: 0 });
    expect(Object.keys(none)).toEqual(['schema', 'version', 'generatedAt', 'since', 'source', 'messages', 'pairs', 'matched', 'skipped']);
    expect(formatAgentsMessagesText(none)).toBe('No agent-to-agent messages since 2026-11-18 11:01 UTC.');
  });

  it('two agents exchanging messages: newest first, map node ids, kinds and named threads only', () => {
    const result = read(store(chat));
    expect(result.messages).toEqual([
      { at: '2026-11-18T12:00:02.000Z', from: 'leader', to: 'lane:claude', kind: 'status', summary: 'thanks, next the docs', fromName: 'leader', toName: 'claude' },
      { at: '2026-11-18T12:00:01.000Z', from: 'lane:claude', to: 'leader', kind: 'ask', summary: 'on it?', fromName: 'claude', toName: 'leader' },
      { at: '2026-11-18T12:00:00.000Z', from: 'leader', to: 'lane:claude', kind: 'status', summary: 'please look at the build', threadId: 'build', fromName: 'leader', toName: 'claude' }]);
    expect(Object.keys(result.messages![2]!)).toEqual(['at', 'from', 'to', 'kind', 'summary', 'threadId', 'fromName', 'toName']);
    expect(formatAgentsMessagesText(result).split('\n')[0]).toBe('3 of 3 agent messages since 2026-11-18 11:01 UTC, newest first.');
  });

  it('a message to an agent the map does not draw reads unknown, with its label kept', () => {
    const result = read(store([[T0, 'claude', 'someone', { text: 'hello there' }], [T0 + 1, 'claude', 'RQ-ONE', { text: 'start' }]]));
    expect(result.messages!.map(m => [m.from, m.to, m.toName])).toEqual([['lane:claude', 'job:RQ-ONE', 'RQ-ONE'], ['lane:claude', 'unknown', 'someone']]);
    expect(formatAgentsMessagesText(result)).toContain('lane:claude -> someone (unknown): hello there');
  });

  it('caps each summary at 160 characters on one line', () => {
    const [message] = read(store([[T0, 'leader', 'claude', { text: `${'word '.repeat(60)}\nend` }]])).messages!;
    expect(message!.summary).toHaveLength(160);
    expect(message!.summary.endsWith('…')).toBe(true);
    expect(message!.summary).not.toContain('\n');
  });

  it('--since and --limit narrow the read; bad values are refused', () => {
    const root = store([[T0 - 2 * 3_600_000, 'leader', 'claude', { text: 'old news' }], ...chat]);
    expect(read(root).matched).toBe(3);
    expect(read(root, { since: '3h' }).matched).toBe(4);
    expect(read(root, { since: '30s' }).matched).toBe(0);
    expect(read(root, { limit: '1' })).toMatchObject({ matched: 3, messages: [{ summary: 'thanks, next the docs' }] });
    expect(readAgentsMessages({ since: 'soon' }, { root })).toEqual({ ok: false, error: '--since takes 10m, 2h, 1d, epoch ms or an ISO time.' });
    expect(readAgentsMessages({ before: 'soon' }, { root })).toEqual({ ok: false, error: '--before takes 10m, 2h, 1d, epoch ms or an ISO time.' });
    expect(readAgentsMessages({ limit: '0' }, { root })).toEqual({ ok: false, error: '--limit takes 1..1024.' });
  });

  it('--before keeps only messages received strictly before its cutoff, composing with --since into one [since, before) window', () => {
    const root = store(chat);
    // before at T0+1500 drops the T0+2000 row; the T0 and T0+1000 rows stay.
    expect(read(root, { before: new Date(T0 + 1_500).toISOString() }).messages!.map(m => m.summary))
      .toEqual(['on it?', 'please look at the build']);
    expect(read(root, { before: new Date(T0 + 1_500).toISOString() }).matched).toBe(2);
    // A message stamped exactly at the cutoff drops — adjacent windows never double-count it.
    expect(read(root, { before: String(T0 + 2_000) }).matched).toBe(2);
    // [since, before): since after T0 keeps only the T0+1000 row inside the window.
    expect(read(root, { since: new Date(T0 + 500).toISOString(), before: new Date(T0 + 1_500).toISOString() }).messages!.map(m => m.summary))
      .toEqual(['on it?']);
    // An inverted window is an honest empty page, not an error.
    expect(read(root, { since: new Date(T0 + 2_000).toISOString(), before: new Date(T0 + 1_000).toISOString() }))
      .toMatchObject({ matched: 0, messages: [], pairs: [] });
    // pairs and matched reflect only the windowed rows.
    const windowed = read(root, { before: new Date(T0 + 1_500).toISOString() });
    expect(windowed.pairs!.map(p => `${p.from}->${p.to}`)).toEqual(['lane:claude->leader', 'leader->lane:claude']);
  });

  it('aggregates edge weights per node pair over the whole window, keeping the last 5 summaries', () => {
    const many: Said[] = Array.from({ length: 7 }, (_, i): Said => [T0 + i * 1_000, 'claude', 'RQ-ONE', { text: `step ${i}` }]);
    // Two labels the map does not draw pool under one unknown line.
    const result = read(store([...chat, ...many, [T0 + 9_000, 'claude', 'someone', { text: 'a' }], [T0 + 9_500, 'claude', 'another', { text: 'b' }]]), { limit: '2' });
    expect(result.messages).toHaveLength(2);
    expect(result.pairs!.map(p => [p.from, p.to, p.count])).toEqual([
      ['lane:claude', 'unknown', 2], ['lane:claude', 'job:RQ-ONE', 7], ['leader', 'lane:claude', 2], ['lane:claude', 'leader', 1]]);
    expect(result.pairs![1]!.recent.map(r => r.summary)).toEqual(['step 6', 'step 5', 'step 4', 'step 3', 'step 2']);
    expect(result.pairs![1]!.lastAt).toBe('2026-11-18T12:00:06.000Z');
  });

  it('a dead-letter notice is a delivery report, not agent mail', () => {
    const result = read(store([
      [T0, 'bus-router', 'bus.dead-letter', { protocol: { version: 1, kind: 'status' }, correlation_id: 'c-1',
        payload: { deadLetter: { id: 'lost', reason: 'exhausted' }, payloadDropped: false, envelope: null } }],
      [T0 + 1_000, 'leader', 'claude', { text: 'hi' }],
    ]));
    expect(result.matched).toBe(1);
    expect(result.messages!.map(m => m.summary)).toEqual(['hi']);
    expect(result.pairs!.map(p => `${p.from}->${p.to}`)).toEqual(['leader->lane:claude']);
  });

  it('an unreadable bus is unknown, not zero', () => {
    const result = buildAgentsMessages({ source: 'unavailable', rows: [], skipped: 2 }, { since: T0 }, NOW);
    expect(result).toMatchObject({ messages: null, pairs: null, matched: null, skipped: 2 });
    expect(formatAgentsMessagesText(result)).toBe('Agent messages: unknown (the agent bus could not be read).');
  });

  it('the CLI prints help, refuses bad usage and exits 0 on a read', async () => {
    const out: string[] = [], err: string[] = [];
    expect(await runAgentsMessagesCli(['--help'], line => out.push(line))).toBe(0);
    expect(out).toEqual([AGENTS_MESSAGES_USAGE]);
    expect(await runAgentsMessagesCli(['--limit'], () => {}, line => err.push(line))).toBe(2);
    expect(await runAgentsMessagesCli(['--since', 'later'], () => {}, line => err.push(line))).toBe(2);
    expect(err.at(-1)).toBe('--since takes 10m, 2h, 1d, epoch ms or an ISO time.');
    expect(await runAgentsMessagesCli(['--before', 'later'], () => {}, line => err.push(line))).toBe(2);
    expect(err.at(-1)).toBe('--before takes 10m, 2h, 1d, epoch ms or an ISO time.');
    expect(await runAgentsMessagesCli(['--before'], () => {}, line => err.push(line))).toBe(2);
    expect(await runAgentsMessagesCli(['--before', '1h', '--before', '2h'], () => {}, line => err.push(line))).toBe(2);
  });

  it('the API serves the same read and refuses unknown params', async () => {
    const root = store(chat);
    const api = createFleetLiveMapApi(async () => { throw new Error('unused'); }, () => null, input => readAgentsMessages(input, { root, now: () => NOW }));
    const call = async (url: string) => {
      let status = 0, body = '';
      const res = { writeHead: (code: number) => { status = code; return res; }, setHeader: () => res, end: (text?: string) => { body = text ?? ''; }, statusCode: 0 };
      const handled = await api({ readSession: { expiresAt: Date.now() + 60_000 } } as never, { url, headers: {} } as never, res as never, AGENT_MESSAGES_PATH, 'GET');
      return { handled, status: status || res.statusCode, body: body ? JSON.parse(body) as AgentsMessages & { error?: string } : null };
    };
    const ok = await call(`${AGENT_MESSAGES_PATH}?since=1h&limit=1`);
    expect(ok).toMatchObject({ handled: true, status: 200, body: { schema: 'agents.messages.v1', version: 1, matched: 3 } });
    expect(ok.body!.messages).toHaveLength(1);
    const windowed = await call(`${AGENT_MESSAGES_PATH}?before=${encodeURIComponent(new Date(T0 + 1_500).toISOString())}`);
    expect(windowed).toMatchObject({ handled: true, status: 200, body: { matched: 2 } });
    expect(windowed.body!.messages!.map(m => m.summary)).toEqual(['on it?', 'please look at the build']);
    expect((await call(`${AGENT_MESSAGES_PATH}?agent=leader`)).status).toBe(400);
    expect((await call(`${AGENT_MESSAGES_PATH}?since=never`)).body!.error).toContain('--since');
    expect((await call(`${AGENT_MESSAGES_PATH}?before=never`)).body!.error).toContain('--before');
    expect((await call(`${AGENT_MESSAGES_PATH}?before=1h&before=2h`)).status).toBe(400);
  });
});
