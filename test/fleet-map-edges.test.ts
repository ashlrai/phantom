import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdMap } from '../src/cli/map.js';
import { parseAgentMessagesQuery, readAgentMessages } from '../src/core/fleet/agent-messages.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { projectFleetEdges } from '../src/core/fleet/fleet-edges.js';
import { buildMapEdges, formatMapEdgesText, readMapEdges, type MapEdges, type MapEdgesFlags } from '../src/core/fleet/map-edges.js';
import { createFleetLiveMapApi, MAP_EDGES_PATH } from '../src/core/verse/fleet-live-map-api.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), NOW = T0 + 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function store(messages: [at: number, from: string, to: string, text: string][] = [], root = mkdtempSync(join(tmpdir(), 'map-edges-'))) {
  roots.push(root);
  messages.forEach(([at, from, to, text], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: 'P2', ttl: 86_400_000, body: { text } },
    { root, now: () => at }).status).toBe('posted'));
  return root;
}
const read = (root: string, since?: string, before?: string, filters: Omit<MapEdgesFlags, 'since' | 'before'> = {}) =>
  readMapEdges({ ...filters, ...(since === undefined ? {} : { since }), ...(before === undefined ? {} : { before }) }, { root, now: () => NOW }).result;
const chat: Parameters<typeof store>[0] = [
  [T0, 'leader', 'claude', 'please look at the build'], [T0 + 1_000, 'claude', 'leader', 'on it'], [T0 + 2_000, 'leader', 'claude', 'thanks, next the docs']];
const fan: Parameters<typeof store>[0] = ['RQ-ONE', 'RQ-TWO', 'RQ-THREE', 'RQ-FOUR', 'RQ-FIVE'].map((job, i) => [T0 + i * 1_000, 'claude', job, `start ${job}`]);
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
    expect(readMapEdges({ since: String(T0 + 1_500) }, { root, now: () => NOW }).result.edges!.map(edge => [edge.id, edge.count])).toEqual([['leader->claude', 1]]);
    expect(readMapEdges({ since: 'soon' }, { root })).toEqual({ ok: false, error: '--since takes 10m, 2h, 1d, epoch ms or an ISO time.' });
    expect(readAgentMessages({ agent: 'claude', with: 'leader', limit: 20 }, { root, now: () => NOW }).matched).toBe(3);
    expect(readAgentMessages({ agent: 'claude', with: 'devin', limit: 20 }, { root, now: () => NOW }).matched).toBe(0);
    expect(parseAgentMessagesQuery({ agent: 'claude', with: 'leader', limit: '20' })).toEqual({ ok: true, query: { agent: 'claude', with: 'leader', limit: 20 } });
    expect(parseAgentMessagesQuery({ with: 'leader' })).toEqual({ ok: false, error: '--with takes the other agent and needs --agent.' });
  });

  it('--before is an exclusive upper bound: the [since, before) window counts each message once', () => {
    const root = store(chat), at = (ms: number) => new Date(ms).toISOString();
    // chat: leader->claude at T0 and T0+2000, claude->leader at T0+1000.
    const bounded = (since: string | undefined, before: string | undefined) => readMapEdges({ ...(since === undefined ? {} : { since }), ...(before === undefined ? {} : { before }) }, { root, now: () => NOW });
    expect(bounded(undefined, at(T0 + 2_000)).result.messages).toBe(2);
    expect(bounded(undefined, at(T0 + 2_001)).result.messages).toBe(3);
    expect(bounded(at(T0 + 500), at(T0 + 1_500)).result.edges!.map(edge => [edge.id, edge.count, edge.lastAt]))
      .toEqual([['claude->leader', 1, '2026-11-18T12:00:01.000Z']]);
    expect(bounded(at(T0 + 2_500), at(T0 + 1_000)).result).toMatchObject({ source: 'available', edges: [], messages: 0 });
    expect(bounded(undefined, 'soon')).toEqual({ ok: false, error: '--before takes 15m, 2h, 1d, epoch ms or an ISO time.' });
  });

  it('the shared phm messages filters narrow which messages the edges count', () => {
    const root = store([...chat, [T0 + 3_000, 'claude', 'codex', 'review the RQ-ONE patch'],
      [T0 + 4_000, 'codex', 'claude', 'RQ-ONE looks fine'], [T0 + 5_000, 'devin', 'claude', 'unrelated ping?']]);
    // --from keeps only one sender's traffic: claude's two sends fold into one edge each, newest first.
    const fromClaude = read(root, undefined, undefined, { from: 'claude' });
    expect(fromClaude.edges!.map(edge => [edge.id, edge.count])).toEqual([['claude->codex', 1], ['claude->leader', 1]]);
    expect(fromClaude.messages).toBe(2);
    // --exclude-from drops that sender's rows while every other sender's stay.
    const noClaude = read(root, undefined, undefined, { excludeFrom: 'claude' });
    expect(noClaude.edges!.map(edge => edge.id).sort()).toEqual(['codex->claude', 'devin->claude', 'leader->claude']);
    // --agent with --with keeps only the pair's two-way talk.
    const pair = read(root, undefined, undefined, { agent: 'claude', with: 'codex' });
    expect(pair.edges!.map(edge => [edge.id, edge.count])).toEqual([['codex->claude', 1], ['claude->codex', 1]]);
    expect(pair.messages).toBe(2);
    // --contains matches the scrubbed summary the edge's lastSummary shows.
    const docs = read(root, undefined, undefined, { contains: 'docs' });
    expect(docs.edges!.map(edge => [edge.id, edge.count])).toEqual([['leader->claude', 1]]);
    // --job keeps the traffic naming one job: the RQ-ONE exchange plus nothing else.
    const job = read(root, undefined, undefined, { job: 'RQ-ONE' });
    expect(job.edges!.map(edge => [edge.id, edge.count])).toEqual([['codex->claude', 1], ['claude->codex', 1]]);
    expect(job.messages).toBe(2);
    // --kind ask keeps only messages the shared classifier calls asks.
    const asks = read(root, undefined, undefined, { kind: 'ask' });
    expect(asks.edges!.map(edge => [edge.id, edge.count])).toEqual([['devin->claude', 1]]);
    expect(asks.messages).toBe(1);
    // --id keeps the one envelope whose wire id matches; every other row drops.
    const one = read(root, undefined, undefined, { id: 'm3' });
    expect(one.edges!.map(edge => [edge.id, edge.count])).toEqual([['claude->codex', 1]]);
    expect(one.messages).toBe(1);
    // A filter that matches nothing is an empty page, never an error.
    expect(read(root, undefined, undefined, { from: 'nobody' })).toMatchObject({ source: 'available', edges: [], messages: 0 });
    // A malformed filter value is a usage error naming the flag.
    expect(readMapEdges({ kind: 'bogus' }, { root, now: () => NOW })).toEqual({ ok: false, error: '--kind takes one of ask, reply, handoff, status, blocker.' });
    expect(readMapEdges({ with: 'codex' }, { root, now: () => NOW })).toEqual({ ok: false, error: '--with takes the other agent and needs --agent.' });
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
      ['edges', '--kind', 'bogus'], ['edges', '--with', 'leader'], ['edges', '--agent']]) expect(await cmdMap(bad)).toBe(2);
    expect(err).toHaveBeenCalledTimes(9);
    expect(await cmdMap(['--help'])).toBe(0);
    expect(log.mock.calls[3]![0]).toContain('phm map edges [--json] [--since <10m|2h|1d|ISO|epoch> | --minutes <n>] [--before <10m|2h|1d|ISO|epoch>]');
  });
});

describe('GET /api/verse/fleet/control/map-edges', () => {
  const send = async (api: ReturnType<typeof createFleetLiveMapApi>, url: string, method = 'GET', session = Date.now() + 60_000) => {
    let status = 0, body = '';
    const res = { writeHead: (s: number) => { status = s; return res; }, setHeader: () => res, end: (b?: string) => { body = b ?? ''; }, statusCode: 0 } as never;
    const handled = await api({ readSession: { expiresAt: session } } as never, { url, headers: {} } as never, res, url.split('?')[0]!, method);
    return { handled, status: status || (res as { statusCode: number }).statusCode, body: body ? JSON.parse(body) as Record<string, unknown> : null };
  };

  it('serves the same edges as the CLI, behind a read session, with the shared filters', async () => {
    const root = store(chat), calls: string[] = [];
    const api = createFleetLiveMapApi(async () => { throw new Error('not the map'); },
      (input, options) => { calls.push(JSON.stringify(input)); return readMapEdges(input, { root, now: () => NOW, ...options }); });
    const ok = await send(api, MAP_EDGES_PATH);
    expect(ok).toMatchObject({ handled: true, status: 200 });
    expect(ok.body).toEqual(JSON.parse(JSON.stringify(read(root))));
    expect((await send(api, `${MAP_EDGES_PATH}?since=1d`)).body).toMatchObject({ since: '2026-11-17T12:01:00.000Z', messages: 3 });
    // A bare before keeps the default window's floor and adds the exclusive ceiling.
    expect((await send(api, `${MAP_EDGES_PATH}?before=${T0 + 1_500}`)).body).toMatchObject({ messages: 2 });
    expect((await send(api, `${MAP_EDGES_PATH}?since=${T0}&before=${T0 + 1_500}`)).body).toMatchObject({ messages: 2 });
    // The shared phm messages filters narrow the counted edges the same way the CLI does.
    expect((await send(api, `${MAP_EDGES_PATH}?from=claude`)).body).toMatchObject({ messages: 1 });
    expect((await send(api, `${MAP_EDGES_PATH}?agent=claude&with=leader`)).body).toMatchObject({ messages: 3 });
    expect((await send(api, `${MAP_EDGES_PATH}?contains=docs`)).body).toMatchObject({ messages: 1 });
    expect((await send(api, `${MAP_EDGES_PATH}?id=m1`)).body).toMatchObject({ messages: 1 });
    // The default window is built once per 5 s; an explicit window or filter is read each time.
    await send(api, MAP_EDGES_PATH);
    expect(calls).toEqual([JSON.stringify({ since: '15m' }), JSON.stringify({ since: '1d' }), JSON.stringify({ before: String(T0 + 1_500) }),
      JSON.stringify({ since: String(T0), before: String(T0 + 1_500) }), JSON.stringify({ from: 'claude' }),
      JSON.stringify({ agent: 'claude', with: 'leader' }), JSON.stringify({ contains: 'docs' }), JSON.stringify({ id: 'm1' })]);
    expect((await send(api, `${MAP_EDGES_PATH}?since=soon`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?before=soon`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?kind=bogus`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?with=leader`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?limit=5`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?since=1d&since=2d`)).status).toBe(400);
    expect((await send(api, `${MAP_EDGES_PATH}?before=1d&before=2d`)).status).toBe(400);
    expect((await send(api, MAP_EDGES_PATH, 'POST')).status).toBe(405);
    expect((await send(api, MAP_EDGES_PATH, 'GET', Date.now() - 1)).status).toBe(401);
    expect((await send(api, '/api/verse/fleet/control/other')).handled).toBe(false);
  });

  it('answers 503 with the typed unknown body when the bus cannot be read', async () => {
    const down = await send(createFleetLiveMapApi(undefined, () => ({ ok: true as const, result: buildMapEdges({ source: 'unavailable', rows: [] }, T0, NOW) })), `${MAP_EDGES_PATH}?since=10m`);
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ schema: 'fleet.map-edges.v1', version: 1, source: 'unavailable', edges: null });
  });
});
