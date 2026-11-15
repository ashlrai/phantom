import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { NOTE, readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const NAME = 'fleet_bridge_check';
const PRIVATE = 'private-ledger-content-411s';
const SNAPSHOT = { lastFleetStateRead: { ageSeconds: 30 } };
const PEERS = { status: 'ok' };

let dir: string;
let ledger: string;
let client: Client;
let server: ReturnType<typeof createFleetServer>;
const runtime = vi.fn(async () => structuredClone(SNAPSHOT));
const peers = vi.fn(() => structuredClone(PEERS));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-ledger-411s-'));
  ledger = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
  runtime.mockClear(); peers.mockClear();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  // claims dep is omitted on purpose: the real readFleetBoard/projectCoordinationClaims path runs.
  server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck({ runtime, peers }) });
  await server.connect(st);
  client = new Client({ name: 'bridge-ledger-411s', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function call() {
  const result = await client.callTool({ name: NAME, arguments: {} });
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { text, value: JSON.parse(text) };
}

describe('fleet_bridge_check MCP ledger recovery (411s)', () => {
  it('serves a real claim, fails closed on corruption, then recovers on the same connection', async () => {
    const tool = (await client.listTools()).tools.find(t => t.name === NAME);
    expect(tool?.description).toBe(NOTE);
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);

    // A real claimFleetWork record reads as one live claim; the call never writes the ledger.
    expect(claimFleetWork({ repo: 'ashlrai/phantom', task: 'bridge ledger recovery', agent: 'dot' })).toMatchObject({ ok: true });
    const before = readFileSync(ledger);
    const ready = await call();
    expect(ready.value).toMatchObject({ verdict: 'READY', missing: [],
      claims: { status: 'ok', state: 'known', source: 'coordination-ledger', live: 1, newestAgeSec: 0 } });
    expect(Number.isFinite(Date.parse(ready.value.asOf))).toBe(true);
    expect(ready.value.claims.asOf).toBe(ready.value.asOf);
    expect(readFileSync(ledger)).toEqual(before);

    // Corrupt bytes fail closed: claims unknown, no live count, no private content, file untouched.
    writeFileSync(ledger, `${PRIVATE}\n`, { mode: 0o600 });
    const beforeBlocked = readFileSync(ledger);
    const blocked = await call();
    expect(blocked.value).toMatchObject({ verdict: 'BLOCKED', missing: ['claims'],
      claims: { status: 'unavailable', state: 'unknown', live: null, newestAgeSec: null } });
    expect(blocked.text).not.toContain(PRIVATE);
    expect(readFileSync(ledger)).toEqual(beforeBlocked);

    // A repaired empty ledger is known-zero evidence, never execution or assignment.
    writeFileSync(ledger, '', { mode: 0o600 });
    const empty = await call();
    expect(empty.value).toMatchObject({ verdict: 'READY', missing: [],
      claims: { state: 'known', live: 0, newestAgeSec: null } });
    expect(readFileSync(ledger, 'utf8')).toBe('');

    // A fresh claim on the repaired file reads READY with the fresh count and clock.
    expect(claimFleetWork({ repo: 'ashlrai/phantom', task: 'bridge ledger repaired', agent: 'dot' })).toMatchObject({ ok: true });
    const recovered = await call();
    expect(recovered.value).toMatchObject({ verdict: 'READY', missing: [],
      claims: { state: 'known', status: 'ok', live: 1 } });
    expect(Date.parse(recovered.value.asOf)).toBeGreaterThanOrEqual(Date.parse(ready.value.asOf));
    expect(recovered.value.claims.newestAgeSec).toBeGreaterThanOrEqual(0);
  });

  it('refuses caller arguments before any reader runs', async () => {
    for (const args of [{ root: dir }, { path: ledger }, { cwd: '/tmp' }]) {
      const calls = runtime.mock.calls.length + peers.mock.calls.length;
      await expect(client.callTool({ name: NAME, arguments: args })).rejects.toMatchObject({ code: -32602 });
      expect(runtime.mock.calls.length + peers.mock.calls.length).toBe(calls);
    }
  });
});
