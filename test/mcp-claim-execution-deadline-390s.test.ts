/** fleet_claim_execution: a stalled host process read degrades to a bounded unavailable report. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaimExecutionDeps } from '../src/core/fleet/claim-execution-evidence.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetClaimExecution } from '../src/mcp/fleet-claim-execution.js';

const NOW = Date.parse('2026-11-14T14:00:00.000Z');
const NOTE = 'Read-only sanitized claim execution evidence: which live advisory claims have a matching worker process on this computer. RUNNING requires a matched worker; otherwise CLAIMED_NO_WORKER or UNKNOWN. Grants no dispatch, claim or merge authority. Accepts no arguments and never writes.';
const DEADLINE_MS = 50;

function depsWith(workers: ClaimExecutionDeps['workers']): ClaimExecutionDeps {
  return {
    now: () => NOW,
    board: () => ({
      schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
      claims: ['RQ-PHX-FAKEJOB1', 'RQ-PHX-FAKEJOB2'].map(id => ({
        id, agent: 'fake-agent', repo: 'fake-owner/fake-repo', task: 'fake private task text',
        claimedAt: NOW - 60_000, expiresAt: NOW + 60_000,
      })),
    }),
    workers,
  };
}

const healthyWorkers: ClaimExecutionDeps['workers'] = async () => ({
  v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy',
  workers: [{ pid: 123, job: 'RQ-PHX-FAKEJOB1', repo: 'fake-repo', lane: 'fake-lane',
    tier: 'work', ageSeconds: 30 }], leaders: [], orchestratorAgents: 0,
});
const stalledDeps = depsWith(() => new Promise<never>(() => {}));

const DEGRADED = {
  schema: 'fleet.claim-execution.v1', authority: 'none', asOf: new Date(NOW).toISOString(),
  ledger: 'unavailable', processes: 'unavailable', rows: [],
  counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
  reasons: ['claim execution: read deadline exceeded'], note: NOTE,
};

const clients: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map(client => client.close()));
});

async function connect(claimExecution: () => Promise<unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), claimExecution });
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('fleet_claim_execution read deadline', () => {
  it('returns the unavailable report when the worker read never settles', async () => {
    vi.useFakeTimers();
    const pending = readFleetClaimExecution(stalledDeps, DEADLINE_MS);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const report = await pending;
    expect(report).toEqual(DEGRADED);
    expect(JSON.stringify(report)).not.toContain('fake private task text');
  });

  it('consumes a late rejection after the deadline and the next call reads healthy', async () => {
    vi.useFakeTimers();
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    let rejectWorker: (error: Error) => void = () => {};
    const gate = new Promise<never>((_resolve, reject) => { rejectWorker = reject; });
    try {
      const pending = readFleetClaimExecution(depsWith(() => gate), DEADLINE_MS);
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      expect(await pending).toEqual(DEGRADED);
      rejectWorker(new Error('fake ps failure with /fake/secret-path'));
      await vi.advanceTimersByTimeAsync(0);
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
    expect(await readFleetClaimExecution(depsWith(healthyWorkers), DEADLINE_MS)).toMatchObject({
      ledger: 'known', processes: 'healthy', counts: { running: 1, claimedNoWorker: 1, unknown: 0 },
    });
  });

  it('keeps the healthy RUNNING report and note unchanged', async () => {
    vi.useFakeTimers();
    const report = await readFleetClaimExecution(depsWith(healthyWorkers), DEADLINE_MS);
    expect(report).toEqual({
      schema: 'fleet.claim-execution.v1', authority: 'none', asOf: new Date(NOW).toISOString(),
      ledger: 'known', processes: 'healthy',
      rows: [
        { claimId: 'RQ-PHX-FAKEJOB1', agent: 'fake-agent', repo: 'fake-owner/fake-repo',
          jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING',
          worker: { pid: 123, lane: 'fake-lane', tier: 'work', ageSeconds: 30 }, expiresInSeconds: 60 },
        { claimId: 'RQ-PHX-FAKEJOB2', agent: 'fake-agent', repo: 'fake-owner/fake-repo',
          jobId: 'RQ-PHX-FAKEJOB2', state: 'CLAIMED_NO_WORKER', worker: null, expiresInSeconds: 60 },
      ],
      counts: { running: 1, claimedNoWorker: 1, unknown: 0 }, reasons: [], note: NOTE,
    });
  });

  it('serializes the degraded report through the fleet server reader seam', async () => {
    vi.useFakeTimers();
    const reader = vi.fn(() => readFleetClaimExecution(stalledDeps, DEADLINE_MS));
    const client = await connect(reader);
    const pending = client.callTool({ name: 'fleet_claim_execution', arguments: {} });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    const result = await pending;
    expect(reader).toHaveBeenCalledExactlyOnceWith();
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual(DEGRADED);
  });
});
