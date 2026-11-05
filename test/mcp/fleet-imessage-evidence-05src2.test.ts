/**
 * RQ-PHX-MCPIMESSAGEEVIDENCE05SRC2 — fleet_imessage_path and
 * fleet_imessage_acks: read-only iMessage path diagnosis and bounded
 * acknowledgement evidence through the isolated fleet MCP server, so a
 * shell-free Comms agent can diagnose the local iMessage leg without claiming
 * Dot transport or delivery. Both delegate to the shared collectors
 * checkIMessagePath and readImessageAckEvidence at the server-owned runs dir —
 * never a second classifier or reader.
 *
 * Hermetic: temp-dir runs roots, fake ack rows and handles, in-memory MCP
 * transports and injected readers; no daemon, transport, Messages or
 * provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  MAX_FLEET_IMESSAGE_ACKS, parseFleetImessageAcksArgs, parseFleetImessagePathArgs,
  readFleetImessageAcks, readFleetImessagePath,
  type FleetImessageAcksDeps, type FleetImessagePathDeps,
} from '../../src/mcp/fleet-imessage-evidence.js';
import { checkIMessagePath } from '../../src/core/comms/imessage-path-check.js';
import type { AshlrConfig } from '../../src/core/types.js';

const connections: Client[] = [];
let root: string;

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-imessage-evidence-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function connect(
  readers: Partial<Pick<FleetReaders, 'imessagePath' | 'imessageAcks'>> = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'imessage-evidence-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

/** The real adapters through the real server, pointed at the temp runs dir. */
function realPathReader(deps: FleetImessagePathDeps = {}): FleetReaders['imessagePath'] {
  return async () => readFleetImessagePath({ runsDir: root, ...deps });
}
function realAcksReader(deps: FleetImessageAcksDeps = {}): FleetReaders['imessageAcks'] {
  return async input => readFleetImessageAcks(input, { runsDir: root, ...deps });
}

const PATH_COVERAGE = 'local-evidence-only-owner-transport-no-collaborator-delivery';
const ACKS_COVERAGE = 'local-evidence-only-recorded-acks-never-sent-or-delivered';
const cfg = (enabled: boolean) => ({ comms: { enabled, imessageHandle: 'fake-private-handle' } }) as AshlrConfig;

function imessageDir(): string {
  const dir = join(root, 'imessage');
  mkdirSync(dir, { recursive: true });
  return dir;
}
const row = (rowid: number, extra: object = {}) =>
  JSON.stringify({ at: '2026-01-02T03:04:05.000Z', rowid, status: 'accepted', delivery: 'recorded-not-sent', ...extra });
function writeAcks(text: string): string {
  const file = join(imessageDir(), 'acks.jsonl');
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** relpath → kind+content hash over the whole runs root; proves read-only. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const rel = path.slice(dir.length + 1);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out[rel] = `link:${readlinkSync(path)}`;
      else if (stat.isDirectory()) { out[`${rel}/`] = 'dir'; walk(path); }
      else out[rel] = `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

describe('fleet_imessage_path over MCP', () => {
  it('is advertised read-only with an empty argument object', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_imessage_path');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('invokes the injected reader through the protocol', async () => {
    const reader = vi.fn(async () => ({ seen: true }));
    const client = await connect({ imessagePath: reader });
    expect(parse(await client.callTool({ name: 'fleet_imessage_path' }))).toEqual({ seen: true });
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('delegates to the shared collector at the server-owned root and keeps owner-only truths', async () => {
    const seen: Array<string | undefined> = [];
    const client = await connect({ imessagePath: realPathReader({
      check: deps => {
        seen.push(deps.runsRoot);
        return checkIMessagePath({ ...deps, platform: 'darwin', config: () => cfg(true), probe: () => 'ok', cursor: () => 7 });
      },
    }) });
    const out = parse(await client.callTool({ name: 'fleet_imessage_path' }));
    expect(seen).toEqual([root]);
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', sourceState: 'ok', coverage: PATH_COVERAGE });
    expect(out.pathEvidence).toMatchObject({
      schema: 'fleet.imessage-path.v1',
      platform: { state: 'supported' },
      configuration: { state: 'configured' },
      chatDb: { state: 'readable' },
      cursor: { state: 'present' },
      transport: { state: 'owner_only', reason: 'SELF_ONLY_TRANSPORT' },
      ownerReply: { state: 'unknown' },
      collaboratorIntake: { state: 'unsupported', reason: 'VERIFIED_OWNER_ONLY' },
      collaboratorDelivery: { state: 'unsupported', reason: 'SELF_ONLY_TRANSPORT' },
    });
    expect(JSON.stringify(out)).not.toContain('fake-private-handle');
  });

  it('runs the real collector defaults at the server-owned root', async () => {
    writeFileSync(join(imessageDir(), 'cursor.json'), JSON.stringify({ version: 1, rowid: 42 }), { mode: 0o600 });
    const client = await connect({ imessagePath: realPathReader() });
    const out = parse(await client.callTool({ name: 'fleet_imessage_path' }));
    expect(out).toMatchObject({ sourceState: 'ok', coverage: PATH_COVERAGE });
    expect(out.pathEvidence).toMatchObject({
      schema: 'fleet.imessage-path.v1',
      cursor: { state: 'present', reason: 'CURSOR_BASELINE_PRESENT' },
      transport: { state: 'owner_only' },
      collaboratorIntake: { state: 'unsupported' },
      collaboratorDelivery: { state: 'unsupported' },
    });
  });

  it.each([
    { dir: '/tmp/fake' }, { root: '/tmp' }, { cwd: '/tmp' }, { path: '/tmp' }, { runsDir: '/tmp' },
    { config: {} }, { probe: 'chatdb' }, { send: true }, { poll: true }, { confirmedByMason: true },
    { limit: 5 }, { x: 1 },
  ])('rejects arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect({ imessagePath: reader });
    await expect(client.callTool({ name: 'fleet_imessage_path', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a throwing collector as fixed unavailable evidence, never invented states', async () => {
    const client = await connect({ imessagePath: realPathReader({
      check: () => { throw new Error('private-collector-detail'); },
    }) });
    const result = await client.callTool({ name: 'fleet_imessage_path' });
    expect(result.isError).not.toBe(true);
    expect(parse(result)).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState: 'unavailable', coverage: PATH_COVERAGE, pathEvidence: null,
    });
    expect(JSON.stringify(result)).not.toContain('private-collector-detail');
  });

  it('returns a generic tool error when the reader itself throws', async () => {
    const client = await connect({ imessagePath: async () => { throw new Error('private-source-value'); } });
    const result = await client.callTool({ name: 'fleet_imessage_path' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it('parseFleetImessagePathArgs accepts only the empty object', () => {
    expect(parseFleetImessagePathArgs({})).toEqual({});
    for (const args of [
      { x: 1 }, { dir: '/tmp/x' }, { runsDir: '/tmp' }, { send: true }, { limit: 1 }, { config: null },
    ]) expect(parseFleetImessagePathArgs(args)).toBeNull();
  });
});

describe('fleet_imessage_acks over MCP', () => {
  it('is advertised read-only with a bounded integer limit', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_imessage_acks');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_FLEET_IMESSAGE_ACKS, default: 20 } },
      additionalProperties: false,
    });
  });

  it('dispatches the default and explicit limit to the injected reader', async () => {
    const reader = vi.fn(async (input: unknown) => ({ input }));
    const client = await connect({ imessageAcks: reader });
    expect(parse(await client.callTool({ name: 'fleet_imessage_acks' }))).toEqual({ input: { limit: 20 } });
    expect(parse(await client.callTool({ name: 'fleet_imessage_acks', arguments: { limit: 7 } }))).toEqual({ input: { limit: 7 } });
    for (const limit of [1, 100]) {
      expect(parse(await client.callTool({ name: 'fleet_imessage_acks', arguments: { limit } }))).toEqual({ input: { limit } });
    }
    expect(reader).toHaveBeenCalledTimes(4);
  });

  it.each([
    { limit: 0 }, { limit: 101 }, { limit: -1 }, { limit: 1.5 }, { limit: '5' }, { limit: null },
    { limit: true }, { limit: Number.NaN }, { limit: { nested: 1 } },
    { dir: '/tmp' }, { root: '/tmp' }, { cwd: '/tmp' }, { path: '/tmp' }, { runsDir: '/tmp' },
    { send: true }, { poll: true }, { confirmedByMason: true }, { x: 1 }, { limit: 5, dir: '/tmp' },
  ])('rejects arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect({ imessageAcks: reader });
    await expect(client.callTool({ name: 'fleet_imessage_acks', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('distinguishes missing, empty and unreadable ack sources without inventing rows', async () => {
    const client = await connect({ imessageAcks: realAcksReader() });
    let out = parse(await client.callTool({ name: 'fleet_imessage_acks' }));
    expect(out).toMatchObject({ sourceState: 'ok', coverage: ACKS_COVERAGE, limit: 20 });
    expect(out.ackEvidence).toEqual({ sourceState: 'missing', rows: [], malformedRows: 0, deliveryProof: false });

    writeAcks('');
    out = parse(await client.callTool({ name: 'fleet_imessage_acks' }));
    expect(out.ackEvidence).toEqual({ sourceState: 'ok', rows: [], malformedRows: 0, deliveryProof: false });

    const file = join(imessageDir(), 'acks.jsonl');
    rmSync(file);
    mkdirSync(file);
    out = parse(await client.callTool({ name: 'fleet_imessage_acks' }));
    expect(out).toMatchObject({ sourceState: 'ok' });
    expect(out.ackEvidence).toEqual({ sourceState: 'unreadable', rows: [], malformedRows: 0, deliveryProof: false });
  });

  it('projects rows, strips private fields and never claims a send or delivery', async () => {
    writeAcks(`${row(1, { text: 'FAKE_PRIVATE_TEXT', receipt: 'FAKE_RECEIPT', handle: 'fake-handle' })}\n${row(2, { status: 'duplicate', delivery: 'FAKE_PRIVATE_DELIVERY' })}\n`);
    const client = await connect({ imessageAcks: realAcksReader() });
    const result = await client.callTool({ name: 'fleet_imessage_acks' });
    const serialized = JSON.stringify(result);
    expect(result.isError).not.toBe(true);
    for (const marker of ['FAKE_', 'receipt', 'fake-handle']) expect(serialized).not.toContain(marker);
    const out = parse(result);
    expect(out).toMatchObject({ sourceState: 'ok', coverage: ACKS_COVERAGE });
    expect(out.ackEvidence).toMatchObject({ sourceState: 'ok', malformedRows: 0, deliveryProof: false });
    expect(out.ackEvidence.rows).toEqual([
      { timestamp: '2026-01-02T03:04:05.000Z', rowid: 1, status: 'accepted', delivery: 'recorded-not-sent' },
      { timestamp: '2026-01-02T03:04:05.000Z', rowid: 2, status: 'duplicate', delivery: 'unknown' },
    ]);
  });

  it('keeps only the newest rows inside the limit, defaulting to 20', async () => {
    writeAcks(`${Array.from({ length: 30 }, (_, i) => row(i + 1)).join('\n')}\n`);
    const client = await connect({ imessageAcks: realAcksReader() });
    let out = parse(await client.callTool({ name: 'fleet_imessage_acks' }));
    expect(out.limit).toBe(20);
    expect(out.ackEvidence.rows.map((r: { rowid: number }) => r.rowid)).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));
    out = parse(await client.callTool({ name: 'fleet_imessage_acks', arguments: { limit: 2 } }));
    expect(out.ackEvidence.rows.map((r: { rowid: number }) => r.rowid)).toEqual([29, 30]);
  });

  it('counts malformed and torn rows without leaking their content', async () => {
    writeAcks(`${row(1)}\nnot-json\n{"at":`);
    const client = await connect({ imessageAcks: realAcksReader() });
    const result = await client.callTool({ name: 'fleet_imessage_acks' });
    const out = parse(result);
    expect(out.ackEvidence.rows.map((r: { rowid: number }) => r.rowid)).toEqual([1]);
    expect(out.ackEvidence.malformedRows).toBe(2);
    expect(JSON.stringify(result)).not.toContain('not-json');
  });

  it('drops a torn trailing row even when it parses', async () => {
    writeAcks(`${row(1)}\n${row(2)}`);
    const client = await connect({ imessageAcks: realAcksReader() });
    const out = parse(await client.callTool({ name: 'fleet_imessage_acks' }));
    expect(out.ackEvidence.rows.map((r: { rowid: number }) => r.rowid)).toEqual([1]);
    expect(out.ackEvidence.malformedRows).toBe(1);
  });

  it('reports a throwing collector as fixed unavailable evidence, never an empty tail', async () => {
    const client = await connect({ imessageAcks: realAcksReader({
      readAcks: async () => { throw new Error('private-collector-detail'); },
    }) });
    const result = await client.callTool({ name: 'fleet_imessage_acks' });
    expect(result.isError).not.toBe(true);
    expect(parse(result)).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      sourceState: 'unavailable', coverage: ACKS_COVERAGE, limit: 20, ackEvidence: null,
    });
    expect(JSON.stringify(result)).not.toContain('private-collector-detail');
  });

  it('returns a generic tool error when the reader itself throws', async () => {
    const client = await connect({ imessageAcks: async () => { throw new Error('private-source-value'); } });
    const result = await client.callTool({ name: 'fleet_imessage_acks' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it('leaves the runs tree untouched (read-only)', async () => {
    writeAcks(`${row(1)}\n`);
    writeFileSync(join(imessageDir(), 'cursor.json'), JSON.stringify({ version: 1, rowid: 9 }), { mode: 0o600 });
    const before = snapshotTree(root);
    const client = await connect({ imessagePath: realPathReader(), imessageAcks: realAcksReader() });
    expect(parse(await client.callTool({ name: 'fleet_imessage_acks' })).ackEvidence.rows).toHaveLength(1);
    expect(parse(await client.callTool({ name: 'fleet_imessage_path' })).pathEvidence.cursor.state).toBe('present');
    expect(snapshotTree(root)).toEqual(before);
  });

  it('parseFleetImessageAcksArgs applies the default and enforces bounds', () => {
    expect(parseFleetImessageAcksArgs({})).toEqual({ limit: 20 });
    expect(parseFleetImessageAcksArgs({ limit: 1 })).toEqual({ limit: 1 });
    expect(parseFleetImessageAcksArgs({ limit: 100 })).toEqual({ limit: 100 });
    for (const args of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }, { limit: null },
      { limit: 5, x: 1 }, { dir: '/tmp' }, { send: true },
    ]) expect(parseFleetImessageAcksArgs(args)).toBeNull();
  });
});
