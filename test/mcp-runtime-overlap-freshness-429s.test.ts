import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { CLAIM_EXECUTION_SCHEMA, PROCESS_SNAPSHOT_MAX_AGE_MS, type ClaimExecutionReport } from '../src/core/fleet/claim-execution-evidence.js';
import { readFleetBoard } from '../src/core/fleet/coordination.js';
import type { FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';
import { readFleetRuntime } from '../src/mcp/fleet-runtime.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const BASE = Date.parse('2026-11-13T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const privateBody = 'fixture private body';
const lease = 'a'.repeat(64);
const rawError = 'fixture raw injected error';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function report(asOf: number, running: number): ClaimExecutionReport {
  return {
    schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf: iso(asOf), ledger: 'known', processes: 'healthy',
    rows: [], counts: { running, claimedNoWorker: 1, unknown: 0 }, reasons: [rawError],
  };
}

it.each(['stale', 'future'] as const)('isolates overlapping runtime reads with %s evidence and recovers', async kind => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-overlap-429s-'));
  const clients: Client[] = [];
  const servers: ReturnType<typeof createFleetServer>[] = [];
  try {
    async function setup(name: string, count: number, start: number) {
      const root = join(home, name, 'state');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'status.json'), '{}');
      const ledger = join(home, name, 'ledger.jsonl');
      const rows = Array.from({ length: count }, (_, i) => {
        const claim = { id: `claim-${i}`, repo: 'fake/repo', task: privateBody, agent: 'fake-agent',
          claimedAt: start - 10_000, expiresAt: start + 300_000, leaseHash: lease };
        return JSON.stringify({ version: 1, kind: 'claim', at: claim.claimedAt, claim });
      });
      writeFileSync(ledger, rows.join('\n') + '\n', { mode: 0o600 });
      let clock = start;
      let pending = deferred<ClaimExecutionReport>();
      let entered = deferred<void>();
      const deps: FleetRuntimeDeps = {
        now: () => clock, home: () => join(home, name), stateRoot: () => root,
        host: () => `host-${name}`, platform: () => 'fakeos', arch: () => 'fakearch',
        pid: () => 123, uptime: () => 5, installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3',
        tailnet: () => `tail-${name}`, board: options => readFleetBoard({ ...options, path: ledger }),
        execution: () => { entered.resolve(); return pending.promise; },
      };
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), runtime: () => readFleetRuntime(deps) });
      const client = new Client({ name: `client-${name}`, version: '1.0.0' });
      servers.push(server);
      clients.push(client);
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return {
        client, entered: () => entered.promise, settle: (value: ClaimExecutionReport) => pending.resolve(value),
        setClock: (value: number) => { clock = value; },
        reset: () => { pending = deferred<ClaimExecutionReport>(); entered = deferred<void>(); },
      };
    }
    async function call(client: Client) {
      const result = await client.callTool({ name: 'fleet_runtime', arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = JSON.stringify(result);
      for (const secret of [home, privateBody, lease, rawError]) expect(text).not.toContain(secret);
      const content = result.content;
      expect(Array.isArray(content)).toBe(true);
      if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('missing text response');
      return JSON.parse(content[0].text);
    }
    const a = await setup('alpha', 1, BASE);
    const b = await setup('beta', 2, BASE + 10_000);
    const first = call(a.client);
    await a.entered();
    const second = call(b.client);
    await b.entered();
    const aDone = BASE + 2_000;
    const bDone = BASE + 13_000;
    a.setClock(aDone);
    b.setClock(bDone);
    const invalid = kind === 'stale' ? bDone - PROCESS_SNAPSHOT_MAX_AGE_MS - 1 : bDone + 1;
    b.settle(report(invalid, 9));
    const beta = await second;
    a.settle(report(aDone, 3));
    const alpha = await first;
    expect(alpha).toMatchObject({ authority: 'none', host: 'host-alpha', asOf: iso(aDone),
      coordination: { state: 'known', activeClaims: 1 },
      execution: { state: 'known', running: 3, claimedNoWorker: 1, unknown: 0 } });
    expect(beta).toMatchObject({ authority: 'none', host: 'host-beta', asOf: iso(bDone),
      coordination: { state: 'known', activeClaims: 2 },
      execution: { state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
        reason: kind === 'stale' ? 'execution: report asOf older than freshness bound' : 'execution: report asOf ahead of observation clock' } });
    b.reset();
    const recovery = call(b.client);
    await b.entered();
    const recoveredAt = bDone + 1_000;
    b.setClock(recoveredAt);
    b.settle(report(recoveredAt, 2));
    expect(await recovery).toMatchObject({ authority: 'none', host: 'host-beta', asOf: iso(recoveredAt),
      coordination: { state: 'known', activeClaims: 2 },
      execution: { state: 'known', running: 2, claimedNoWorker: 1, unknown: 0 } });
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await Promise.all(servers.map(server => server.close()));
    rmSync(home, { recursive: true, force: true });
  }
});
