import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { claimFleetWork, concludeFleetClaim, readFleetBoard, releaseFleetClaim } from '../src/core/fleet/coordination.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetClaimExecution } from '../src/mcp/fleet-claim-execution.js';

const NOW = Date.parse('2026-11-14T14:00:00.000Z');
const PRIVATE = 'fake private task text';

it('observes durable claims, return, release, and ledger recovery through one MCP connection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claim-execution-422s-'));
  const path = join(dir, 'coordination.jsonl');
  const saved = join(dir, 'saved.jsonl');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'fake-cloud-dot', version: '1.0.0' });
  const server = createFleetServer({
    status: async () => ({}), loop: async () => ({}),
    claimExecution: () => readFleetClaimExecution({
      now: () => NOW,
      board: options => readFleetBoard({ ...options, path }),
      workers: async () => ({
        v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy',
        workers: [{ pid: 123, job: 'RQ-PHX-FAKEJOB1', repo: 'fake-repo', lane: 'fake-lane', tier: 'work', ageSeconds: 30 }],
        leaders: [], orchestratorAgents: 0,
      }),
    }),
  });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const read = async () => {
      let before: Buffer | null;
      try { before = readFileSync(path); } catch { before = null; }
      const result = await client.callTool({ name: 'fleet_claim_execution', arguments: {} });
      expect(result.isError).toBeFalsy();
      if (before === null) expect(() => readFileSync(path)).toThrow();
      else expect(readFileSync(path)).toEqual(before);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text).not.toContain(PRIVATE);
      const report = JSON.parse(text);
      expect(report).toMatchObject({ authority: 'none', asOf: new Date(NOW).toISOString() });
      return report;
    };
    const unavailable = await read();
    expect(unavailable).toMatchObject({ ledger: 'unavailable', rows: [], counts: { running: 0, claimedNoWorker: 0, unknown: 0 } });

    const running = claimFleetWork({ repo: 'fake-owner/fake-repo', task: `RQ-PHX-FAKEJOB1 ${PRIVATE}`, agent: 'fake-agent', ttlMs: 86_400_000 }, { path, now: NOW - 1000 });
    const waiting = claimFleetWork({ repo: 'fake-owner/fake-repo', task: `RQ-PHX-FAKEJOB2 ${PRIVATE}`, agent: 'fake-agent-2', ttlMs: 86_400_000 }, { path, now: NOW - 1000 });
    if (!running.ok || !waiting.ok) throw new Error('fake claim acquisition failed');
    const acquired = await read();
    expect(acquired).toMatchObject({ ledger: 'known', processes: 'healthy', counts: { running: 1, claimedNoWorker: 1, unknown: 0 } });
    expect(acquired.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: running.value.claim.id, agent: 'fake-agent', jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING', worker: expect.objectContaining({ pid: 123 }) }),
      expect.objectContaining({ claimId: waiting.value.claim.id, agent: 'fake-agent-2', jobId: 'RQ-PHX-FAKEJOB2', state: 'CLAIMED_NO_WORKER', worker: null }),
    ]));
    expect(acquired.rows).toHaveLength(2);

    const returned = concludeFleetClaim({ id: running.value.claim.id, agent: 'fake-agent', lease: running.value.lease,
      message: { id: 'fake-return', from: 'fake-agent', to: 'fake-owner', body: 'fake result' } }, { path, now: NOW });
    expect(returned.ok).toBe(true);
    const afterReturn = await read();
    expect(afterReturn).toMatchObject({ ledger: 'known', counts: { running: 0, claimedNoWorker: 1, unknown: 0 } });
    expect(afterReturn.rows).toHaveLength(1);
    expect(afterReturn.rows[0]).toMatchObject({ claimId: waiting.value.claim.id, agent: 'fake-agent-2', jobId: 'RQ-PHX-FAKEJOB2' });
    expect(releaseFleetClaim({ id: waiting.value.claim.id, agent: 'fake-agent-2', lease: waiting.value.lease }, { path, now: NOW }).ok).toBe(true);
    expect(await read()).toMatchObject({ ledger: 'known', rows: [], counts: { running: 0, claimedNoWorker: 0, unknown: 0 } });

    renameSync(path, saved);
    expect(await read()).toMatchObject({ ledger: 'unavailable', rows: [] });
    writeFileSync(path, 'invalid ledger\n');
    expect(await read()).toMatchObject({ ledger: 'unavailable', rows: [] });
    rmSync(path);
    renameSync(saved, path);
    expect(await read()).toMatchObject({ ledger: 'known', rows: [], counts: { running: 0, claimedNoWorker: 0, unknown: 0 } });
  } finally {
    await client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
