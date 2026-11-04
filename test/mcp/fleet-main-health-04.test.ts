import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { parseFleetMainHealthArgs } from '../../src/mcp/fleet-main-health.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(c => c.close()));
  vi.unstubAllEnvs();
});

async function connect(mainHealth?: FleetReaders['mainHealth']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'main-health-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), mainHealth }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

const redReport = {
  v: 1,
  generatedAt: '2026-11-04T11:00:00.000Z',
  source: 'ok',
  statusAt: '2026-11-04T06:00:00-05:00',
  stale: false,
  guardianOff: false,
  red: 1,
  repos: [{
    repo: 'phantom', branch: 'master', sha: 'abcdef1', state: 'red',
    checkedAt: '2026-11-04T06:00:00-05:00', failingCheck: 'Quick typecheck',
    fixJobs: ['RQ-FIX-1'], nightlyRed: null,
  }],
};

describe('fleet_main_health over MCP', () => {
  it('is advertised observation-only with an empty strict schema', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_main_health');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('returns the injected reader JSON with a red repo row intact', async () => {
    const client = await connect(async () => redReport);
    const out = parse(await client.callTool({ name: 'fleet_main_health' }));
    expect(out).toMatchObject({ v: 1, source: 'ok', red: 1, stale: false, guardianOff: false });
    expect(out.repos[0]).toEqual({
      repo: 'phantom', branch: 'master', sha: 'abcdef1', state: 'red',
      checkedAt: '2026-11-04T06:00:00-05:00', failingCheck: 'Quick typecheck',
      fixJobs: ['RQ-FIX-1'], nightlyRed: null,
    });
  });

  it.each([{ x: 1 }, { path: '/tmp/x' }, { runsDir: '/tmp/x' }, { limit: 1 }, { strict: true }])(
    'rejects arguments before any read: %j', async args => {
      const reader = vi.fn(async () => ({}));
      const client = await connect(reader);
      await expect(client.callTool({ name: 'fleet_main_health', arguments: args })).rejects.toMatchObject({ code: -32602 });
      expect(reader).not.toHaveBeenCalled();
    });

  it('parseFleetMainHealthArgs accepts only the empty object', () => {
    expect(parseFleetMainHealthArgs({})).toEqual({});
    for (const args of [{ x: 1 }, { limit: 1 }, { runsDir: '/tmp/x' }]) {
      expect(parseFleetMainHealthArgs(args)).toBeNull();
    }
  });

  it('returns a generic tool error without leaking source exception details', async () => {
    const client = await connect(async () => { throw new Error('private-source-value /Users/me/token'); });
    const result = await client.callTool({ name: 'fleet_main_health' });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text)
      .toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/private-source-value|\/Users/);
  });

  it('unstubbed path reads the guardian status file under HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-main-health-'));
    mkdirSync(join(home, '.ashlr-runs', 'supervisor'), { recursive: true });
    writeFileSync(join(home, '.ashlr-runs', 'supervisor', 'status-main-guardian.md'), [
      '# Main guardian status (2026-11-04 06:00:00 EST)',
      '',
      '| repo | branch | sha | state | checked | failing check | fix jobs | nightly red |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| phantom | master | abcdef1 | red | 2026-11-04 06:00:00 | Quick typecheck | | |',
      '',
    ].join('\n'));
    vi.stubEnv('HOME', home);
    const client = await connect();
    const out = parse(await client.callTool({ name: 'fleet_main_health' }));
    expect(out.red).toBe(1);
    expect(out.repos[0]).toMatchObject({ repo: 'phantom', branch: 'master', state: 'red', failingCheck: 'Quick typecheck' });
  });
});
