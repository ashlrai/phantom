import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import type { LiveWorker } from '../src/core/fleet/runs-live-workers.js';
import type { FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';
import { readFleetRuntime } from '../src/mcp/fleet-runtime.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error('fake coordination operation failed');
  return result.value;
}

it('reports execution across durable claim ownership and completion over one MCP session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-runtime-429s-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fake-client', version: '1.0.0' });
  let server: ReturnType<typeof createFleetServer> | undefined;
  try {
    const path = join(home, 'ledger.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    let now = Date.parse('2026-11-13T14:00:00.000Z');
    const options = () => ({ path, now });
    const board = () => readFleetBoard(options());
    const task = 'RQ-FAKE-MCP429S fake private task body';
    const leases: string[] = [];
    let workers: LiveWorker[] = [];
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => home, host: () => 'fake-host',
      platform: () => 'fakeos', arch: () => 'fakearch', pid: () => 123, uptime: () => 10,
      installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3', tailnet: () => 'fake-net', board,
      execution: () => readClaimExecution({ board, now: () => now, workers: async () => ({
        v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0,
      }) }),
    };
    server = createFleetServer({ status: async () => ({}), loop: async () => ({}), runtime: () => readFleetRuntime(deps) });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.some(tool => tool.name === 'fleet_runtime')).toBe(true);
    const read = async (activeClaims: number, running: number, claimedNoWorker: number, returnAge: number | string) => {
      const result = await client.callTool({ name: 'fleet_runtime', arguments: {} });
      expect(result.isError).toBeFalsy();
      const serialized = JSON.stringify(result);
      expect([home, task, ...leases].every(value => !serialized.includes(value))).toBe(true);
      const content = result.content as Array<{ text: string }>;
      expect(JSON.parse(content[0]!.text)).toMatchObject({ schemaVersion: 1, authority: 'none',
        asOf: new Date(now).toISOString(),
        coordination: { state: 'known', activeClaims, newestReturnAgeSeconds: returnAge },
        execution: { state: 'known', running, claimedNoWorker, unknown: 0 } });
    };
    await read(0, 0, 0, 'UNKNOWN');
    const claim = must(claimFleetWork({ repo: 'fake-owner/fake-mcp429s', task, agent: 'fake-owner-a' }, options()));
    leases.push(claim.lease);
    expect(board().claims.map(item => item.agent)).toEqual(['fake-owner-a']);
    now += 1000;
    await read(1, 0, 1, 'UNKNOWN');
    // Matching job and repository establishes execution, not process-to-agent identity.
    workers = [{ pid: 4242, job: 'RQ-FAKE-MCP429S', repo: 'fake-mcp429s', lane: 'fake', tier: 'work', ageSeconds: 1 }];
    now += 1000;
    await read(1, 1, 0, 'UNKNOWN');
    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: 'fake-owner-a', lease: claim.lease, to: 'fake-owner-b' }, options()));
    leases.push(handoff.lease);
    expect(board().claims.map(item => item.agent)).toEqual(['fake-owner-b']);
    now += 1000;
    await read(1, 1, 0, 'UNKNOWN');
    expect(returnFleetClaim({ id: claim.claim.id, agent: 'fake-owner-a', lease: claim.lease, tests: 'fake tests' }, options()).outcome).toBe('not-owner');
    expect(board().claims.map(item => item.agent)).toEqual(['fake-owner-b']);
    now += 1000;
    await read(1, 1, 0, 'UNKNOWN');
    const input = { id: claim.claim.id, agent: 'fake-owner-b', lease: handoff.lease, tests: 'fake tests' };
    expect(returnFleetClaim(input, options()).outcome).toBe('returned');
    expect(board().claims).toEqual([]);
    now += 1000;
    await read(0, 0, 0, 1);
    expect(returnFleetClaim(input, options()).outcome).toBe('already-returned');
    expect(board().claims).toEqual([]);
    now += 1000;
    await read(0, 0, 0, 2);
  } finally {
    await client.close();
    await server?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
