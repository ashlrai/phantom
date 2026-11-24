/**
 * fleet_seat_handoffs: the fleet-wide bot-seat handoff plan over the
 * isolated fleet MCP server — the same planSeatHandoffs projection
 * `phm bots handoffs`, the unified inbox seats source and
 * `phm agents bus work mine`'s seats section share. fleet_agent_work
 * narrows it per agent and fleet_comms_inbox keeps only eligible seats
 * with pending records as inbox items; this is the whole-roster read, with
 * no arguments accepted and the plan's honesty passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, temp-home seat
 * fixtures; the real-projection test runs planSeatHandoffs against a temp
 * home, never the real `~/.phantom` or `~/.ashlr`.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetSeatHandoffsArgs, readFleetSeatHandoffs } from '../src/mcp/fleet-seat-handoffs.js';
import { planSeatHandoffs, type QuotaEvidence, type SeatHandoffsPlan } from '../src/core/bots/seats.js';
import { acquireCoordination } from '../src/core/agents/claim-store.js';

const connections: Client[] = [];
const homes: string[] = [];

const now = Date.parse('2026-11-18T12:00:00Z');
const iso = (n = now) => new Date(n).toISOString();
const unknownQuota: QuotaEvidence = { status: 'unknown', reason: 'missing-key', asOf: null };
const seat = () => ({
  id: 'helper', kind: 'devin-bot', displayName: 'Helper', participantId: 'helper',
  capabilities: ['code'], secretHandle: 'phm_devin_api_key', quota: { source: 'none' },
});
const plan = (over: Partial<SeatHandoffsPlan> = {}): SeatHandoffsPlan => ({
  schema: 'phantom-bot-handoffs-plan.v1', apply: false,
  seats: [{
    seatId: 'helper', participantId: 'helper', state: 'draining', eligible: true,
    handoffs: [{
      schema: 'phantom-bot-handoff.v1', handoffId: 'handoff-1', seatId: 'helper',
      work: { kind: 'bus-claim', ref: 'pr:o/r#20' }, done: 'done', left: 'left',
      branch: null, pr: 'o/r#20', createdAt: iso(),
    }],
  }],
  ...over,
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'fleet-seat-handoffs-'));
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
  const client = new Client({ name: 'seat-handoffs-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callSeatHandoffs(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_seat_handoffs', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_seat_handoffs argument parsing', () => {
  it('accepts only an empty argument object — every seat, fleet, runs and node root stays server-owned', () => {
    expect(parseFleetSeatHandoffsArgs({})).toEqual({});
  });

  it('rejects every key before any plan runs', () => {
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' },
      { seat: 'helper' }, { limit: 1 }, { extra: 1 }, { json: true }, { agent: 'x' },
    ]) expect(parseFleetSeatHandoffsArgs(bad)).toBeNull();
  });
});

describe('fleet_seat_handoffs reader', () => {
  it('runs the shared plan and spreads its seats beside the envelope', async () => {
    const seen: unknown[][] = [];
    const read = async () => {
      seen.push([]);
      return plan();
    };
    const result = await readFleetSeatHandoffs({ plan: read });
    expect(seen).toEqual([[]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'phantom-bot-handoffs-plan.v1', apply: false,
      seats: [{ seatId: 'helper', participantId: 'helper', state: 'draining', eligible: true }],
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((result.seats as SeatHandoffsPlan['seats'])[0]!.handoffs[0]!.work).toEqual({ kind: 'bus-claim', ref: 'pr:o/r#20' });
  });

  it('reports an unreadable plan as unavailable — never an invented empty roster', async () => {
    const result = await readFleetSeatHandoffs({
      plan: async () => { throw new Error('seat store unreadable'); },
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'unavailable', reason: 'seat-handoff-plan-unreadable',
    });
    expect('seats' in result).toBe(false);
  });

  it('serves the real planSeatHandoffs projection from a temp home, read-only', async () => {
    const { home, root } = await fixture();
    acquireCoordination({
      root: join(home, '.ashlr', 'fleet'), origin: 'resource', key: 'pr:o/r#20', owner: 'helper',
      sourceId: 'fleet-claim', leaseMs: 3_600_000, leaseUntil: now + 3_600_000, now,
    });
    await writeFile(join(root, 'seat-state.json'), JSON.stringify({
      helper: { state: 'draining', since: iso(), exhaustedReset: null },
    }));
    const result = await readFleetSeatHandoffs({
      plan: () => planSeatHandoffs({ home, now: () => now, readQuota: async () => unknownQuota }),
    });
    expect(result).toMatchObject({
      schema: 'phantom-bot-handoffs-plan.v1', apply: false,
      seats: [{ seatId: 'helper', participantId: 'helper', state: 'draining', eligible: true }],
    });
    const seats = (result as SeatHandoffsPlan).seats;
    expect(seats[0]!.handoffs).toHaveLength(1);
    expect(seats[0]!.handoffs[0]).toMatchObject({
      seatId: 'helper', work: { kind: 'bus-claim', ref: 'pr:o/r#20' },
    });
    expect(seats[0]!.handoffs[0]!.handoffId).toBeTruthy();
    // Read-only: the plan writes no journal, state file or release.
    expect((await readdir(root)).sort()).toEqual(['seat-state.json', 'seats.json']);
    expect(JSON.parse(await readFile(join(root, 'seat-state.json'), 'utf8'))).toEqual({
      helper: { state: 'draining', since: iso(), exhaustedReset: null },
    });
  });
});

describe('fleet_seat_handoffs MCP tool', () => {
  it('is advertised read-only beside the bus reads with an empty argument schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_seat_handoffs');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.description).toContain('planSeatHandoffs');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ home: '/tmp' }], [{ seat: 'helper' }], [{ limit: 5 }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const seatHandoffs = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), seatHandoffs });
    await expect(client.callTool({ name: 'fleet_seat_handoffs', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(seatHandoffs).not.toHaveBeenCalled();
  });

  it('calls the injected reader with no arguments and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...plan({ seats: [{ seatId: 'idler', participantId: 'idler', state: 'idle', eligible: false, handoffs: [] }] }),
    };
    const seatHandoffs = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), seatHandoffs });
    const { parsed } = await callSeatHandoffs(client, {});
    expect(seatHandoffs).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
    const seats = parsed.seats as SeatHandoffsPlan['seats'];
    expect(seats[0]).toMatchObject({ seatId: 'idler', state: 'idle', eligible: false, handoffs: [] });
  });

  it('accepts an omitted arguments object', async () => {
    const seatHandoffs = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), seatHandoffs });
    const { parsed } = await callSeatHandoffs(client);
    expect(seatHandoffs).toHaveBeenCalledWith();
    expect(parsed).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      seatHandoffs: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: 'fleet_seat_handoffs', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });
});
