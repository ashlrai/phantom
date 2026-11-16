import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaimExecutionDeps } from '../src/core/fleet/claim-execution-evidence.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { parseFleetClaimExecutionArgs, readFleetClaimExecution } from '../src/mcp/fleet-claim-execution.js';

const NOW = Date.parse('2026-11-14T14:00:00.000Z');
const NOTE = 'Read-only sanitized claim execution evidence: which live advisory claims have a matching worker process on this computer. RUNNING requires a matched worker; otherwise CLAIMED_NO_WORKER or UNKNOWN. Grants no dispatch, claim or merge authority. Accepts no arguments and never writes.';
const deps: ClaimExecutionDeps = {
  now: () => NOW,
  board: () => ({
    schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
    claims: ['RQ-PHX-FAKEJOB1', 'RQ-PHX-FAKEJOB2'].map(id => ({
      id, agent: 'fake-agent', repo: 'fake-owner/fake-repo', task: 'fake private task text',
      claimedAt: NOW - 60_000, expiresAt: NOW + 60_000,
    })),
  }),
  workers: async () => ({
    v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy',
    workers: [{ pid: 123, job: 'RQ-PHX-FAKEJOB1', repo: 'fake-repo', lane: 'fake-lane',
      tier: 'work', ageSeconds: 30 }], leaders: [], orchestratorAgents: 0,
  }),
};
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function connect(claimExecution = () => readFleetClaimExecution(deps)) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), claimExecution });
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('fleet_claim_execution MCP evidence', () => {
  it('advertises a read-only tool accepting only an empty object', async () => {
    expect(parseFleetClaimExecutionArgs({})).toEqual({});
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find(tool => tool.name === 'fleet_claim_execution');
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool).toMatchObject({ description: NOTE,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
  });

  it('returns matched worker evidence and the authority note from an injected reader', async () => {
    const reader = vi.fn(() => readFleetClaimExecution(deps));
    const client = await connect(reader);
    const result = await client.callTool({ name: 'fleet_claim_execution', arguments: {} });
    expect(reader).toHaveBeenCalledExactlyOnceWith();
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text)).toEqual({
      schema: 'fleet.claim-execution.v1', authority: 'none', asOf: new Date(NOW).toISOString(),
      ledger: 'known', processes: 'healthy',
      rows: [
        { claimId: 'RQ-PHX-FAKEJOB1', agent: 'fake-agent', repo: 'fake-owner/fake-repo',
          jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING',
          worker: { pid: 123, lane: 'fake-lane', tier: 'work', ageSeconds: 30 }, expiresInSeconds: 60 },
        { claimId: 'RQ-PHX-FAKEJOB2', agent: 'fake-agent', repo: 'fake-owner/fake-repo',
          jobId: 'RQ-PHX-FAKEJOB2', state: 'CLAIMED_NO_WORKER', worker: null, expiresInSeconds: 60 },
      ], counts: { running: 1, claimedNoWorker: 1, unknown: 0 }, reasons: [], note: NOTE,
    });
    expect(text).not.toContain('fake private task text');
  });

  it.each([{ root: '/tmp' }, { path: '/fake' }, { cwd: '/fake' }, { limit: 1 }])(
    'refuses %j before any read', async args => {
      expect(parseFleetClaimExecutionArgs(args)).toBeNull();
      const reader = vi.fn(() => readFleetClaimExecution(deps));
      const client = await connect(reader);
      await expect(client.callTool({ name: 'fleet_claim_execution', arguments: args }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      expect(reader).not.toHaveBeenCalled();
    },
  );
});
