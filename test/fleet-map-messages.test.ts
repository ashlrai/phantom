import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { cmdFleetMessages } from '../src/cli/fleet-messages.js';
import { cmdFleetMap } from '../src/cli/fleet-map.js';
import { cmdFleetMapMessages } from '../src/cli/fleet-map-messages.js';
import type { AshlrConfig } from '../src/core/config.js';
import type { AgentMessage } from '../src/core/fleet/agent-messages.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { buildMapMessages, formatMapMessagesText, MAP_MESSAGES_PATH, mapMessagesResponse,
  readMapMessages, type MapMessages, type MapMessagesFlags, type MapMessagesOptions } from '../src/core/fleet/map-messages.js';
import { handleApi } from '../src/core/web/api.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), NOW = T0 + 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
type Said = [at: number, from: string, to: string, body: string | Record<string, unknown>];
function store(said: Said[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'map-messages-'));
  roots.push(root);
  said.forEach(([at, from, to, body], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: 'P2', ttl: 86_400_000,
    body: typeof body === 'string' ? { text: body } : body }, { root, now: () => at }).status).toBe('posted'));
  return root;
}
const read = (root: string, input: MapMessagesFlags = {}, options: MapMessagesOptions = {}) => {
  const result = readMapMessages(input, { root, now: () => NOW, ...options });
  if (!result.ok) throw new Error(result.error);
  return result.result;
};
const KEYS = ['schema', 'version', 'generatedAt', 'since', 'source', 'messages', 'matched', 'skipped'];
const msg = (id: string, at: number, summary = id): AgentMessage => ({
  id, ts: new Date(at).toISOString(), priority: 'P2',
  from: { name: 'claude', lane: 'claude' }, to: { name: 'codex', lane: 'codex' },
  kind: 'status', summary, conversation: 'pair:claude|codex', job: null, pr: null });

describe('fleet map messages', () => {
  it('empty bus: no messages, stable schema and key order', () => {
    const none = read(store());
    expect(none).toEqual({ schema: 'fleet.map-messages.v1', version: 1, generatedAt: '2026-11-18T12:01:00.000Z', since: '2026-11-18T11:46:00.000Z',
      source: 'missing', messages: [], matched: 0, skipped: 0 });
    expect(Object.keys(none)).toEqual(KEYS);
    expect(formatMapMessagesText(none)).toBe('0 agent messages since 2026-11-18 11:46 UTC.');
    expect(readMapMessages({ since: 'soon' }, { root: store() }))
      .toEqual({ ok: false, error: '--since takes 10m, 2h, 1d, epoch ms or an ISO time.' });
  });

  it('lists newest first with from, to, kind, summary and time; an unknown agent has no map node', () => {
    const root = store([[T0, 'leader', 'claude', 'please start the docs job'], [T0 + 1_000, 'claude', 'mystery-agent', 'is the docs job ready?'],
      [T0 + 2_000, 'claude', 'claude', 'note to self'], [T0 - 3_600_000, 'claude', 'codex', 'too old']]);
    const result = read(root);
    expect(result.matched).toBe(2);
    expect(result.messages!.map(m => [m.from, m.to, m.fromNode, m.toNode, m.kind, m.summary, m.at])).toEqual([
      ['claude', 'mystery-agent', 'lane:claude', null, 'ask', 'is the docs job ready?', '2026-11-18T12:00:01.000Z'],
      ['leader', 'claude', 'leader', 'lane:claude', 'status', 'please start the docs job', '2026-11-18T12:00:00.000Z']]);
    expect(read(root, { limit: '1' }).messages).toHaveLength(1);
    expect(formatMapMessagesText(result).split('\n')[1]).toBe('12:00:01Z claude -> mystery-agent (ask): is the docs job ready?');
  });

  it('sends every summary through the redaction helper and keeps it short', () => {
    const root = store([[T0, 'claude', 'codex', `${'word '.repeat(60)}secret-plan`]]);
    const redact = vi.fn((text: string) => text.replace('secret-plan', '[hidden]'));
    const result = read(root, {}, { redact });
    expect(redact).toHaveBeenCalledTimes(2);
    expect(result.messages![0]!.summary.length).toBeLessThanOrEqual(80);
    const short = read(store([[T0, 'claude', 'codex', 'see secret-plan now']]), {}, { redact });
    expect(short.messages![0]!.summary).toBe('see [hidden] now');
  });

  it('before keeps only messages received strictly before its cutoff, composing with since into one [since, before) window', () => {
    const root = store([[T0 - 3_600_000, 'claude', 'codex', 'too old'], [T0, 'leader', 'claude', 'first'], [T0 + 1_000, 'claude', 'leader', 'second'], [T0 + 2_000, 'claude', 'codex', 'third']]);
    const options = { root, now: () => NOW };
    // before at T0+1500 drops the T0+2000 row; T0 and T0+1000 stay, newest first.
    const windowed = read(root, { before: new Date(T0 + 1_500).toISOString() });
    expect(windowed.matched).toBe(2);
    expect(windowed.messages!.map(m => m.summary)).toEqual(['second', 'first']);
    // A message stamped exactly at the cutoff drops — adjacent windows never double-count it.
    expect(read(root, { before: String(T0 + 2_000) }).matched).toBe(2);
    // [since, before): since after T0 keeps only the T0+1000 row inside the window.
    expect(read(root, { since: new Date(T0 + 500).toISOString(), before: new Date(T0 + 1_500).toISOString() }).messages!.map(m => m.summary))
      .toEqual(['second']);
    // An inverted window is an honest empty page, not an error.
    expect(read(root, { since: new Date(T0 + 2_000).toISOString(), before: new Date(T0 + 1_000).toISOString() }))
      .toMatchObject({ matched: 0, messages: [] });
    // A bad before spelling is refused like a bad since.
    expect(readMapMessages({ before: 'soon' }, options))
      .toEqual({ ok: false, error: '--before takes 10m, 2h, 1d, epoch ms or an ISO time.' });
  });

  it('the shared phm messages filters narrow messages and matched alike', () => {
    const root = store([
      [T0, 'leader', 'claude', 'please look at the build'],
      [T0 + 1_000, 'claude', 'leader', 'on it?'],
      [T0 + 2_000, 'leader', 'claude', 'thanks, next the docs'],
      [T0 + 3_000, 'claude', 'codex', 'RQ-ONE-1 shipped the patch'],
      [T0 + 4_000, 'codex', 'group:build:general', { kind: 'note', thread: 'build', text: 'build notes here' }],
      [T0 + 5_000, 'claude', 'leader', { text: 'answering you', inReplyTo: 'm1' }],
    ]);
    const summaries = (input: MapMessagesFlags) => read(root, input).messages!.map(m => m.summary);
    // --kind keeps one classified kind; --contains is the scrubbed-summary substring search.
    expect(summaries({ kind: 'ask' })).toEqual(['on it?']);
    expect(summaries({ kind: 'reply' })).toEqual(['answering you']);
    expect(summaries({ contains: 'DOCS' })).toEqual(['thanks, next the docs']);
    // --from/--exclude-from decide on the sender's routing label; --to decides
    // on the recipient's — the same addressed-to rule the flat bus reads apply.
    expect(summaries({ from: 'claude' })).toEqual(['answering you', 'RQ-ONE-1 shipped the patch', 'on it?']);
    expect(summaries({ excludeFrom: 'leader' })).toEqual(['answering you', 'build notes here', 'RQ-ONE-1 shipped the patch', 'on it?']);
    expect(summaries({ to: 'claude' })).toEqual(['thanks, next the docs', 'please look at the build']);
    expect(summaries({ to: 'leader' })).toEqual(['answering you', 'on it?']);
    expect(summaries({ to: 'codex' })).toEqual(['RQ-ONE-1 shipped the patch']);
    expect(summaries({ to: 'claude', contains: 'build' })).toEqual(['please look at the build']);
    // --job keeps the traffic naming one job; --thread is the strict v2 note/context match.
    expect(summaries({ job: 'RQ-ONE-1' })).toEqual(['RQ-ONE-1 shipped the patch']);
    expect(summaries({ thread: 'build' })).toEqual(['build notes here']);
    // --channel keeps the room's posts; --in-reply-to keeps the citation;
    // --id keeps the one envelope carrying that wire id; --body-kind keeps
    // only bodies carrying that exact discriminator — the kindless mail
    // never matches.
    expect(summaries({ channel: 'build' })).toEqual(['build notes here']);
    expect(summaries({ inReplyTo: 'm1' })).toEqual(['answering you']);
    expect(summaries({ id: 'm1' })).toEqual(['on it?']);
    expect(summaries({ id: 'm-gone' })).toEqual([]);
    expect(summaries({ bodyKind: 'note' })).toEqual(['build notes here']);
    expect(summaries({ bodyKind: 'note', agent: 'codex' })).toEqual(['build notes here']);
    expect(summaries({ bodyKind: 'work.post' })).toEqual([]);
    // --agent/--with scope to the named participants.
    expect(read(root, { agent: 'codex' }).matched).toBe(2);
    expect(summaries({ agent: 'claude', with: 'codex' })).toEqual(['RQ-ONE-1 shipped the patch']);
    // matched counts the filtered set before --limit pages it.
    const filtered = read(root, { from: 'claude', limit: '1' });
    expect(filtered).toMatchObject({ matched: 3 });
    expect(filtered.messages).toHaveLength(1);
    // The same parser refuses what phm messages refuses.
    expect(readMapMessages({ with: 'codex' }, { root, now: () => NOW }))
      .toEqual({ ok: false, error: '--with takes the other agent and needs --agent.' });
    expect(readMapMessages({ kind: 'bogus' }, { root, now: () => NOW }))
      .toEqual({ ok: false, error: '--kind takes one of ask, reply, handoff, status, blocker.' });
    expect(readMapMessages({ channel: 'BAD CHANNEL!' }, { root, now: () => NOW })!.ok).toBe(false);
    expect(readMapMessages({ id: 'has space' }, { root, now: () => NOW })!.ok).toBe(false);
    expect(readMapMessages({ bodyKind: 'has space' }, { root, now: () => NOW })!.ok).toBe(false);
  });

  it('the pure builder shapes matched messages into newest-first map rows', () => {
    const bodies = new Map<string, unknown>([['a', { text: 'body text for a' }]]);
    const result = buildMapMessages({ source: 'available', skipped: 0,
      matched: [msg('b', T0 + 1_000, 'second'), msg('a', T0, 'first')], bodies }, { since: T0 - 1, limit: 20 }, NOW);
    expect(result.matched).toBe(2);
    expect(result.messages!.map(m => [m.id, m.summary, m.text])).toEqual([
      ['b', 'second', 'second'], ['a', 'first', 'body text for a']]);
    expect(result.messages![0]).toMatchObject({ from: 'claude', to: 'codex', fromNode: 'lane:claude', toNode: 'lane:codex',
      kind: 'status', at: '2026-11-18T12:00:01.000Z' });
    expect(buildMapMessages({ source: 'available', skipped: 0, matched: [msg('b', T0 + 1_000), msg('a', T0)] },
      { since: T0 - 1, limit: 1 }, NOW).messages).toHaveLength(1);
    expect(buildMapMessages({ source: 'unavailable', skipped: 3, matched: [] }, { since: T0 - 1 }, NOW))
      .toMatchObject({ messages: null, matched: null, skipped: 3 });
  });

  it('exposes scrubbed display text and never the raw envelope', () => {
    const root = store([[T0, 'comms', 'leader', { text: `${'message '.repeat(30)}password=fixture-password` }]]);
    const result = read(root);
    expect(result.matched).toBe(1);
    expect(result.messages![0]).toMatchObject({ from: 'comms', to: 'leader', fromNode: 'planner:comms', at: '2026-11-18T12:00:00.000Z' });
    expect(result.messages![0]!.text).toContain('message '.repeat(30));
    expect(JSON.stringify(result)).not.toContain('fixture-password');
  });

  it('an unreadable bus is unknown, not zero', () => {
    const root = store([[T0, 'claude', 'codex', 'hello']]);
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{broken');
    const result = read(root);
    expect(result).toMatchObject({ source: 'unavailable', messages: null, matched: null });
    expect(formatMapMessagesText(result)).toBe('Agent messages: unknown (the agent bus could not be read).');
    expect(mapMessagesResponse(MAP_MESSAGES_PATH, { root, now: () => NOW })).toEqual({ status: 503, body: result });
  });

  it('GET /api/fleet/map/messages serves the same read and rejects bad queries', async () => {
    const root = store([
      [T0, 'leader', 'claude', 'please look at the build'],
      [T0 + 1_000, 'claude', 'leader', 'on it?'],
      [T0 + 2_000, 'claude', 'codex', 'RQ-ONE-1 shipped the patch'],
    ]), options = { root, now: () => NOW };
    expect(mapMessagesResponse(MAP_MESSAGES_PATH, options)).toEqual({ status: 200, body: read(root) });
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?limit=1&since=1h`, options).body as MapMessages).messages).toHaveLength(1);
    const before = encodeURIComponent(new Date(T0 + 30_000).toISOString());
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?before=${before}`, options).body as MapMessages).matched).toBe(3);
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?kind=ask`, options).body as MapMessages).matched).toBe(1);
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?from=claude&contains=patch`, options).body as MapMessages).matched).toBe(1);
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?to=claude`, options).body as MapMessages).matched).toBe(1);
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?id=m1`, options).body as MapMessages).messages!.map(m => m.summary)).toEqual(['on it?']);
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?bodyKind=note`, options).body as MapMessages).matched).toBe(0);
    for (const query of ['since=soon', 'since=1m&since=2m', 'root=/tmp', 'limit=0', 'limit=101', 'limit=x', 'limit=1&limit=2',
      'before=soon', 'before=', 'before=1h&before=2h', 'since=1h&bogus=1', 'kind=bogus', 'channel=BAD!', 'with=codex',
      'id=has%20space', 'contains=', 'agent=', 'bodyKind=has%20space', 'to=has%20space']) {
      expect(mapMessagesResponse(`${MAP_MESSAGES_PATH}?${query}`, options).status).toBe(400);
    }
    const req = Object.assign(Readable.from([]) as IncomingMessage, { url: MAP_MESSAGES_PATH, method: 'GET', headers: {} });
    let status = 0, payload = '';
    const res = { writeHead(code: number) { status = code; }, end(text: string) { payload = text; } } as unknown as ServerResponse;
    await handleApi(req, res, {} as AshlrConfig, { token: 'map-messages-test', allowDispatch: false });
    expect(status).toBe(200);
    expect(Object.keys(JSON.parse(payload))).toEqual(KEYS);
  });

  it('phm fleet map messages prints fleet.map-messages.v1 and rejects bad usage', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(cmdFleetMapMessages(['--help'])).toBe(0);
    expect(out.mock.lastCall![0]).toContain('phm fleet map messages [--json]');
    expect(out.mock.lastCall![0]).toContain('--in-reply-to');
    for (const args of [['--since'], ['--json', '--json'], ['--since', 'soon'], ['--limit', '0'], ['--limit'], ['--apply'],
      ['--before'], ['--before', 'soon'], ['--before', '1h', '--before', '2h'], ['--kind'], ['--kind', 'bogus'],
      ['--with', 'codex'], ['--channel', 'BAD CHANNEL!'], ['--id', 'has space'], ['--from', 'a', '--from', 'b'],
      ['--agent', 'claude', '--agent', 'codex'], ['--contains', 'two', '--contains', 'words'], ['--job'],
      ['--body-kind'], ['--body-kind', 'has space'], ['--to', 'has space']]) {
      expect(cmdFleetMapMessages(args)).toBe(2);
    }
    expect(err).toHaveBeenCalledTimes(21);
    expect(cmdFleetMapMessages(['--json', '--limit', '5'])).toBe(0);
    expect(JSON.parse(out.mock.lastCall![0])).toMatchObject({ schema: 'fleet.map-messages.v1', version: 1 });
    expect(cmdFleetMapMessages(['--json', '--before', '1h'])).toBe(0);
    expect(cmdFleetMapMessages(['--json', '--kind', 'ask', '--from', 'claude', '--contains', 'docs',
      '--channel', 'build', '--in-reply-to', 'm1', '--id', 'm2', '--agent', 'claude', '--with', 'codex',
      '--exclude-from', 'leader', '--priority', 'P2', '--job', 'RQ-ONE-1', '--thread', 'build',
      '--body-kind', 'note', '--to', 'leader'])).toBe(0);
    expect(JSON.parse(out.mock.lastCall![0])).toMatchObject({ schema: 'fleet.map-messages.v1' });
    expect(await cmdFleetMessages(['--json', '--since', '1m', '--before', '2h'])).toBe(0);
    expect(JSON.parse(out.mock.lastCall![0])).toEqual([]);
    expect(await cmdFleetMessages(['--before', 'bad'])).toBe(2);
    expect(await cmdFleetMessages(['--since', 'bad'])).toBe(2);
    expect(await cmdFleetMessages(['--kind', 'bogus'])).toBe(2);
    expect(await cmdFleetMap(['messages', '--json', '--since', '1m'])).toBe(0);
    expect(Object.keys(JSON.parse(out.mock.lastCall![0]))).toEqual(KEYS);
  });
});
