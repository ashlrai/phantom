/**
 * fleet_bot_seats: the bot-seat roster over the isolated fleet MCP server —
 * readBotSeats, the same seat-view projection `phm bots seats --json`
 * serves minus its persist-on-read lifecycle write. fleet_seat_handoffs
 * reports only the handoff plan and fleet_agent_work narrows it per agent;
 * this is the whole-roster quota/lifecycle/open-work read, with no
 * arguments accepted, secret handles and adapter internals stripped, and
 * the non-persisting contract proven against a temp home.
 *
 * Hermetic: injected readers, in-memory MCP transports, temp-home seat
 * fixtures; the real-projection test runs readBotSeats against a temp
 * home, never the real `~/.phantom` or `~/.ashlr`.
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetBotSeatsArgs, readFleetBotSeats, type FleetBotSeatEntry } from '../src/mcp/fleet-bot-seats.js';
import { readBotSeats, type BotSeatsRoster, type QuotaEvidence } from '../src/core/bots/seats.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';

const connections: Client[] = [];
const homes: string[] = [];

const now = Date.parse('2026-11-18T12:00:00Z');
const iso = (n = now) => new Date(n).toISOString();
const unknownQuota: QuotaEvidence = { status: 'unknown', reason: 'missing-key', asOf: null };
const measuredQuota: QuotaEvidence = { status: 'measured', usedPct: 42, resetAt: null, asOf: iso(), source: 'devin-api-v3-org-cycle' };
const exhaustedQuota: QuotaEvidence = { status: 'exhausted', usedPct: 100, resetAt: iso(now + 86_400_000), asOf: iso(), source: 'devin-api-v3-org-cycle' };
const seat = (over: Record<string, unknown> = {}) => ({
  id: 'helper', kind: 'devin-bot', displayName: 'Helper', participantId: 'helper',
  capabilities: ['code'], secretHandle: 'phm_devin_api_key', quota: { source: 'none' },
  ...over,
});
const roster = (over: Partial<BotSeatsRoster> = {}): BotSeatsRoster => ({
  schema: 'phantom-bot-seats.v1',
  seats: [{
    id: 'helper', kind: 'devin-bot', displayName: 'Helper', capabilities: ['code'],
    participantId: 'helper', provider: 'devin', nodeId: undefined, secretHandle: 'phm_devin_api_key',
    quota: { source: 'none' },
    participant: { participantId: 'helper', provider: 'devin', displayName: 'Helper', capabilities: ['code'], wake: { kind: 'poll', target: 'helper' }, status: 'active' },
    state: 'active', acceptsNewWork: false, quota: unknownQuota,
    claims: [], inFlight: [], handoffs: [], adapter: { status: 'unknown', reason: 'no-documented-bot-messaging-api' },
  } as unknown as BotSeatsRoster['seats'][number]],
  ...over,
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'fleet-bot-seats-'));
  homes.push(home);
  const root = join(home, '.phantom', 'bots');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'seats.json'), JSON.stringify({ schema: 'phantom-bot-seats.v1', seats: [seat()] }));
  return { home, root };
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function connect(readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'bot-seats-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callBotSeats(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bot_seats', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bot_seats argument parsing', () => {
  it('accepts only an empty argument object — every seat, fleet, runs and node root stays server-owned', () => {
    expect(parseFleetBotSeatsArgs({})).toEqual({});
  });

  it('rejects every key before any roster read runs', () => {
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' },
      { seat: 'helper' }, { limit: 1 }, { extra: 1 }, { json: true }, { agent: 'x' },
    ]) expect(parseFleetBotSeatsArgs(bad)).toBeNull();
  });
});

describe('fleet_bot_seats reader', () => {
  it('runs the shared roster read and strips secret handles and adapter internals', async () => {
    const seen: unknown[][] = [];
    const read = async () => {
      seen.push([]);
      return roster();
    };
    const result = await readFleetBotSeats({ seats: read });
    expect(seen).toEqual([[]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'phantom-bot-seats.v1', persisted: false,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const seats = result.seats as FleetBotSeatEntry[];
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({
      id: 'helper', participantId: 'helper', state: 'active', acceptsNewWork: false,
      quota: { status: 'unknown', reason: 'missing-key' },
    });
    expect('secretHandle' in seats[0]!).toBe(false);
    expect('adapter' in seats[0]!).toBe(false);
  });

  it('reports an unreadable roster as unavailable — never an invented empty roster', async () => {
    const result = await readFleetBotSeats({
      seats: async () => { throw new Error('seat store unreadable'); },
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'unavailable', reason: 'bot-seat-roster-unreadable',
    });
    expect('seats' in result).toBe(false);
  });

  it('serves the real readBotSeats projection from a temp home without persisting lifecycle state', async () => {
    const { home, root } = await fixture();
    acquireCoordination({
      root: join(home, '.ashlr', 'fleet'), origin: 'resource', key: 'pr:o/r#20', owner: 'helper',
      sourceId: 'fleet-claim', leaseMs: 3_600_000, leaseUntil: now + 3_600_000, now,
    });
    const result = await readFleetBotSeats({
      seats: () => readBotSeats({
        home, now: () => now,
        readQuota: async seat => seat.id === 'helper' ? exhaustedQuota : measuredQuota,
      }),
    });
    expect(result).toMatchObject({ schema: 'phantom-bot-seats.v1', persisted: false });
    const seats = (result as { seats: FleetBotSeatEntry[] }).seats;
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({
      id: 'helper', participantId: 'helper',
      state: 'draining', acceptsNewWork: false,
      quota: { status: 'exhausted', usedPct: 100 },
    });
    expect(seats[0]!.claims).toHaveLength(1);
    expect((seats[0]!.claims as Array<{ key: string }>)[0]!.key).toBe('pr:o/r#20');
    expect('secretHandle' in seats[0]!).toBe(false);
    expect('adapter' in seats[0]!).toBe(false);
    // Non-persisting: the projected draining transition `phm bots seats`
    // would write to seat-state.json never lands — the file stays absent.
    expect((await readdir(root)).sort()).toEqual(['seats.json']);
  });

  it('keeps unknown quota evidence unknown — never an invented measured zero', async () => {
    const { home } = await fixture();
    const result = await readFleetBotSeats({
      seats: () => readBotSeats({ home, now: () => now, readQuota: async () => unknownQuota }),
    });
    const seats = (result as { seats: FleetBotSeatEntry[] }).seats;
    expect(seats[0]).toMatchObject({
      state: 'active', acceptsNewWork: false,
      quota: { status: 'unknown', reason: 'missing-key', asOf: null },
    });
  });
});

describe('fleet_bot_seats MCP tool', () => {
  it('is advertised read-only beside the seat reads with an empty argument schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bot_seats');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.description).toContain('readBotSeats');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ home: '/tmp' }], [{ seat: 'helper' }], [{ limit: 5 }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const botSeats = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), botSeats });
    await expect(client.callTool({ name: 'fleet_bot_seats', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(botSeats).not.toHaveBeenCalled();
  });

  it('calls the injected reader with no arguments and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'phantom-bot-seats.v1', persisted: false,
      seats: [{ id: 'idler', kind: 'local', displayName: 'Idler', capabilities: [], participantId: 'idler', provider: 'local', state: 'idle', acceptsNewWork: false, quota: unknownQuota, claims: [], inFlight: [], handoffs: [], participant: { participantId: 'idler', provider: 'local', displayName: 'Idler', capabilities: [], wake: { kind: 'poll', target: 'idler' }, status: 'idle' } }],
    };
    const botSeats = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), botSeats });
    const { parsed } = await callBotSeats(client, {});
    expect(botSeats).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
    const seats = parsed.seats as FleetBotSeatEntry[];
    expect(seats[0]).toMatchObject({ id: 'idler', state: 'idle', acceptsNewWork: false });
  });

  it('accepts an omitted arguments object', async () => {
    const botSeats = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), botSeats });
    const { parsed } = await callBotSeats(client);
    expect(botSeats).toHaveBeenCalledWith();
    expect(parsed).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      botSeats: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: 'fleet_bot_seats', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });
});
