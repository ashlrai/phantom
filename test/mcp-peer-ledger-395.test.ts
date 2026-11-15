import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import { NOTE, readFleetPeerLedger } from '../src/mcp/fleet-peer-ledger.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const name = 'fleet_peer_ledger';
const report: PeerLedgerReport = {
  v: 1, authority: 'none', status: 'ok', asOf: '2026-11-15T00:00:00.000Z',
  liveRows: 5, capacity: 1024, windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [{ fromAgent: 'alpha', target: 'beta', inWindow: 5, remaining: 1,
    lastAt: '2026-11-15T00:00:00.000Z' }],
  origins: [{ origin: 'handoff', maxHop: 7, nearCap: true }],
  truncated: { pairs: false, origins: false },
};
let client: Client;
let server: ReturnType<typeof createFleetServer>;
const reader = vi.fn<() => PeerLedgerReport>();

beforeEach(async () => {
  reader.mockReset().mockReturnValue(structuredClone(report));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    peerLedger: () => readFleetPeerLedger({ read: reader }) });
  await server.connect(st);
  client = new Client({ name: 'peer-ledger-test', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
});

async function read() {
  const result = await client.callTool({ name, arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { result, text, value: JSON.parse(text) };
}

describe('fleet peer ledger MCP tool (395)', () => {
  it('lists a closed no-argument schema with read-only annotations', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === name);
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool?.description).toBe(NOTE);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations).toEqual(tools.find(t => t.name === 'fleet_coordination_returns')?.annotations);
  });

  it('returns the reader report plus the authority note', async () => {
    const { result, value } = await read();
    expect(result.isError).not.toBe(true);
    expect(value).toEqual({ ...report, note: NOTE });
    expect(reader).toHaveBeenCalledExactlyOnceWith();
  });

  it('refuses caller root before invoking the reader', async () => {
    await expect(client.callTool({ name, arguments: { root: '/tmp' } }))
      .rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns a fixed unavailable report without thrown error text', async () => {
    reader.mockImplementation(() => { throw new Error('private-reader-detail'); });
    const { result, text, value } = await read();
    expect(result.isError).not.toBe(true);
    expect(value).toEqual({ ...report, status: 'unavailable', reason: 'peer-ledger-reader-failed',
      asOf: expect.any(String), liveRows: 0, pairs: [], origins: [], note: NOTE });
    expect(Number.isFinite(Date.parse(value.asOf))).toBe(true);
    expect(text).not.toContain('private-reader-detail');
  });

  it('reports empty for a real reader over an empty temporary bus root', async () => {
    const busRoot = mkdtempSync(join(tmpdir(), 'peer-ledger-395-'));
    try {
      reader.mockImplementation(() => readPeerLedger({ busRoot }));
      const { value } = await read();
      expect(value).toMatchObject({ status: 'empty', liveRows: 0, pairs: [], origins: [], note: NOTE });
    } finally {
      rmSync(busRoot, { recursive: true, force: true });
    }
  });
});
