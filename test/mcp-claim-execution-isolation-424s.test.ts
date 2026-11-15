import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { expect, it, vi } from 'vitest';
import type { ClaimExecutionDeps } from '../src/core/fleet/claim-execution-evidence.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetClaimExecution } from '../src/mcp/fleet-claim-execution.js';

const NOW = Date.parse('2026-11-14T14:00:00.000Z');
const PRIVATE = 'private-sentinel-reader-failure-424s';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function board(id: string): ReturnType<NonNullable<ClaimExecutionDeps['board']>> {
  return { schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
    claims: [{ id, agent: 'fake-agent', repo: 'fake-owner/fake-repo', task: 'synthetic task',
      claimedAt: NOW - 1000, expiresAt: NOW + 60_000 }] };
}

function workers(id: string, pid: number): LiveWorkersSnapshot {
  return { v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy',
    workers: [{ pid, job: id, repo: 'fake-repo', lane: 'fake-lane', tier: 'work', ageSeconds: 1 }],
    leaders: [], orchestratorAgents: 0 };
}

it('keeps concurrent claim evidence isolated over one MCP connection and recovers', async () => {
  const first = deferred<LiveWorkersSnapshot>();
  const second = deferred<LiveWorkersSnapshot>();
  const entered = deferred<void>();
  const ids = ['RQ-PHX-FAKEFIRST', 'RQ-PHX-FAKESECOND', 'RQ-PHX-FAKERECOVERY'];
  const boardReaders = ids.map(id => vi.fn(() => board(id)));
  const workerReaders = [vi.fn(() => first.promise), vi.fn(() => { entered.resolve(); return second.promise; }),
    vi.fn(async () => workers(ids[2]!, 303))];
  let calls = 0;
  const claimExecution = vi.fn(() => {
    const index = calls++;
    return readFleetClaimExecution({ now: () => NOW, board: boardReaders[index]!, workers: workerReaders[index]! });
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fake-cloud-dot', version: '1.0.0' });
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), claimExecution });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = () => client.callTool({ name: 'fleet_claim_execution', arguments: {} });
    const one = call();
    const two = call();
    void one.catch(() => {});
    void two.catch(() => {});
    await entered.promise;
    expect(workerReaders[0]).toHaveBeenCalledOnce();
    expect(workerReaders[1]).toHaveBeenCalledOnce();
    await expect(client.callTool({ name: 'fleet_claim_execution', arguments: { extra: true } }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(claimExecution).toHaveBeenCalledTimes(2);
    expect(boardReaders.every(reader => reader.mock.calls.length === 0)).toBe(true);
    expect(workerReaders[2]).not.toHaveBeenCalled();

    second.reject(new Error(PRIVATE));
    const failed = await two;
    first.resolve(workers(ids[0]!, 101));
    const success = await one;
    const recovery = await call();
    for (const response of [failed, success, recovery]) {
      expect(response.isError).toBeFalsy();
      expect(JSON.stringify(response)).not.toContain(PRIVATE);
    }
    const parse = (response: typeof success) => JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
    expect(parse(failed)).toMatchObject({ authority: 'none', ledger: 'known', processes: 'unavailable',
      counts: { running: 0, claimedNoWorker: 0, unknown: 1 }, reasons: ['process table: unavailable'],
      rows: [{ claimId: ids[1], jobId: ids[1], state: 'UNKNOWN', worker: null }] });
    expect(parse(success)).toMatchObject({ authority: 'none', ledger: 'known', processes: 'healthy',
      counts: { running: 1, claimedNoWorker: 0, unknown: 0 }, reasons: [],
      rows: [{ claimId: ids[0], jobId: ids[0], state: 'RUNNING', worker: { pid: 101 } }] });
    expect(parse(recovery)).toMatchObject({ authority: 'none', ledger: 'known', processes: 'healthy',
      counts: { running: 1, claimedNoWorker: 0, unknown: 0 }, reasons: [],
      rows: [{ claimId: ids[2], jobId: ids[2], state: 'RUNNING', worker: { pid: 303 } }] });
    for (const reader of [...boardReaders, ...workerReaders]) expect(reader).toHaveBeenCalledOnce();
  } finally {
    first.resolve(workers(ids[0]!, 101));
    second.resolve(workers(ids[1]!, 202));
    await client.close();
    await server.close();
    vi.restoreAllMocks();
  }
});
