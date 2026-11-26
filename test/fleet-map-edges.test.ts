import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdMap } from '../src/cli/map.js';
import { parseAgentMessagesQuery, readAgentMessages, type AgentMessagesQuery } from '../src/core/fleet/agent-messages.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { projectFleetEdges } from '../src/core/fleet/fleet-edges.js';
import { buildMapEdges, formatMapEdgesText, readMapEdges, type MapEdges } from '../src/core/fleet/map-edges.js';
import { createFleetLiveMapApi, MAP_EDGES_PATH } from '../src/core/verse/fleet-live-map-api.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), NOW = T0 + 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
type Said = [at: number, from: string, to: string, body: string | Record<string, unknown>];
function store(messages: Said[] = [], root = mkdtempSync(join(tmpdir(), 'map-edges-'))) {
  roots.push(root);
  messages.forEach(([at, from, to, body], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: 'P2', ttl: 86_400_000,
    body: typeof body === 'string' ? { text: body } : body }, { root, now: () => at }).status).toBe('posted'));
  return root;
}
const read = (root: string, since?: string, before?: string, filters?: AgentMessagesQuery) =>
  readMapEdges(since, { root, now: () => NOW, before, filters })!;
const chat: Parameters<typeof store>[0] = [
  [T0, 'leader', 'claude', 'please look at the build'], [T0 + 1_000, 'claude', 'leader', 'on it'], [T0 + 2_000, 'leader', 'claude', 'thanks, next the docs']];
const fan: Parameters<typeof store>[0] = ['RQ-ONE', 'RQ-TWO', 'RQ-THREE', 'RQ-FOUR', 'RQ-FIVE'].map((job, i) => [T0 + i * 1_000, 'claude', job, `start ${job}`]);
// One of every filterable shape: plain mail, a question, a job citation, a
// threaded channel note and a reply citing m1 — ids are the store's m<index>.
const mixed: Parameters<typeof store>[0] = [
  [T0, 'leader', 'claude', 'please look at the build'],
  [T0 + 1_000, 'claude', 'leader', 'on it?'],
  [T0 + 2_000, 'leader', 'claude', 'thanks, next the docs'],
  [T0 + 3_000, 'claude', 'codex', 'RQ-ONE-1 shipped the patch'],
  [T0 + 4_000, 'codex', 'group:build:general', { kind: 'note', thread: 'build', text: 'build notes here' }],
  [T0 + 5_000, 'claude', 'leader', { text: 'answering you', inReplyTo: 'm1' }],
];
const KEYS = ['schema', 'version', 'generatedAt', 'since', 'source', 'edges', 'agents', 'messages', 'skipped'];

describe('phm map edges', () => {
  it('no messages: an empty list with the stable schema, version and key order', () => {
    const none = read(store()), empty = read(store([[T0 - 3_600_000, 'leader', 'claude', 'old news']]));
    expect(none).toEqual({ schema: 'fleet.map-edges.v1', version: 1, generatedAt: '2026-11-18T12:01:00.000Z', since: '2026-11-18T11:46:00.000Z',
      source: 'missing', edges: [], agents: { leader: [], lane: [], worker: [], unknown: [] }, messages: 0, skipped: 0 });
    expect(Object.keys(none)).toEqual(KEYS);
    expect(empty).toMatchObject({ source: 'available', edges: [], messages: 0 });
    expect(formatMapEdgesText(none)).toBe('0 agent messages on 0 lines since 2026-11-18 11:46 UTC.');
  });

  it('two agents chatting: one edge each way with count, last time and last summary, grouped by org role', () => {
    const root = store(chat), result = read(root);
    expect(result.edges).toEqual([
      { id: 'leader->claude', from: { name: 'leader', role: 'leader', lane: null, node: 'leader' }, to: { name: 'claude', role: 'lane', lane: 'claude', node: 'lane:claude' },
        count: 2, lastAt: '2026-11-18T12:00:02.000Z', lastSummary: 'thanks, next the docs' },
      { id: 'claude->leader', from: { name: 'claude', role: 'lane', lane: 'claude', node: 'lane:claude' }, to: { name: 'leader', role: 'leader', lane: null, node: 'leader' },
        count: 1, lastAt: '2026-11-18T12:00:01.000Z', lastSummary: 'on it' }]);
    expect(result.agents).toEqual({ leader: ['leader'], lane: ['claude'], worker: [], unknown: [] });
    expect(result.messages).toBe(3);
    expect(JSON.stringify(read(root))).toBe(JSON.stringify(result));
    expect(formatMapEdgesText(result).split('\n')).toEqual(['3 agent messages on 2 lines since 2026-11-18 11:46 UTC.',
      '  leader (leader) -> claude (lane): 2, last 12:00:02Z "thanks, next the docs"', '  claude (lane) -> leader (leader): 1, last 12:00:01Z "on it"',
      'By role: leader: leader · lane: claude · worker: none · unknown: none']);
    // --since narrows the window, and the pair read behind the edge click returns that talk only.
    expect(readMapEdges(String(T0 + 1_500), { root, now: () => NOW })!.edges!.map(edge => [edge.id, edge.count])).toEqual([['leader->claude', 1]]);
    expect(readMapEdges('soon', { root })).toBeNull();
    expect(readAgentMessages({ agent: 'claude', with: 'leader', limit: 20 }, { root, now: () => NOW }).matched).toBe(3);
    expect(readAgentMessages({ agent: 'claude', with: 'devin', limit: 20 }, { root, now: () => NOW }).matched).toBe(0);
    expect(parseAgentMessagesQuery({ agent: 'claude', with: 'leader', limit: '20' })).toEqual({ ok: true, query: { agent: 'claude', with: 'leader', limit: 20 } });
    expect(parseAgentMessagesQuery({ with: 'leader' })).toEqual({ ok: false, error: '--with takes the other agent and needs --agent.' });
  });

  it('--before is an exclusive upper bound: the [since, before) window counts each message once', () => {
    const root = store(chat), at = (ms: number) => new Date(ms).toISOString();
    // chat: leader->claude at T0 and T0+2000, claude->leader at T0+1000.
    const bounded = (since: string | undefined, before: string | undefined) => readMapEdges(since, { root, now: () => NOW, before });
    expect(bounded(undefined, at(T0 + 2_000))!.messages).toBe(2);
    expect(bounded(undefined, at(T0 + 2_001))!.messages).toBe(3);
    expect(bounded(at(T0 + 500), at(T0 + 1_500))!.edges!.map(edge => [edge.id, edge.count, edge.lastAt]))
      .toEqual([['claude->leader', 1, '2026-11-18T12:00:01.000Z']]);
    expect(bounded(at(T0 + 2_500), at(T0 + 1_000))!).toMatchObject({ source: 'available', edges: [], messages: 0 });
    expect(bounded(undefined, 'soon')).toBeNull();
  });

  it('one agent fanning out to five: five edges to workers on map job nodes, matching the map line counts', () => {
    const root = store([...fan, [T0 + 9_000, 'claude', 'claude-7', 'x'.repeat(200)], [T0 + 9_500, 'claude', 'mystery', 'who are you'],
      [T0 + 9_600, 'claude', 'claude', 'note to self'], [T0 + 9_700, 'claude', 'leaders', 'broadcast']]);
    const result = read(root), jobs = result.edges!.filter(edge => edge.to.node?.startsWith('job:'));
    expect(jobs.map(edge => [edge.from.node, edge.to.node, edge.to.role, edge.count, edge.lastSummary])).toEqual(
      ['FIVE', 'FOUR', 'THREE', 'TWO', 'ONE'].map(name => ['lane:claude', `job:RQ-${name}`, 'worker', 1, `start RQ-${name}`]));
    expect(result.agents).toEqual({ leader: [], lane: ['claude'], worker: ['RQ-FIVE', 'RQ-FOUR', 'RQ-ONE', 'RQ-THREE', 'RQ-TWO', 'claude-7'], unknown: ['mystery'] });
    const worker = result.edges!.find(edge => edge.to.name === 'claude-7')!;
    expect(worker.to).toEqual({ name: 'claude-7', role: 'worker', lane: 'claude', node: null });
    expect(worker.lastSummary).toBe('x'.repeat(80));
    // Notes to self and broadcasts are not edges, exactly as on the map's own lines.
    expect(result.messages).toBe(7);
    const rows = fan.map(([at, from, to], i) => ({ cursor: i, receivedAt: at, envelope: { id: `m${i}`, from, to, priority: 'P2', ttl: 1, body: null } }));
    expect(projectFleetEdges(rows as never, NOW, 15).map(edge => edge.messages)).toEqual(jobs.map(edge => edge.count));
  });

  it('the shared phm messages filters narrow the matched rows before the edges aggregate', () => {
    const root = store(mixed);
    const unfiltered = read(root);
    expect(unfiltered.messages).toBe(6);
    expect(unfiltered.edges!.map(edge => [edge.id, edge.count])).toEqual([
      ['claude->leader', 2], ['codex->group:build:general', 1], ['claude->codex', 1], ['leader->claude', 2]]);
    const filtered = (filters: AgentMessagesQuery, since?: string, before?: string) => read(root, since, before, filters);
    // --kind keeps one classified kind; --contains is the scrubbed-summary substring search.
    expect(filtered({ kind: 'ask' })).toMatchObject({ messages: 1 });
    expect(filtered({ kind: 'ask' })!.edges).toEqual([expect.objectContaining({ id: 'claude->leader', count: 1, lastSummary: 'on it?' })]);
    expect(filtered({ kind: 'reply' })!.edges).toEqual([expect.objectContaining({ id: 'claude->leader', count: 1, lastSummary: 'answering you' })]);
    expect(filtered({ contains: 'DOCS' })).toMatchObject({ messages: 1 });
    // --from/--to decide on the addressed labels; --agent/--with scope to the pair.
    const senders = filtered({ from: 'claude' });
    expect(senders.messages).toBe(3);
    expect(senders.edges!.map(edge => [edge.id, edge.count])).toEqual([['claude->leader', 2], ['claude->codex', 1]]);
    expect(filtered({ to: 'claude' })).toMatchObject({ messages: 2 });
    // A filtered edge keeps the same count, lastAt and lastSummary an unfiltered
    // read of the same rows reports — the filters narrow the set, never reshape it.
    const pair = filtered({ agent: 'claude', with: 'leader' });
    expect(pair.messages).toBe(4);
    expect(pair.edges).toEqual(unfiltered.edges!.filter(edge => edge.id === 'claude->leader' || edge.id === 'leader->claude'));
    // --job/--thread/--channel/--in-reply-to/--id/--body-kind keep only the rows
    // carrying that citation or discriminator.
    expect(filtered({ job: 'RQ-ONE-1' })).toMatchObject({ messages: 1 });
    expect(filtered({ thread: 'build' })).toMatchObject({ messages: 1 });
    expect(filtered({ channel: 'build' })).toMatchObject({ messages: 1 });
    expect(filtered({ inReplyTo: 'm1' })).toMatchObject({ messages: 1 });
    expect(filtered({ id: 'm3' })).toMatchObject({ messages: 1 });
    expect(filtered({ id: 'm-gone' })).toMatchObject({ messages: 0, edges: [] });
    expect(filtered({ bodyKind: 'note' })).toMatchObject({ messages: 1 });
    expect(filtered({ bodyKind: 'work.post' })).toMatchObject({ messages: 0, edges: [] });
    expect(filtered({ priority: 'P0' })).toMatchObject({ messages: 0 });
    expect(filtered({ priority: 'P2' })).toMatchObject({ messages: 6 });
    // The read's own window still bounds the matched set: since/filters compose
    // into one [since, before) window exactly like the unfiltered read.
    expect(filtered({ from: 'claude' }, String(T0 + 4_500))).toMatchObject({ messages: 1 });
    expect(filtered({ kind: 'status' }, undefined, String(T0 + 2_500))!.messages).toBe(2);
    // An empty filter object is the unfiltered read, byte-identical.
    expect(read(root, undefined, undefined, {})).toEqual(unfiltered);
  });

  it('the --result filter keeps only work.result receipts reporting that outcome', () => {
    const root = store();
    const post = (id: string, at: number, outcome: string) =>
      expect(appendBusInbox({ id, from: 'claude', to: 'leader', priority: 'P2', ttl: 86_400_000,
        body: { kind: 'work.result', jobId: 'RQ-RES1', claimKey: 'job:RQ-RES1',
          queueId: 'peer-work-0123456789abcdef0123456789abcdef',
          receiptId: 'pw-0123456789abcdef0123456789abcdef', outcome } }, { root, now: () => at }).status).toBe('posted');
    post('w1', T0, 'failed');
    post('w2', T0 + 1_000, 'complete');
    const failed = read(root, undefined, undefined, { result: 'failed' });
    expect(failed.messages).toBe(1);
    expect(failed.edges).toEqual([expect.objectContaining({ id: 'claude->leader', count: 1, lastSummary: 'failed' })]);
    expect(read(root, undefined, undefined, { result: 'complete' }).messages).toBe(1);
    expect(read(root, undefined, undefined, { result: 'admitted' })).toMatchObject({ messages: 0, edges: [] });
  });

  it('an unreadable bus is unknown, never zero', () => {
    const unknown = buildMapEdges({ source: 'unavailable', rows: [] }, T0, NOW);
    expect(unknown).toMatchObject({ source: 'unavailable', edges: null, agents: null, messages: null });
    expect(formatMapEdgesText(unknown)).toBe('Agent messages: unknown (the agent bus could not be read).');
  });

  it('the CLI prints the JSON or the text and refuses bad flags', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdMap(['edges', '--json', '--since', '10m'])).toBe(0);
    const printed = JSON.parse(log.mock.calls[0]![0] as string) as MapEdges;
    expect(Object.keys(printed)).toEqual(KEYS);
    expect(printed).toMatchObject({ schema: 'fleet.map-edges.v1', version: 1, source: 'missing', edges: [] });
    expect(Date.parse(printed.generatedAt) - Date.parse(printed.since)).toBe(600_000);
    expect(await cmdMap(['edges'])).toBe(0);
    expect(log.mock.calls[1]![0]).toMatch(/^0 agent messages on 0 lines since /);
    expect(await cmdMap(['edges', '--json', '--before', '1h'])).toBe(0);
    expect(JSON.parse(log.mock.calls[2]![0] as string)).toMatchObject({ schema: 'fleet.map-edges.v1', version: 1, source: 'missing' });
    for (const bad of [['edges', '--since'], ['edges', '--since', 'soon'], ['edges', '--minutes', '0'], ['edges', '--json', '--json'], ['edges', '--before'], ['edges', '--before', 'soon'],
      ['edges', '--kind', 'bogus'], ['edges', '--with', 'claude'], ['edges', '--agent'], ['edges', '--kind', 'ask', '--kind', 'reply']]) expect(await cmdMap(bad)).toBe(2);
    expect(err).toHaveBeenCalledTimes(10);
    expect(await cmdMap(['--help'])).toBe(0);
    expect(log.mock.calls[3]![0]).toContain('phm map edges [--json] [--since <10m|2h|1d|ISO> | --minutes <n>] [--before <10m|2h|1d|ISO|epoch>]');
    // The phm messages filter flags parse through the shared parser and reach the read.
    expect(await cmdMap(['edges', '--json', '--kind', 'ask', '--contains', 'build'])).toBe(0);
    expect(JSON.parse(log.mock.calls[4]![0] as string)).toMatchObject({ schema: 'fleet.map-edges.v1', version: 1, source: 'missing', edges: [] });
  });
});

describe('GET /api/verse/fleet/control/map-edges', () => {
  const send = async (api: ReturnType<typeof createFleetLiveMapApi>, url: string, method = 'GET', session = Date.now() + 60_000) => {
    let status = 0, body = '';
    const res = { writeHead: (s: number) => { status = s; return res; }, setHeader: () => res, end: (b?: string) => { body = b ?? ''; }, statusCode: 0 } as never;
    const handled = await api({ readSession: { expiresAt: session } } as never, { url, headers: {} } as never, res, url.split('?')[0]!, method);
    return { handled, status: status || (res as { statusCode: number }).statusCode, body: body ? JSON.parse(body) as Record<string, unknown> : null };
  };

  it('serves the same edges as the CLI, behind a read session, with since and an exclusive before', async () => {
    const root = store(chat), calls: string[] = [];
    const api = createFleetLiveMapApi(async () => { throw new Error('not the map'); },
      (since, options) => { calls.push(`${since}${options?.before ? `+${options.before}` : ''}`); return readMapEdges(since, { root, now: () => NOW, ...options }); });
    const ok = await send(api, MAP_EDGES_PATH);
    expect(ok).toMatchObject({ handled: true, status: 200 });
    expect(ok.body).toEqual(JSON.parse(JSON.stringify(read(root))));
    expect((await send(api, `${MAP_EDGES_PATH}?since=1d`)).body).toMatchObject({ since: '2026-11-17T12:01:00.000Z', messages: 3 });
    // A bare before keeps the default window's floor and adds the exclusive ceiling.
    expect((await send(api, `${MAP_EDGES_PATH}?before=${T0 + 1_500}`)).body).toMatchObject({ messages: 2 });
    expect((await send(api, `${MAP_EDGES_PATH}?since=${T0}&before=${T0 + 1_500}`)).body).toMatchObject({ messages: 2 });
    // The default window is built once per 5 s; an explicit window is read each time.
    await send(api, MAP_EDGES_PATH);
    expect(calls).toEqual(['15m', '1d', `15m+${T0 + 1_500}`, `${T0}+${T0 + 1_500}`]);
    expect((await send(api, `${MAP_EDGES_PATH}?since=soon`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?before=soon`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?limit=5`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?since=1d&since=2d`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?before=1d&before=2d`)).status).toBe(400);
    expect((await send(api, MAP_EDGES_PATH, 'POST')).status).toBe(405);
    expect((await send(api, MAP_EDGES_PATH, 'GET', Date.now() - 1)).status).toBe(401);
    expect((await send(api, '/api/verse/fleet/control/other')).handled).toBe(false);
  });

  it('takes the phm messages filters as query params, each once, and never serves them from the window cache', async () => {
    const root = store(mixed);
    const api = createFleetLiveMapApi(async () => { throw new Error('not the map'); },
      (since, options) => readMapEdges(since, { root, now: () => NOW, ...options }));
    // The bare read caches the unfiltered window for 5 s; a filtered read
    // answers its own matched set rather than that cached body.
    expect((await send(api, MAP_EDGES_PATH)).body).toMatchObject({ messages: 6 });
    expect((await send(api, `${MAP_EDGES_PATH}?kind=ask`)).body).toMatchObject({ messages: 1 });
    expect((await send(api, `${MAP_EDGES_PATH}?kind=reply`)).body).toMatchObject({ messages: 1 });
    expect((await send(api, `${MAP_EDGES_PATH}?from=claude`)).body).toMatchObject({ messages: 3 });
    expect((await send(api, `${MAP_EDGES_PATH}?excludeFrom=claude`)).body).toMatchObject({ messages: 3 });
    expect((await send(api, `${MAP_EDGES_PATH}?agent=claude&with=leader`)).body).toMatchObject({ messages: 4 });
    expect((await send(api, `${MAP_EDGES_PATH}?inReplyTo=m1`)).body).toMatchObject({ messages: 1 });
    expect((await send(api, `${MAP_EDGES_PATH}?bodyKind=note`)).body).toMatchObject({ messages: 1 });
    expect((await send(api, `${MAP_EDGES_PATH}?result=failed`)).body).toMatchObject({ messages: 0, edges: [] });
    // Filters compose with the window params.
    expect((await send(api, `${MAP_EDGES_PATH}?kind=status&before=${T0 + 2_500}`)).body).toMatchObject({ messages: 2 });
    // The same once-each rule and the same parser refusals the other reads apply.
    for (const url of [`${MAP_EDGES_PATH}?kind=ask&kind=reply`, `${MAP_EDGES_PATH}?agent=claude&agent=codex`,
      `${MAP_EDGES_PATH}?kind=bogus`, `${MAP_EDGES_PATH}?with=claude`, `${MAP_EDGES_PATH}?result=released`,
      `${MAP_EDGES_PATH}?bodyKind=has%20space`, `${MAP_EDGES_PATH}?inReplyTo=m1&inReplyTo=m2`, `${MAP_EDGES_PATH}?limit=5`])
      expect((await send(api, url)).status).toBe(400);
  });

  it('answers 503 with the typed unknown body when the bus cannot be read', async () => {
    const down = await send(createFleetLiveMapApi(undefined, () => buildMapEdges({ source: 'unavailable', rows: [] }, T0, NOW)), `${MAP_EDGES_PATH}?since=10m`);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ schema: 'fleet.map-edges.v1', version: 1, source: 'unavailable', edges: null });
  });
});
