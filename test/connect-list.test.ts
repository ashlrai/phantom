/**
 * `phm connect list` (phantom.connect.v1): fixture readers through the builder
 * and the CLI, the default readers on the relocated empty home, and the
 * GET /api/connect route. No real home, no network, no credential.
 */
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdConnect } from '../src/cli/connect.js';
import { CHANNELS_OVERVIEW_SCHEMA, type ChannelOverviewRow, type ChannelsOverview } from '../src/core/fleet/channels-schema.js';
import { buildConnectList, CONNECT_KINDS, CONNECT_SCHEMA, CONNECT_TOGGLE_PATH, type ConnectList, type ConnectReaders } from '../src/core/fleet/connect-list.js';
import type { InstalledPanel } from '../src/core/fleet/installed-panels.js';
import type { ToolMatrix } from '../src/core/fleet/tool-parity.js';
import type { WebServerHandle } from '../src/core/types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';
import { makeCfg } from './helpers/h1-fixture.js';

const NOW = new Date('2026-11-17T18:00:00.000Z');
const REVISION = 'a'.repeat(40);

const channel = (patch: Partial<ChannelOverviewRow> & Pick<ChannelOverviewRow, 'channel' | 'label'>): ChannelOverviewRow => ({
  state: 'connected', reason: null, lastInboundAt: '2026-11-17T17:00:00.000Z', lastOutboundAt: '2026-11-17T17:30:00.000Z',
  messages24h: 2, verifiedSenders: 1, address: null, next: null, ...patch,
});
const overview = (channels: ChannelOverviewRow[]): ChannelsOverview => ({
  schema: CHANNELS_OVERVIEW_SCHEMA, version: 1, at: NOW.toISOString(), counts: { connected: 0, 'not-set-up': 0, failing: 0, unknown: 0 }, channels,
});
const panel = (schema: InstalledPanel['schema'], items: InstalledPanel['items'], sources: InstalledPanel['sources'] = []): InstalledPanel =>
  ({ schema, observedAt: NOW.toISOString(), sources, items });
const matrix: ToolMatrix = {
  schema: 'tools.matrix.v1', parity: 'gaps', lanes: ['claude', 'codex'],
  rows: [
    { need: 'browser', kind: 'capability', label: 'Browser', cells: { claude: { value: 'yes', source: 'router' }, codex: { value: 'no', source: 'router' } } },
    { need: 'web-search', kind: 'capability', label: 'Web search', cells: { claude: { value: 'unknown', source: null }, codex: { value: 'no', source: 'router' } } },
    { need: 'shell', kind: 'capability', label: 'Shell', cells: { claude: { value: 'no', source: 'router' }, codex: { value: 'no', source: 'router' } } },
    { need: 'mcp:notes', kind: 'mcp', label: 'MCP server notes', cells: { claude: { value: 'yes', source: 'connectors' }, codex: { value: 'no', source: 'connectors' } } },
  ],
  scores: [], sources: [{ name: 'router', state: 'healthy' }],
  topGaps: [{ need: 'shell', label: 'Shell', state: 'missing', lanes: ['claude', 'codex'], fix: 'Give a lane a shell.' }],
} as unknown as ToolMatrix;

/** One of each kind, plus a broken item and an unknown item. */
const readers = (): ConnectReaders => ({
  channels: async () => ({ needSignIn: ['telegram'], overview: overview([
    channel({ channel: 'slack', label: 'Slack', state: 'failing', reason: 'bridge not running', next: 'start the bridge: `phm channels slack run`' }),
    channel({ channel: 'telegram', label: 'Telegram', state: 'not-set-up', lastInboundAt: null, lastOutboundAt: null, next: 'phm channels add telegram <chat-id>' }),
    channel({ channel: 'imessage', label: 'iMessage', state: 'unknown', reason: 'liveness unverifiable', lastInboundAt: 'unknown', lastOutboundAt: null }),
    channel({ channel: 'cli', label: 'Terminal' }),
  ]) }),
  gateway: async () => ({ revision: REVISION, connectors: [{ name: 'notes', enabled: true }, { name: 'maps', enabled: false }] }),
  profile: async () => [
    { id: 'files', availability: 'available', lanes: ['claude'], needsCredential: false },
    { id: 'mail', availability: 'available', lanes: ['codex'], needsCredential: true },
    { id: 'gone', availability: 'unavailable', lanes: [], needsCredential: false },
  ],
  plugins: () => panel('fleet.plugins-panel.v1', [
    { name: 'scanner', source: 'Phantom', agents: 'Any agent that runs phm on this machine', enabled: false, lastUsed: 'unknown' },
    { name: 'bad', source: 'Phantom', agents: 'None (invalid manifest)', enabled: false, lastUsed: 'unknown' },
    { name: 'review', source: 'Claude Code (shop)', agents: 'Claude lanes', enabled: 'unknown', lastUsed: 'unknown' },
  ]),
  skills: () => panel('fleet.skills-panel.v1', [{ name: 'commit', source: 'Claude Code', agents: 'Claude lanes', enabled: true, lastUsed: 'unknown' }]),
  tools: async () => matrix,
  registry: async () => [{ id: 'greet', status: 'active', lanes: [] }, { id: 'old', status: 'revoked', lanes: ['codex'] }],
});

afterEach(() => { vi.restoreAllMocks(); });

describe('buildConnectList', () => {
  it('returns one typed row per item with a stable schema and version', async () => {
    const list = await buildConnectList({ readers: readers(), now: () => NOW });
    expect(Object.keys(list)).toEqual(['schema', 'version', 'at', 'kind', 'counts', 'unread', 'rows']);
    expect(list).toMatchObject({ schema: CONNECT_SCHEMA, version: 1, at: NOW.toISOString(), kind: null, unread: [] });
    for (const row of list.rows) expect(Object.keys(row)).toEqual(['id', 'name', 'kind', 'source', 'state', 'lastUsed', 'users', 'needsSignIn', 'next', 'toggle']);
    expect(new Set(list.rows.map(row => row.id)).size).toBe(list.rows.length);
    // By kind, then broken, unknown, off, on.
    expect(list.rows.map(row => `${row.kind} ${row.name} ${row.state}`)).toEqual([
      'channel Slack broken', 'channel iMessage unknown', 'channel Telegram off', 'channel Terminal on',
      'connector gone broken', 'connector mail unknown', 'connector maps off', 'connector files on', 'connector notes on',
      'plugin bad broken', 'plugin review unknown', 'plugin scanner off',
      'skill commit on',
      'tool Web search unknown', 'tool old off', 'tool Shell off', 'tool Browser on', 'tool greet on',
    ]);
    expect(list.counts).toEqual({ on: 6, off: 5, broken: 3, unknown: 4 });
  });

  it('gives last used, who uses it and a next step only when not on', async () => {
    const { rows } = await buildConnectList({ readers: readers(), now: () => NOW });
    const row = (name: string) => rows.find(r => r.name === name)!;
    expect(row('Terminal')).toMatchObject({ lastUsed: '2026-11-17T17:30:00.000Z', users: ['Owner', 'Leader'], next: null, needsSignIn: false });
    expect(row('Telegram')).toMatchObject({ lastUsed: null, needsSignIn: true, next: 'phm channels add telegram <chat-id>' });
    expect(row('iMessage')).toMatchObject({ lastUsed: 'unknown', next: 'liveness unverifiable' });
    expect(row('Slack').next).toBe('start the bridge: `phm channels slack run`');
    expect(row('Browser')).toMatchObject({ users: ['claude'], next: null, lastUsed: 'unknown' });
    expect(row('Shell')).toMatchObject({ users: [], next: 'Give a lane a shell.' });
    expect(row('greet').users).toEqual(['Any lane']);
    expect(row('scanner').next).toBe('Run `phm plugins enable scanner`.');
    expect(row('bad')).toMatchObject({ users: [], next: 'Fix its manifest.json, or remove the plugin folder.' });
    expect(rows.every(r => (r.next === null) === (r.state === 'on'))).toBe(true);
  });

  it('offers a toggle only where the enable/disable route exists, and only says "needs sign-in" for credentials', async () => {
    const { rows } = await buildConnectList({ readers: readers(), now: () => NOW });
    expect(rows.filter(r => r.toggle).map(r => r.name)).toEqual(['maps', 'notes']);
    expect(rows.find(r => r.name === 'maps')!.toggle).toEqual({ path: CONNECT_TOGGLE_PATH, revision: REVISION });
    const mail = rows.find(r => r.name === 'mail')!;
    expect(mail).toMatchObject({ state: 'unknown', needsSignIn: true, toggle: null });
    expect(mail.next).toContain('Sign-in is not checked here');
  });

  it('filters by kind and reads only that kind', async () => {
    const all = readers();
    const tools = vi.fn(all.tools);
    const list = await buildConnectList({ kind: 'plugin', readers: { ...all, tools }, now: () => NOW });
    expect(list.kind).toBe('plugin');
    expect(list.rows.map(r => r.kind)).toEqual(['plugin', 'plugin', 'plugin']);
    expect(tools).not.toHaveBeenCalled();
  });

  it('keeps going when a source fails: the kind is unread, not empty', async () => {
    const list = await buildConnectList({ now: () => NOW, readers: {
      ...readers(),
      gateway: async () => { throw new Error('unreadable'); },
      tools: async () => null,
      skills: () => panel('fleet.skills-panel.v1', [], [{ source: 'Codex', state: 'unknown', count: 0 }]),
    } });
    expect(list.unread).toEqual(['connector', 'skill', 'tool']);
    expect(list.rows.filter(r => r.kind === 'connector').map(r => r.name)).toEqual(['gone', 'mail', 'files']);
    expect(list.rows.filter(r => r.kind === 'tool').map(r => r.name)).toEqual(['old', 'greet']);
  });

  it('reads the relocated empty home without throwing', async () => {
    const list = await buildConnectList();
    expect(list).toMatchObject({ schema: CONNECT_SCHEMA, version: 1 });
    expect(list.rows.filter(r => r.kind === 'channel').length).toBeGreaterThan(0);
    expect(list.rows.filter(r => r.toggle)).toEqual([]);
  });
});

describe('phm connect list', () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { out.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => { out.push(String(line)); });
    return { code: await cmdConnect(args, readers()), out: out.join('\n') };
  };

  it('--json prints phantom.connect.v1', async () => {
    const { code, out } = await run(['list', '--json']);
    expect(code).toBe(0);
    const list = JSON.parse(out) as ConnectList;
    expect(list).toMatchObject({ schema: CONNECT_SCHEMA, version: 1 });
    expect(new Set(list.rows.map(r => r.kind))).toEqual(new Set(CONNECT_KINDS));
  });

  it('--kind narrows the list', async () => {
    const { out } = await run(['list', '--kind', 'skill', '--json']);
    expect((JSON.parse(out) as ConnectList).rows.map(r => r.name)).toEqual(['commit']);
  });

  it('prints plain words grouped by kind', async () => {
    const { code, out } = await run(['list']);
    expect(code).toBe(0);
    expect(out.split('\n')[0]).toBe('Connect: 6 on · 5 off · 3 broken · 4 unknown.');
    for (const heading of ['Channels', 'Connectors', 'Plugins', 'Skills', 'Tools']) expect(out).toContain(`\n${heading}\n`);
    expect(out).toMatch(/ {2}unknown {2}mail {2}\[Connector profile\] {2}used by: codex {2}last used: unknown {2}needs sign-in/);
    expect(out).toContain('next: Run phm plugins enable scanner.');
  });

  it('exits 2 on a bad kind or flag and 0 on --help', async () => {
    expect((await run(['list', '--kind', 'gadget'])).code).toBe(2);
    expect((await run(['list', '--bogus'])).code).toBe(2);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('phm connect list [--json] [--kind channel|connector|plugin|skill|tool]');
  });
});

describe('GET /api/connect', () => {
  const servers: WebServerHandle[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
  const get = (h: WebServerHandle, path: string, auth = true) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: h.port, path, method: 'GET', headers: { Host: `127.0.0.1:${h.port}`, ...(auth ? readAuthHeaders(h.port) : {}) } }, (res) => {
      let out = ''; res.setEncoding('utf8');
      res.on('data', (c: string) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: out }));
    });
    req.on('error', reject);
    req.end();
  });

  it('serves the same schema as the CLI, filters by kind and refuses a bad kind', async () => {
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    servers.push(h);
    const all = await get(h, '/api/connect');
    expect(all.status).toBe(200);
    const list = JSON.parse(all.body) as ConnectList;
    expect(list).toMatchObject({ schema: CONNECT_SCHEMA, version: 1, kind: null });
    expect(Object.keys(list.counts)).toEqual(['on', 'off', 'broken', 'unknown']);

    const channels = JSON.parse((await get(h, '/api/connect?kind=channel')).body) as ConnectList;
    expect(channels.kind).toBe('channel');
    expect(channels.rows.length).toBeGreaterThan(0);
    expect(channels.rows.every(r => r.kind === 'channel')).toBe(true);

    expect((await get(h, '/api/connect?kind=gadget')).status).toBe(400);
    expect((await get(h, '/api/connect', false)).status).toBe(401);
  });
});
