import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { jobOverlap, type JobOverlapResult } from '../../src/core/fleet/job-overlap.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetJobOverlap } from '../../src/mcp/fleet-job-overlap.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(reader?: FleetReaders['jobOverlap']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'overlap-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({ ok: true }), loop: async () => ({}), jobOverlap: reader }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const ids = ['RQ-B-2', 'RQ-A-1'];
const sha = (c: string) => c.repeat(40);

describe('fleet_job_overlap over MCP', () => {
  it('advertises strict read-only schema and keeps other readers', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_job_overlap');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ required: ['jobIds'], additionalProperties: false, properties: {
      jobIds: { minItems: 2, maxItems: 20, uniqueItems: true }, limit: { minimum: 1, maximum: 100, default: 20 },
    } });
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ ok: true });
  });

  it('uses one core read and one log scan, preserving literal paths, order and truncation', async () => {
    const log = [[sha('a'), 'bridge(RQ-A-1): a'], [sha('b'), 'bridge(RQ-B-2): b'], [sha('c'), 'bridge(RQ-A-1): older']]
      .map(([s, subject]) => `${s}\0date\0${subject}\0\n`).join('');
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return sha('d');
      if (args[0] === 'log') return log;
      if (args[0] === 'diff-tree') return args.at(-2) === sha('a') ? 'src/Shared.ts\0src/shared.ts\0' : 'src/Shared.ts\0';
      throw new Error('unexpected git');
    });
    const read = vi.fn((jobIds: string[], limit: number) => jobOverlap(jobIds, limit, run));
    const client = await connect(input => readFleetJobOverlap(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_overlap', arguments: { jobIds: ids, limit: 1 } }));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(ids, 1);
    expect(run.mock.calls.filter(call => call[0][0] === 'log')).toHaveLength(1);
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', ref: 'origin/master', resolvedRef: sha('d'), scanBound: 1000, scanned: 3, scanMayBeTruncated: false, evidenceMayBeIncomplete: true, limit: 1,
      jobs: [{ jobId: ids[0], matchesTruncated: false }, { jobId: ids[1], matchesTruncated: true }],
      sharedPaths: [{ path: 'src/Shared.ts', jobIds: ids }] });
    expect(out.note).toMatch(/never proof of safety or permission to dispatch/i);
  });

  it('defaults limit and scrubs public evidence while retaining scan flags', async () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(3);
    const read = vi.fn(async (): Promise<JobOverlapResult> => ({ schemaVersion: 1, ref: 'origin/master', resolvedRef: sha('d'), scanBound: 1000, scanned: 1000, scanMayBeTruncated: true, limit: 20, evidenceMayBeIncomplete: true, jobs: [], sharedPaths: [{ path: `${process.env.HOME}/${token}`, jobIds: ids }], note: 'empty is never proof or permission' }));
    const client = await connect(input => readFleetJobOverlap(input, { read }));
    const raw = await client.callTool({ name: 'fleet_job_overlap', arguments: { jobIds: ids } });
    expect(read).toHaveBeenCalledWith(ids, 20);
    expect(parse(raw)).toMatchObject({ scanMayBeTruncated: true, evidenceMayBeIncomplete: true });
    expect(JSON.stringify(raw)).not.toContain(token);
    expect(JSON.stringify(raw)).not.toContain(process.env.HOME);
    expect(JSON.stringify(raw)).toContain('REDACTED');
  });

  it.each([{}, { jobIds: [] }, { jobIds: ['RQ-A'] }, { jobIds: Array.from({ length: 21 }, (_, i) => `RQ-A-${i}`) },
    { jobIds: ['RQ-A', 'RQ-A'] }, { jobIds: ['RQ-A', 'bad'] }, { jobIds: ['RQ-A', 1] },
    ...[null, 0, 101, 1.5, '1'].map(limit => ({ jobIds: ids, limit })),
    ...['ref', 'root', 'cwd', 'path', 'extra'].map(key => ({ jobIds: ids, [key]: 'x' })),
  ])('rejects invalid arguments before reading: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_job_overlap', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports reader failures without fabricating evidence', async () => {
    const client = await connect(async () => { throw new Error('private failure'); });
    const result = await client.callTool({ name: 'fleet_job_overlap', arguments: { jobIds: ids } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private failure|sharedPaths/);
  });
});
