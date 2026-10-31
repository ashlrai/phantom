import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';
import { createFleetServer, MAX_FLEET_OUTPUT_BYTES, type FleetReaders } from '../src/mcp/fleet-server.js';

const clients: Client[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function connect(hostRuns?: FleetReaders['hostRuns']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), hostRuns });
  const client = new Client({ name: 'host-runs-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client) {
  const result = await client.callTool({ name: 'fleet_host_runs' });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'mcp-host-runs-'));
  dirs.push(home);
  const runsDir = join(home, '.ashlr-runs');
  await cp(fileURLToPath(new URL('./fixtures/runs-dir/', import.meta.url)), runsDir, { recursive: true });
  await rename(join(runsDir, 'dispatch-events.txt'), join(runsDir, 'dispatch-events.log'));
  return { home, runsDir };
}

describe('standalone fleet host runs MCP', () => {
  it('lists the existing tools and advertises an empty, read-only host runs schema', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map(tool => tool.name)).toEqual(['fleet_status', 'fleet_loop', 'fleet_bus_hops', 'fleet_host_runs']);
    const host = tools.find(tool => tool.name === 'fleet_host_runs');
    expect(host?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(host?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it('reads the real persisted projection through the default reader', async () => {
    const { home, runsDir } = await fixture();
    vi.stubEnv('HOME', home);
    const client = await connect();
    const { result, text } = await call(client);
    expect(result.isError).not.toBe(true);
    const projection = JSON.parse(text);
    const expected = await readFleetRunsDirState({ runsDir });
    expect(projection).toEqual({ ...expected, generatedAt: projection.generatedAt });
    expect(projection).toMatchObject({
      runsDirPresent: true, sourceState: 'healthy',
      lanes: [{ lane: 'codex-personal', running: 1, target: 2 }],
      claimed: [{ job: 'RQ-FAKE-1', lane: 'codex-personal' }],
      events: [{ kind: 'PUBLISHED' }, { kind: 'LAUNCH' }],
    });
  });

  it('preserves missing and degraded evidence from the real reader', async () => {
    const { runsDir } = await fixture();
    const missing = await connect(() => readFleetRunsDirState({ runsDir: join(runsDir, 'absent') }));
    expect(JSON.parse((await call(missing)).text)).toMatchObject({
      runsDirPresent: false, sourceState: 'missing', lanes: [], lastTick: null,
      sources: { status: 'missing', claimed: 'missing' },
    });
    await writeFile(join(runsDir, 'queue/status.json'), '{');
    const degraded = await connect(() => readFleetRunsDirState({ runsDir }));
    expect(JSON.parse((await call(degraded)).text)).toMatchObject({
      runsDirPresent: true, sourceState: 'degraded', lanes: [],
      sources: { status: 'degraded', claimed: 'healthy' },
      claimed: [{ job: 'RQ-FAKE-1' }],
    });
  });

  it.each([{ limit: 1 }, { path: 'elsewhere' }, { command: 'start' }, { extra: null }])
  ('rejects unknown arguments before reading: %j', async args => {
    const hostRuns = vi.fn(async () => ({}));
    const client = await connect(hostRuns);
    await expect(client.callTool({ name: 'fleet_host_runs', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(hostRuns).not.toHaveBeenCalled();
  });

  it('accepts explicit empty arguments and scrubs values before serializing', async () => {
    const fake = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const hostRuns = vi.fn(async () => ({ note: `token=${fake}`, email: 'person@example.com' }));
    const client = await connect(hostRuns);
    const result = await client.callTool({ name: 'fleet_host_runs', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(hostRuns).toHaveBeenCalledOnce();
    expect(JSON.parse(text)).toBeDefined();
    expect(text).not.toContain(fake);
    expect(text).not.toContain('person@example.com');
    expect(text).toContain('REDACTED');
  });

  it('returns a sanitized error for a reader exception', async () => {
    const client = await connect(async () => { throw new Error('fake-private-exception'); });
    const { result, text } = await call(client);
    expect(result.isError).toBe(true);
    expect(text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toContain('fake-private-exception');
  });

  it('rejects oversized UTF-8 output without returning partial data', async () => {
    const client = await connect(async () => ({ pad: '界'.repeat(MAX_FLEET_OUTPUT_BYTES / 2) }));
    const { result, text } = await call(client);
    expect(result.isError).toBe(true);
    expect(text).toContain('exceeds the output limit');
    expect(Buffer.byteLength(text)).toBeLessThan(500);
  });
});
