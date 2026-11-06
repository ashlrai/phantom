import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../../src/mcp/fleet-server.js';
import { readFleetJobPrecheckBatch, type FleetJobPrecheckBatchDeps } from '../../src/mcp/fleet-job-precheck-batch.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(deps: FleetJobPrecheckBatchDeps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'batch-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}),
    jobPrecheckBatch: input => readFleetJobPrecheckBatch(input, deps) }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const oid = 'a'.repeat(40);
const body = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;
const drafts = [
  { label: 'one', markdown: 'PRIVATE DRAFT ONE src/shared.ts' },
  { label: 'broken', markdown: 'PRIVATE DRAFT TWO src/broken.ts' },
  { label: 'two', markdown: 'PRIVATE DRAFT THREE src/shared.ts src/other.ts' },
];

describe('fleet_job_precheck_batch over MCP', () => {
  it('advertises the tool and shares probes while preserving errors and collisions', async () => {
    const exists = vi.fn(async (path: string) => {
      if (path === 'src/broken.ts') throw new Error('PRIVATE DRAFT TWO secret');
      return true;
    });
    const lastCommit = vi.fn(async () => ({ sha: 'abc1234', subject: 'bridge(RQ-FAKE-1): landed' }));
    const resolveRef = vi.fn(async () => oid);
    const probe = vi.fn(() => ({ exists, lastCommit }));
    const client = await connect({ resolveRef, gitJobProbe: probe });
    expect((await client.listTools()).tools.find(t => t.name === 'fleet_job_precheck_batch')?.annotations?.readOnlyHint).toBe(true);
    const raw = await client.callTool({ name: 'fleet_job_precheck_batch', arguments: { drafts } });
    const text = body(raw);
    const out = JSON.parse(text);
    expect(text).not.toContain('PRIVATE DRAFT');
    expect(out).toMatchObject({ ref: 'origin/master', resolvedRef: oid, authority: 'none',
      counts: { 'likely-done': 2, errors: 1 },
      entries: [{ label: 'one' }, { label: 'broken', error: 'git precheck failed' }, { label: 'two' }],
      collisions: [{ path: 'src/shared.ts', labels: ['one', 'two'] }] });
    expect(exists.mock.calls.filter(([path]) => path === 'src/shared.ts')).toHaveLength(1);
    expect(lastCommit).toHaveBeenCalledTimes(2);
    expect(resolveRef).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(oid);
  });

  it('pins all probes to one resolved commit when the symbolic ref changes', async () => {
    let symbolic = oid;
    const refs: string[] = [];
    const client = await connect({ resolveRef: async () => symbolic, gitJobProbe: ref => ({
      exists: async () => { refs.push(ref); symbolic = 'b'.repeat(40); return false; },
      lastCommit: async () => null,
    }) });
    const out = JSON.parse(body(await client.callTool({ name: 'fleet_job_precheck_batch', arguments: { drafts: [drafts[0], drafts[2]] } })));
    expect(out.resolvedRef).toBe(oid);
    expect(refs).toEqual([oid, oid]);
  });

  it('returns a sanitized tool error when the ref cannot resolve', async () => {
    const probe = vi.fn();
    const client = await connect({ resolveRef: async () => { throw new Error('fake secret and path'); }, gitJobProbe: probe });
    const result = await client.callTool({ name: 'fleet_job_precheck_batch', arguments: { drafts: [drafts[0]] } });
    expect(result.isError).toBe(true);
    expect(body(result)).not.toContain('fake secret');
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    {}, { drafts: [] }, { drafts: Array(21).fill(drafts[0]) }, { drafts: [null] },
    { drafts: [{ label: 'a', markdown: ' ' }] }, { drafts: [{ label: '../a', markdown: 'x' }] },
    { drafts: [{ label: 'a', markdown: '界'.repeat(2667) }] },
    { drafts: [{ label: 'a', markdown: 'x', path: 'x' }] },
    { drafts: [drafts[0], drafts[0]] }, { drafts: [drafts[0]], ref: 'HEAD' },
  ])('rejects malformed input before any probe: %j', async args => {
    const resolveRef = vi.fn(async () => oid);
    const probe = vi.fn();
    const client = await connect({ resolveRef, gitJobProbe: probe });
    await expect(client.callTool({ name: 'fleet_job_precheck_batch', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(resolveRef).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
});
