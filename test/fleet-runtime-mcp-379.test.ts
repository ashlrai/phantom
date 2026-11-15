import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRuntime, type FleetRuntimeDeps } from '../src/cli/fleet-runtime.js';
import { readFleetBoard } from '../src/core/fleet/coordination.js';
import { parseFleetRuntimeArgs, readFleetRuntime } from '../src/mcp/fleet-runtime.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const NOW = Date.parse('2026-11-13T14:00:00.000Z');
let home: string;
let ledger: string;
let deps: FleetRuntimeDeps;
const clients: Client[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-runtime-mcp-379-'));
  vi.stubEnv('HOME', home);
  const root = join(home, '.ashlr-runs');
  mkdirSync(join(root, 'queue'), { recursive: true });
  const state = join(root, 'queue/status.json');
  writeFileSync(state, '{}');
  utimesSync(state, (NOW - 30_000) / 1000, (NOW - 30_000) / 1000);
  ledger = join(home, 'coordination.jsonl');
  const claim = { id: 'fake-claim', repo: 'fake/repo', task: 'fake private task text', agent: 'fake-agent',
    claimedAt: NOW - 60_000, expiresAt: NOW + 60_000, leaseHash: 'a'.repeat(64) };
  const message = { id: 'return-fake-return', from: 'fake-agent', to: 'leader', at: NOW - 45_000, expiresAt: NOW + 60_000,
    body: 'RESULT VERIFIED fake/repo claim fake-return task "fake private task text": tests passed' };
  writeFileSync(ledger, [
    { version: 1, kind: 'claim', at: claim.claimedAt, claim },
    { version: 1, kind: 'post', at: message.at, message },
  ].map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
  deps = {
    now: () => NOW, home: () => home, stateRoot: () => root,
    host: () => 'fake-host', platform: () => 'fakeos', arch: () => 'fakearch',
    pid: () => 123, uptime: () => 120.5, installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3',
    tailnet: () => 'fake-tailnet', board: options => readFleetBoard({ ...options, path: ledger }),
  };
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function connect(runtime = () => readFleetRuntime(deps)) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), runtime });
  const client = new Client({ name: 'fake-agent', version: '1.2.3' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client) {
  const result = await client.callTool({ name: 'fleet_runtime', arguments: {} });
  expect(result.isError).toBeFalsy();
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  expect(text).not.toContain(home);
  expect(text).not.toContain('fake private task text');
  return JSON.parse(text);
}

/** Contents and modification metadata, including directories; access times are intentionally excluded. */
function files() {
  return ['', ...readdirSync(home, { recursive: true }) as string[]].sort().map(name => {
    const path = join(home, name);
    const stat = statSync(path);
    return { name, mtimeMs: stat.mtimeMs, mode: stat.mode, contents: stat.isFile() ? readFileSync(path, 'utf8') : null };
  });
}

describe('fleet_runtime MCP snapshot', () => {
  it('advertises a closed read-only tool and returns exactly the CLI snapshot with no writes', async () => {
    const before = files();
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'fleet_runtime')).toMatchObject({
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    const payload = await call(client);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRuntime(['--json'], deps)).toBe(0);
    const { schemaVersion, authority, note, ...snapshot } = payload;
    expect(schemaVersion).toBe(1);
    expect(authority).toBe('none');
    expect(note).toMatch(/evidence/i);
    expect(note).toContain('no dispatch, claim or merge authority');
    expect(note).toContain("another computer reads that computer's state");
    expect(snapshot).toEqual(JSON.parse(String(log.mock.calls[0]![0])));
    expect(snapshot).toMatchObject({
      host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '1.2.3',
      lastFleetStateRead: { mtime: '2026-11-13T13:59:30.000Z', ageSeconds: 30 },
      coordination: { state: 'known', activeClaims: 1, newestReturnAgeSeconds: 45 },
      asOf: '2026-11-13T14:00:00.000Z', reasons: [],
    });
    expect(files()).toEqual(before);
  });

  it.each([{ root: '/tmp' }, { path: 'x' }, { cwd: '.' }, { limit: 1 }])('refuses %j before any read', async args => {
    const runtime = vi.fn(() => readFleetRuntime(deps));
    const before = files();
    const client = await connect(runtime);
    expect(parseFleetRuntimeArgs(args)).toBeNull();
    await expect(client.callTool({ name: 'fleet_runtime', arguments: args })).rejects.toThrow(/Invalid fleet tool arguments/);
    expect(runtime).not.toHaveBeenCalled();
    expect(files()).toEqual(before);
  });

  it('reports an unreadable ledger with a fixed UNKNOWN reason and no writes', async () => {
    writeFileSync(ledger, 'unreadable ledger\n');
    const before = files();
    expect((await call(await connect())).coordination).toEqual({
      state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN',
      reason: 'coordination ledger: missing or unreadable',
    });
    expect(files()).toEqual(before);
  });
});
