import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { cmdFleetMessageGraph } from '../src/cli/fleet-message-graph.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { AshlrConfig } from '../src/core/config.js';
import type { AgentMessagesQuery } from '../src/core/fleet/agent-messages.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readMapEdges } from '../src/core/fleet/map-edges.js';
import { formatMessageGraphText, MESSAGE_GRAPH_PATH, messageGraphResponse, organizationOf, readMessageGraph } from '../src/core/fleet/message-graph.js';
import { handleApi } from '../src/core/web/api.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), NOW = T0 + 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
type Said = [at: number, from: string, to: string, body: string | Record<string, unknown>, priority?: 'P0' | 'P1' | 'P2' | 'P3'];
function store(messages: Said[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'message-graph-'));
  roots.push(root);
  messages.forEach(([at, from, to, body, priority], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: priority ?? 'P2', ttl: 86_400_000,
    body: typeof body === 'string' ? { text: body } : body }, { root, now: () => at }).status).toBe('posted'));
  return root;
}
// One of every filterable shape: plain mail both ways, a job citation, a
// threaded channel note and a reply citing m1 — ids are the store's m<index>.
const mixed: Said[] = [
  [T0, 'leader', 'claude', 'please look at the build'],
  [T0 + 1_000, 'claude', 'leader', 'on it?'],
  [T0 + 2_000, 'leader', 'claude', 'thanks, next the docs'],
  [T0 + 3_000, 'claude', 'codex', 'RQ-ONE-1 shipped the patch'],
  [T0 + 4_000, 'codex', 'group:build:general', { kind: 'note', thread: 'build', text: 'build notes here' }],
  [T0 + 5_000, 'claude', 'leader', { text: 'answering you', inReplyTo: 'm1' }],
];
const read = (root: string, since?: string, before?: string, filters?: AgentMessagesQuery) =>
  readMessageGraph(since, { root, now: () => NOW, before, filters })!;
const KEYS = ['schema', 'version', 'generatedAt', 'since', 'source', 'organizations', 'groups', 'messages', 'skipped'];

describe('fleet message graph', () => {
  it('empty: no groups and no organizations, with the stable schema, version and key order', () => {
    const none = read(store()), old = read(store([[T0 - 3_600_000, 'leader', 'claude', 'old news']]));
    expect(none).toEqual({ schema: 'fleet.message-graph.v1', version: 1, generatedAt: '2026-11-18T12:01:00.000Z', since: '2026-11-18T11:46:00.000Z',
      source: 'missing', organizations: [], groups: [], messages: 0, skipped: 0 });
    expect(Object.keys(none)).toEqual(KEYS);
    expect(old).toMatchObject({ source: 'available', organizations: [], groups: [], messages: 0 });
    expect(formatMessageGraphText(none)).toBe('0 agent messages between 0 organizations since 2026-11-18 11:46 UTC.');
  });

  it('one edge: one group between two organizations, and no message text anywhere', () => {
    const root = store([[T0, 'claude', 'codex', 'TOP-SECRET-PLAN please review']]), graph = read(root);
    expect(graph.groups).toEqual([{ id: 'Anthropic->OpenAI', from: 'Anthropic', to: 'OpenAI', count: 1, lastAt: '2026-11-18T12:00:00.000Z',
      edges: [{ id: 'claude->codex', from: 'claude', to: 'codex', count: 1, lastAt: '2026-11-18T12:00:00.000Z' }] }]);
    expect(graph.organizations).toEqual([{ name: 'Anthropic', agents: ['claude'], sent: 1, received: 0 }, { name: 'OpenAI', agents: ['codex'], sent: 0, received: 1 }]);
    expect(graph).toMatchObject({ source: 'available', messages: 1 });
    expect(JSON.stringify(graph)).not.toContain('TOP-SECRET-PLAN');
    expect(JSON.stringify(read(root))).toBe(JSON.stringify(graph));
    expect(formatMessageGraphText(graph).split('\n')).toEqual(['1 agent message between 2 organizations since 2026-11-18 11:46 UTC.',
      'Anthropic -> OpenAI: 1, last 12:00:00Z', '  claude -> codex: 1']);
  });

  it('many: edges fold into organization pairs, newest first, with totals that match the map edges', () => {
    const root = store([
      [T0, 'leader', 'claude', 'build'], [T0 + 1_000, 'claude', 'leader', 'on it'], [T0 + 2_000, 'leader', 'claude', 'docs next'],
      [T0 + 3_000, 'claude', 'codex-local', 'local check'], [T0 + 4_000, 'claude-7', 'codex', 'review'], [T0 + 5_000, 'claude', 'codex', 'review two'],
      [T0 + 6_000, 'claude', 'claude-7', 'inside one company'], [T0 + 7_000, 'gemini', 'RQ-ONE', 'start'], [T0 + 8_000, 'mystery-claude', 'mystery', 'who'],
      [T0 + 9_000, 'claude', 'claude', 'note to self'], [T0 + 9_500, 'claude', 'leaders', 'broadcast']]);
    const graph = read(root), edges = readMapEdges(undefined, { root, now: () => NOW })!;
    expect(graph.groups!.map(group => [group.id, group.count, group.lastAt.slice(17, 19), group.edges.map(edge => `${edge.id}:${edge.count}`)])).toEqual([
      ['unknown->unknown', 1, '08', ['mystery-claude->mystery:1']],
      ['Google->unknown', 1, '07', ['gemini->RQ-ONE:1']],
      ['Anthropic->Anthropic', 1, '06', ['claude->claude-7:1']],
      ['Anthropic->OpenAI', 2, '05', ['claude->codex:1', 'claude-7->codex:1']],
      ['Anthropic->Local', 1, '03', ['claude->codex-local:1']],
      ['unknown->Anthropic', 2, '02', ['leader->claude:2']],
      ['Anthropic->unknown', 1, '01', ['claude->leader:1']]]);
    expect(graph.organizations).toEqual([
      { name: 'Anthropic', agents: ['claude', 'claude-7'], sent: 5, received: 3 },
      { name: 'OpenAI', agents: ['codex'], sent: 0, received: 2 },
      { name: 'Google', agents: ['gemini'], sent: 1, received: 0 },
      { name: 'Local', agents: ['codex-local'], sent: 0, received: 1 },
      { name: 'unknown', agents: ['RQ-ONE', 'leader', 'mystery', 'mystery-claude'], sent: 3, received: 3 }]);
    // Every counted message sits on exactly one edge in exactly one group; notes to self and broadcasts are not edges.
    const total = (rows: readonly { count: number }[]) => rows.reduce((sum, row) => sum + row.count, 0);
    expect([graph.messages, total(graph.groups!), total(graph.groups!.flatMap(group => group.edges))]).toEqual([9, 9, total(edges.edges!)]);
    expect(graph.groups!.flatMap(group => group.edges.map(edge => edge.id)).sort()).toEqual(edges.edges!.map(edge => edge.id).sort());
    // A lane names an organization; a bare name that only contains brand words does not.
    expect([organizationOf({ lane: 'claude' }), organizationOf({ lane: null })]).toEqual(['Anthropic', 'unknown']);
    // --since narrows the window.
    expect(read(root, String(T0 + 7_500)).groups!.map(group => [group.id, group.count])).toEqual([['unknown->unknown', 1]]);
    // --before is the exclusive ceiling: [since, before) counts each message once.
    expect(read(root, undefined, String(T0 + 8_000)).messages).toBe(8);
    expect(read(root, undefined, String(T0 + 8_001)).messages).toBe(9);
    expect(read(root, String(T0 + 7_500), String(T0 + 8_500))).toMatchObject({ messages: 1, groups: [{ id: 'unknown->unknown', count: 1 }] });
    expect(readMessageGraph(undefined, { root, now: () => NOW, before: 'soon' })).toBeNull();
    expect(formatMessageGraphText(graph).split('\n').slice(0, 3)).toEqual(['9 agent messages between 5 organizations since 2026-11-18 11:46 UTC.',
      'unknown -> unknown: 1, last 12:00:08Z', '  mystery-claude -> mystery: 1']);
  });

  it('the shared phm messages filters narrow the matched rows before the organization pairs aggregate', () => {
    const root = store(mixed);
    const unfiltered = read(root);
    expect(unfiltered.messages).toBe(6);
    expect(unfiltered.groups!.map(group => [group.id, group.count])).toEqual([
      ['Anthropic->unknown', 2], ['OpenAI->unknown', 1], ['Anthropic->OpenAI', 1], ['unknown->Anthropic', 2]]);
    const filtered = (filters: AgentMessagesQuery, since?: string, before?: string) => read(root, since, before, filters);
    // --kind keeps one classified kind; --contains is the scrubbed-summary substring search.
    expect(filtered({ kind: 'ask' })).toMatchObject({ messages: 1 });
    expect(filtered({ kind: 'ask' })!.groups).toEqual([expect.objectContaining({ id: 'Anthropic->unknown', count: 1 })]);
    expect(filtered({ kind: 'reply' })).toMatchObject({ messages: 1 });
    expect(filtered({ contains: 'DOCS' })).toMatchObject({ messages: 1 });
    // --from/--to decide on the addressed labels; --agent/--with scope to the pair.
    const senders = filtered({ from: 'claude' });
    expect(senders.messages).toBe(3);
    expect(senders.groups!.map(group => [group.id, group.count])).toEqual([['Anthropic->unknown', 2], ['Anthropic->OpenAI', 1]]);
    expect(filtered({ to: 'claude' })).toMatchObject({ messages: 2 });
    const pair = filtered({ agent: 'claude', with: 'leader' });
    expect(pair.messages).toBe(4);
    expect(pair.groups!.map(group => group.id).sort()).toEqual(['Anthropic->unknown', 'unknown->Anthropic']);
    // --job/--thread/--channel/--in-reply-to/--id/--body-kind keep only the rows
    // carrying that citation or discriminator, and the organizations roll up
    // exactly the matched rows — never a guessed total.
    expect(filtered({ job: 'RQ-ONE-1' })).toMatchObject({ messages: 1 });
    expect(filtered({ thread: 'build' })).toMatchObject({ messages: 1 });
    expect(filtered({ channel: 'build' })).toMatchObject({ messages: 1 });
    expect(filtered({ topic: 'general' })).toMatchObject({ messages: 1 });
    expect(filtered({ channel: 'build', topic: 'general' })).toMatchObject({ messages: 1 });
    expect(filtered({ topic: 'gone' })).toMatchObject({ messages: 0, groups: [] });
    expect(filtered({ inReplyTo: 'm1' })).toMatchObject({ messages: 1 });
    expect(filtered({ id: 'm3' })).toMatchObject({ messages: 1 });
    expect(filtered({ id: 'm-gone' })).toMatchObject({ messages: 0, groups: [], organizations: [] });
    expect(filtered({ bodyKind: 'note' })).toMatchObject({ messages: 1 });
    expect(filtered({ bodyKind: 'work.post' })).toMatchObject({ messages: 0, groups: [] });
    expect(filtered({ priority: 'P0' })).toMatchObject({ messages: 0 });
    expect(filtered({ priority: 'P2' })).toMatchObject({ messages: 6 });
    // A one-direction filter still reports both organizations with honest
    // sent/received splits over the matched rows only.
    expect(senders.organizations).toEqual([
      { name: 'Anthropic', agents: ['claude'], sent: 3, received: 0 },
      { name: 'OpenAI', agents: ['codex'], sent: 0, received: 1 },
      { name: 'unknown', agents: ['leader'], sent: 0, received: 2 }]);
    // The read's own window still bounds the matched set: since/filters compose
    // into one [since, before) window exactly like the unfiltered read.
    expect(filtered({ from: 'claude' }, String(T0 + 4_500))).toMatchObject({ messages: 1 });
    expect(filtered({ kind: 'status' }, undefined, String(T0 + 2_500))!.messages).toBe(2);
    // An empty filter object is the unfiltered read, byte-identical.
    expect(read(root, undefined, undefined, {})).toEqual(unfiltered);
  });

  it('an unreadable bus is unknown, not zero', () => {
    const root = store([[T0, 'claude', 'codex', 'hello']]);
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{broken');
    const graph = read(root);
    expect(graph).toMatchObject({ source: 'unavailable', organizations: null, groups: null, messages: null });
    expect(formatMessageGraphText(graph)).toBe('Agent messages: unknown (the agent bus could not be read).');
    expect(messageGraphResponse(MESSAGE_GRAPH_PATH, { root, now: () => NOW })).toEqual({ status: 503, body: graph });
  });

  it('GET /api/fleet/message-graph serves the same read and rejects any other query', async () => {
    const root = store([[T0, 'claude', 'codex', 'hello']]), options = { root, now: () => NOW };
    expect(messageGraphResponse(MESSAGE_GRAPH_PATH, options)).toEqual({ status: 200, body: read(root) });
    expect(messageGraphResponse(`${MESSAGE_GRAPH_PATH}?since=${T0 + 500}`, options)).toMatchObject({ status: 200, body: { groups: [], messages: 0 } });
    expect(messageGraphResponse(`${MESSAGE_GRAPH_PATH}?before=${T0}`, options)).toMatchObject({ status: 200, body: { messages: 0 } });
    expect(messageGraphResponse(`${MESSAGE_GRAPH_PATH}?since=${T0}&before=${T0 + 1}`, options)).toMatchObject({ status: 200, body: { messages: 1 } });
    for (const query of ['since=soon', 'since=1m&since=2m', 'root=/tmp', 'since=1m&limit=2', 'before=soon', 'before=1m&before=2m', 'since=1m&before=soon']) expect(messageGraphResponse(`${MESSAGE_GRAPH_PATH}?${query}`, options).status).toBe(400);
    const call = async (url: string, method = 'GET') => {
      const req = Object.assign(Readable.from([]) as IncomingMessage, { url, method, headers: {} });
      let status = 0, payload = '';
      const res = { writeHead(code: number) { status = code; }, end(text: string) { payload = text; } } as unknown as ServerResponse;
      await handleApi(req, res, {} as AshlrConfig, { token: 'message-graph-test', allowDispatch: false });
      return { status, body: payload ? JSON.parse(payload) : null };
    };
    const served = await call(MESSAGE_GRAPH_PATH);
    expect(served.status).toBe(200);
    expect(Object.keys(served.body)).toEqual(KEYS);
    expect(served.body).toMatchObject({ schema: 'fleet.message-graph.v1', version: 1 });
    expect((await call(`${MESSAGE_GRAPH_PATH}?since=soon`)).status).toBe(400);
    expect((await call(`${MESSAGE_GRAPH_PATH}?before=soon`)).status).toBe(400);
    expect((await call(`${MESSAGE_GRAPH_PATH}?before=${T0 + 8_000}`)).status).toBe(200);
    expect((await call(`${MESSAGE_GRAPH_PATH}?from=claude`)).status).toBe(200);
    expect((await call(`${MESSAGE_GRAPH_PATH}?kind=bogus`)).status).toBe(400);
  });

  it('GET /api/fleet/message-graph takes the phm messages filters, each once, and never paginates', () => {
    const root = store(mixed), options = { root, now: () => NOW };
    const filtered = (query: string) => messageGraphResponse(`${MESSAGE_GRAPH_PATH}?${query}`, options);
    // Every filter is a param of the same name the map-edges read takes,
    // validated by the same parser, narrowing the rows before the pairs aggregate.
    expect(filtered('from=claude')).toMatchObject({ status: 200, body: { messages: 3 } });
    expect(filtered('kind=ask')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('kind=reply')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('contains=docs')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('job=RQ-ONE-1')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('thread=build')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('channel=build')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('topic=general')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('inReplyTo=m1')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('id=m3')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('bodyKind=note')).toMatchObject({ status: 200, body: { messages: 1 } });
    expect(filtered('priority=P2')).toMatchObject({ status: 200, body: { messages: 6 } });
    expect(filtered('agent=claude&with=leader')).toMatchObject({ status: 200, body: { messages: 4 } });
    expect(filtered('to=claude')).toMatchObject({ status: 200, body: { messages: 2 } });
    expect(filtered('excludeFrom=claude')).toMatchObject({ status: 200, body: { messages: 3 } });
    expect(filtered('result=failed')).toMatchObject({ status: 200, body: { messages: 0, groups: [] } });
    // The organization pairs still roll up honestly: one direction keeps
    // both sides with their matched sent/received splits.
    expect(filtered('from=claude')).toMatchObject({ status: 200, body: {
      groups: [{ id: 'Anthropic->unknown', count: 2 }, { id: 'Anthropic->OpenAI', count: 1 }],
      organizations: [{ name: 'Anthropic', sent: 3, received: 0 }, { name: 'OpenAI', sent: 0, received: 1 },
        { name: 'unknown', sent: 0, received: 2 }] } });
    // Filters compose with the window params into one [since, before) read.
    expect(filtered(`kind=status&before=${T0 + 2_500}`)).toMatchObject({ status: 200, body: { messages: 2 } });
    // The same once-each rule and the same parser refusals the other reads apply;
    // `limit` is not a graph param — the aggregate never paginates.
    for (const query of ['limit=5', 'kind=ask&kind=reply', 'agent=claude&agent=codex', 'kind=bogus', 'with=claude',
      'result=released', 'bodyKind=has%20space', 'inReplyTo=m1&inReplyTo=m2', 'priority=P9', 'job=has space', 'topic=BAD!'])
      expect(filtered(query).status).toBe(400);
  });

  it('phm fleet message-graph prints the same JSON, is registered, and rejects bad usage', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(Object.keys(await FLEET_SUBCOMMAND_LOADERS['message-graph']!())).toContain('cmdFleetMessageGraph');
    expect(await cmdFleetMessageGraph(['--help'])).toBe(0);
    expect(out.mock.lastCall![0]).toContain('phm fleet message-graph [--json] [--since <10m|2h|1d|ISO>] [--before <10m|2h|1d|ISO|epoch>]');
    for (const args of [['--since'], ['--json', '--json'], ['--since', 'soon'], ['--before'], ['--before', 'soon'], ['--apply'],
      ['--limit', '5'], ['--kind', 'bogus'], ['--with', 'claude'], ['--result', 'released'], ['--id'],
      ['--topic', 'BAD TOPIC'], ['--agent', 'claude', '--agent', 'codex'], ['--kind', 'ask', '--kind', 'reply']]) expect(await cmdFleetMessageGraph(args)).toBe(2);
    expect(err).toHaveBeenCalledTimes(14);
    expect(await cmdFleetMessageGraph(['--json', '--since', '1m'])).toBe(0);
    const printed = JSON.parse(out.mock.lastCall![0]);
    expect(Object.keys(printed)).toEqual(KEYS);
    expect(printed).toMatchObject({ schema: 'fleet.message-graph.v1', version: 1 });
    expect(await cmdFleetMessageGraph(['--json', '--before', '1h'])).toBe(0);
    expect(JSON.parse(out.mock.lastCall![0])).toMatchObject({ schema: 'fleet.message-graph.v1', version: 1 });
    // The phm messages filter flags parse through the shared parser and reach the read.
    expect(await cmdFleetMessageGraph(['--json', '--kind', 'ask', '--contains', 'build', '--topic', 'general'])).toBe(0);
    expect(JSON.parse(out.mock.lastCall![0])).toMatchObject({ schema: 'fleet.message-graph.v1', version: 1, source: 'missing', messages: 0 });
    expect(await cmdFleetMessageGraph(['--json', '--from', 'claude', '--priority', 'P0'])).toBe(0);
    expect(JSON.parse(out.mock.lastCall![0])).toMatchObject({ schema: 'fleet.message-graph.v1', version: 1, source: 'missing', messages: 0 });
    expect(await cmdFleetMessageGraph([])).toBe(0);
    expect(out.mock.lastCall![0]).toMatch(/^\d+ agent messages? between \d+ organizations? since /);
  });
});
