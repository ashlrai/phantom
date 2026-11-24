/**
 * fleet_comms_health: the comms transport health read over the isolated
 * fleet MCP server — the same readTelegramHealth projection `phm comms
 * health --json` serves: Telegram poller liveness, last poll/success,
 * last update id, bot-token presence (a boolean, never the value) and
 * the Leader tick state. fleet_channels_overview reports each channel's
 * configured/connected row and fleet_comms_status the owner-thread
 * adapters' rollup; neither answers "is the poller actually polling"
 * in one call.
 *
 * Hermetic: injected readers and configs, in-memory MCP transports, and
 * crafted comms-state files under temp homes — never the real home,
 * config, telegram stores or leader tick file.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetCommsHealthArgs, readFleetCommsHealth } from '../src/mcp/fleet-comms-health.js';
import type { AshlrConfig } from '../src/core/types.js';

const connections: Client[] = [];
const roots: string[] = [];
const homes: string[] = [];
const TOOL = 'fleet_comms_health';
const savedHome = process.env['HOME'];
const savedToken = process.env['TELEGRAM_BOT_TOKEN'];

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
  if (savedToken === undefined) delete process.env['TELEGRAM_BOT_TOKEN']; else process.env['TELEGRAM_BOT_TOKEN'] = savedToken;
});

/** A temp home the health projection reads through the relocated homedir(). */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-comms-health-'));
  homes.push(dir);
  process.env['HOME'] = dir;
  return dir;
}

const cfg = (over: Record<string, unknown> = {}): AshlrConfig => ({
  comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fixture-token', chatId: '7' }, ...over },
} as AshlrConfig);

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'comms-health-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: TOOL, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_comms_health argument parsing', () => {
  it('accepts only an empty argument object — every store root stays server-owned', () => {
    expect(parseFleetCommsHealthArgs({})).toEqual({});
  });

  it('rejects every key before any read runs', () => {
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' },
      { runsDir: '/tmp/x' }, { configDir: '/tmp/x' }, { limit: 1 }, { extra: 1 }, { json: true },
    ]) expect(parseFleetCommsHealthArgs(bad)).toBeNull();
  });
});

describe('fleet_comms_health reader', () => {
  it('spreads the shared projection beside the envelope metadata', async () => {
    const health = {
      lastPoll: '2026-11-22T12:00:00.000Z', lastSuccess: '2026-11-22T11:59:00.000Z',
      error: null, leaderTick: 'completed' as const, pollerAlive: true,
      lastUpdateId: 41, tokenPresent: true,
    };
    const seen: AshlrConfig[] = [];
    const result = await readFleetCommsHealth({
      cfg: () => { const c = cfg(); seen.push(c); return c; },
      health: c => { expect(c).toBe(seen[0]); return health; },
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      ...health,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads the real projection: health file, offset and leader tick under the process home', async () => {
    const dir = home();
    const commsDir = join(dir, '.ashlr', 'comms');
    mkdirSync(commsDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(join(commsDir, 'telegram-health.json'),
      JSON.stringify({ lastPoll: now, lastSuccess: now, error: null }));
    writeFileSync(join(commsDir, 'telegram-offset'), '42');
    const leaderDir = join(dir, '.ashlr', 'vision', 'leader');
    mkdirSync(leaderDir, { recursive: true });
    writeFileSync(join(leaderDir, '.wake-result.json'), JSON.stringify({ status: 'completed' }));
    delete process.env['TELEGRAM_BOT_TOKEN'];

    const result = await readFleetCommsHealth({ cfg: () => cfg() });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      lastPoll: now, lastSuccess: now, error: null,
      pollerAlive: true, lastUpdateId: 41, tokenPresent: true, leaderTick: 'completed',
    });
  });

  it('reports never-polled honestly: null timestamps, dead poller, no invented health', async () => {
    home();
    delete process.env['TELEGRAM_BOT_TOKEN'];
    const result = await readFleetCommsHealth({ cfg: () => ({ comms: {} }) as AshlrConfig });
    expect(result).toMatchObject({
      lastPoll: null, lastSuccess: null, error: expect.any(String),
      pollerAlive: false, lastUpdateId: null, tokenPresent: false, leaderTick: 'never',
    });
    expect((result as { error: string }).error).toContain('operator input disabled');
  });

  it('fails closed on reader failures without returning raw exceptions', async () => {
    const report = await readFleetCommsHealth({
      cfg: () => cfg(),
      health: () => { throw new Error('fake private exception /secret/path'); },
    });
    expect(report).toMatchObject({ status: 'unavailable', reason: 'comms-health-unreadable' });
    expect(JSON.stringify(report)).not.toContain('fake private exception');
    expect(JSON.stringify(report)).not.toContain('/secret/path');
  });
});

describe('fleet_comms_health over MCP', () => {
  it('is advertised in tools/list order and serves the injected read', async () => {
    expect(FLEET_MCP_TOOL_NAMES).toContain(TOOL);
    const health = {
      lastPoll: null, lastSuccess: null, error: 'poll failed; inspect value-free poll log',
      leaderTick: 'failed' as const, pollerAlive: false, lastUpdateId: null, tokenPresent: false,
    };
    const client = await connect({ commsHealth: () => readFleetCommsHealth({ cfg: () => cfg(), health: () => health }) });
    const tools = (await client.listTools()).tools;
    const tool = tools.find(entry => entry.name === TOOL);
    expect(tool?.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    const { parsed } = await call(client, {});
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.snapshotKind).toBe('local-persisted');
    expect(parsed.authority).toBe('none');
    expect(parsed).toMatchObject(health);
    expect(typeof parsed.generatedAt).toBe('string');
    await expect(call(client, { runsDir: '/tmp/x' })).rejects.toThrow();
  });

  it('surfaces a throwing read as a tool error, never raw exception text', async () => {
    const client = await connect({ commsHealth: async () => { throw new Error('secret-shaped detail /tmp/x'); } });
    const result = await client.callTool({ name: TOOL, arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_comms_health` \|/m);
  });
});
