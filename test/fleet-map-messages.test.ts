import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { cmdFleetMap } from '../src/cli/fleet-map.js';
import { cmdFleetMapMessages } from '../src/cli/fleet-map-messages.js';
import type { AshlrConfig } from '../src/core/config.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { formatMapMessagesText, MAP_MESSAGES_PATH, mapMessagesResponse, readMapMessages } from '../src/core/fleet/map-messages.js';
import { handleApi } from '../src/core/web/api.js';

const T0 = Date.UTC(2026, 10, 18, 12, 0, 0), NOW = T0 + 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function store(messages: [at: number, from: string, to: string, text: string][] = []) {
  const root = mkdtempSync(join(tmpdir(), 'map-messages-'));
  roots.push(root);
  messages.forEach(([at, from, to, text], i) => expect(appendBusInbox({ id: `m${i}`, from, to, priority: 'P2', ttl: 86_400_000, body: { text } },
    { root, now: () => at }).status).toBe('posted'));
  return root;
}
const KEYS = ['schema', 'version', 'generatedAt', 'since', 'source', 'messages', 'matched', 'skipped'];

describe('fleet map messages', () => {
  it('empty bus: no messages, stable schema and key order', () => {
    const none = readMapMessages(undefined, { root: store(), now: () => NOW })!;
    expect(none).toEqual({ schema: 'fleet.map-messages.v1', version: 1, generatedAt: '2026-11-18T12:01:00.000Z', since: '2026-11-18T11:46:00.000Z',
      source: 'missing', messages: [], matched: 0, skipped: 0 });
    expect(Object.keys(none)).toEqual(KEYS);
    expect(formatMapMessagesText(none)).toBe('0 agent messages since 2026-11-18 11:46 UTC.');
    expect(readMapMessages('soon', { root: store() })).toBeNull();
  });

  it('lists newest first with from, to, kind, summary and time; an unknown agent has no map node', () => {
    const root = store([[T0, 'leader', 'claude', 'please start the docs job'], [T0 + 1_000, 'claude', 'mystery-agent', 'is the docs job ready?'],
      [T0 + 2_000, 'claude', 'claude', 'note to self'], [T0 - 3_600_000, 'claude', 'codex', 'too old']]);
    const read = readMapMessages(undefined, { root, now: () => NOW })!;
    expect(read.matched).toBe(2);
    expect(read.messages!.map(m => [m.from, m.to, m.fromNode, m.toNode, m.kind, m.summary, m.at])).toEqual([
      ['claude', 'mystery-agent', 'lane:claude', null, 'ask', 'is the docs job ready?', '2026-11-18T12:00:01.000Z'],
      ['leader', 'claude', 'leader', 'lane:claude', 'status', 'please start the docs job', '2026-11-18T12:00:00.000Z']]);
    expect(readMapMessages(undefined, { root, now: () => NOW, limit: 1 })!.messages).toHaveLength(1);
    expect(formatMapMessagesText(read).split('\n')[1]).toBe('12:00:01Z claude -> mystery-agent (ask): is the docs job ready?');
  });

  it('sends every summary through the redaction helper and keeps it short', () => {
    const root = store([[T0, 'claude', 'codex', `${'word '.repeat(60)}secret-plan`]]);
    const redact = vi.fn((text: string) => text.replace('secret-plan', '[hidden]'));
    const read = readMapMessages(undefined, { root, now: () => NOW, redact })!;
    expect(redact).toHaveBeenCalledTimes(1);
    expect(read.messages![0]!.summary.length).toBeLessThanOrEqual(80);
    const short = readMapMessages(undefined, { root: store([[T0, 'claude', 'codex', 'see secret-plan now']]), now: () => NOW, redact })!;
    expect(short.messages![0]!.summary).toBe('see [hidden] now');
  });

  it('an unreadable bus is unknown, not zero', () => {
    const root = store([[T0, 'claude', 'codex', 'hello']]);
    writeFileSync(join(root, 'bus-inbox', 'messages.json'), '{broken');
    const read = readMapMessages(undefined, { root, now: () => NOW })!;
    expect(read).toMatchObject({ source: 'unavailable', messages: null, matched: null });
    expect(formatMapMessagesText(read)).toBe('Agent messages: unknown (the agent bus could not be read).');
    expect(mapMessagesResponse(MAP_MESSAGES_PATH, { root, now: () => NOW })).toEqual({ status: 503, body: read });
  });

  it('GET /api/fleet/map/messages serves the same read and rejects bad queries', async () => {
    const root = store([[T0, 'claude', 'codex', 'hello']]), options = { root, now: () => NOW };
    expect(mapMessagesResponse(MAP_MESSAGES_PATH, options)).toEqual({ status: 200, body: readMapMessages(undefined, options) });
    expect((mapMessagesResponse(`${MAP_MESSAGES_PATH}?limit=1&since=1h`, options).body as { messages: unknown[] }).messages).toHaveLength(1);
    for (const query of ['since=soon', 'since=1m&since=2m', 'root=/tmp', 'limit=0', 'limit=101', 'limit=x', 'limit=1&limit=2']) {
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
    for (const args of [['--since'], ['--json', '--json'], ['--since', 'soon'], ['--limit', '0'], ['--limit'], ['--apply']]) expect(cmdFleetMapMessages(args)).toBe(2);
    expect(err).toHaveBeenCalledTimes(6);
    expect(cmdFleetMapMessages(['--json', '--limit', '5'])).toBe(0);
    expect(JSON.parse(out.mock.lastCall![0])).toMatchObject({ schema: 'fleet.map-messages.v1', version: 1 });
    expect(await cmdFleetMap(['messages', '--json', '--since', '1m'])).toBe(0);
    expect(Object.keys(JSON.parse(out.mock.lastCall![0]))).toEqual(KEYS);
  });
});
