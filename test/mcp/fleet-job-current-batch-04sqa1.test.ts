import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetJobCurrentBatch } from '../../src/mcp/fleet-job-current-batch.js';
import { jobCurrentBatch } from '../../src/core/fleet/job-current-batch.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
});

async function connect(reader?: FleetReaders['jobCurrentBatch'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'job-current-batch-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, jobCurrentBatch: reader }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const body = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

const SHA1 = 'a'.repeat(40);
const PINNED = 'd'.repeat(40);
const OID = (c: string) => c.repeat(40);
const gitLogFor = (...commits: Array<[string, string, string]>) =>
  commits.map(([sha, date, subject]) => `${sha}\0${date}\0${subject}\0\n`).join('');
const treeEntry = (oid: string, path: string) => `100644 blob ${oid}\t${path}\0`;

describe('fleet_job_current_batch over MCP', () => {
  it('is advertised read-only with a required distinct jobIds list and no caller ref', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_job_current_batch');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        jobIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', description: expect.stringContaining('Exact') },
          description: expect.stringContaining('order'),
        },
      },
      required: ['jobIds'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/origin\/master/);
    expect(tool?.description).toMatch(/one immutable snapshot/i);
    expect(tool?.description).toMatch(/does not prove a job never landed/i);
    expect(tool?.description).toMatch(/not proof of correct behavior or permission to recut/i);
  });

  it('answers many ids from one reader call on one pinned tree, in input order', async () => {
    const atCommit = { 'src/kept.ts': OID('1'), 'src/edited.ts': OID('2'), 'src/deleted.ts': OID('3') };
    const atNow = { 'src/kept.ts': OID('1'), 'src/edited.ts': OID('4') };
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${PINNED}\n`;
      if (args[0] === 'log') return gitLogFor(
        [SHA1, '2026-10-31T00:33:00Z', 'bridge(RQ-CB-1): landed work (#42)'],
        ['b'.repeat(40), '2026-10-31T00:00:00Z', 'plain commit'],
      );
      if (args[0] === 'diff-tree') return 'src/kept.ts\0src/edited.ts\0src/deleted.ts\0';
      if (args[0] === 'ls-tree') {
        const present = args[3] === SHA1 ? atCommit : atNow;
        return args.slice(5).map(spec => {
          const path = spec.slice(':(literal)'.length);
          const oid = (present as Record<string, string>)[path];
          return oid ? treeEntry(oid, path) : '';
        }).join('');
      }
      throw new Error('unexpected git call');
    });
    const read = vi.fn((ids: string[]) => jobCurrentBatch(ids, run));
    const client = await connect(input => readFleetJobCurrentBatch(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_current_batch', arguments: { jobIds: ['RQ-CB-2', 'RQ-CB-1'] } }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(['RQ-CB-2', 'RQ-CB-1']);
    // One rev-parse pins origin/master; the memoized log scan serves every id.
    expect(run.mock.calls.filter(call => call[0][0] === 'rev-parse')).toEqual([[['rev-parse', '--verify', 'origin/master^{commit}']]]);
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      ref: 'origin/master', resolvedRef: PINNED,
      scanBound: 1000, scanned: 2, scanMayBeTruncated: false,
    });
    expect(out.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-CB-2', 'RQ-CB-1']);
    const missed = out.jobs[0];
    expect(missed).toMatchObject({ jobId: 'RQ-CB-2', commit: null, entries: [],
      summary: { unchanged: 0, changed: 0, absentNow: 0, absentAtBoth: 0 } });
    const landed = out.jobs[1];
    expect(landed.commit).toEqual({ sha: SHA1, date: '2026-10-31T00:33:00Z', pr: 42 });
    expect(landed.entries.map((entry: { path: string; status: string }) => [entry.path, entry.status])).toEqual([
      ['src/deleted.ts', 'absent-now'], ['src/edited.ts', 'changed'], ['src/kept.ts', 'unchanged'],
    ]);
    expect(landed.summary).toEqual({ unchanged: 1, changed: 1, absentNow: 1, absentAtBoth: 0 });
    expect(out.totals).toMatchObject({ jobs: 2, matched: 1, unchanged: 1, changed: 1, absentNow: 1, absentAtBoth: 0 });
    expect(out.note).toMatch(/does not prove a job never landed/i);
    expect(out.note).toMatch(/never missing work/i);
    expect(out.note).toMatch(/permission to recut/i);
  });

  it('preserves resolvedRef and per-job truncation evidence', async () => {
    const read = async () => ({ schemaVersion: 1 as const, ref: 'origin/master', resolvedRef: PINNED,
      scanBound: 1000, scanned: 1000, scanMayBeTruncated: true,
      jobs: [{ jobId: 'RQ-X', ref: 'origin/master', resolvedRef: PINNED, scanBound: 1000, scanned: 1000,
        scanMayBeTruncated: true, matchesTruncated: true,
        commit: { sha: SHA1, date: 'd', pr: 7 }, pathBound: 200, omittedPaths: 3,
        summary: { unchanged: 0, changed: 1, absentNow: 0, absentAtBoth: 0 },
        entries: [{ path: 'src/p.ts', status: 'changed' as const,
          atCommit: { mode: '100644', type: 'blob', oid: OID('2') }, atCurrent: { mode: '100644', type: 'blob', oid: OID('4') } }] }],
      totals: { jobs: 1, matched: 1, unchanged: 0, changed: 1, absentNow: 0, absentAtBoth: 0, omittedPaths: 3 } });
    const client = await connect(input => readFleetJobCurrentBatch(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_current_batch', arguments: { jobIds: ['RQ-X'] } }));
    expect(out).toMatchObject({ resolvedRef: PINNED, scanBound: 1000, scanned: 1000, scanMayBeTruncated: true });
    expect(out.jobs[0]).toMatchObject({ jobId: 'RQ-X', matchesTruncated: true, omittedPaths: 3 });
  });

  it('sanitizes secret-shaped and home-path text inside returned evidence', async () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(3);
    const home = process.env.HOME!;
    const read = async () => ({ schemaVersion: 1 as const, ref: 'origin/master', resolvedRef: PINNED,
      scanBound: 1000, scanned: 1, scanMayBeTruncated: false,
      jobs: [{ jobId: 'RQ-X', ref: 'origin/master', resolvedRef: PINNED, scanBound: 1000, scanned: 1,
        scanMayBeTruncated: false, matchesTruncated: false,
        commit: { sha: SHA1, date: 'd', pr: null }, pathBound: 200, omittedPaths: 0,
        summary: { unchanged: 0, changed: 1, absentNow: 0, absentAtBoth: 0 },
        entries: [{ path: `leak/${token}.txt`, status: 'changed' as const, atCommit: null, atCurrent: null }] }],
      totals: { jobs: 1, matched: 1, unchanged: 0, changed: 1, absentNow: 0, absentAtBoth: 0, omittedPaths: 0 } });
    const client = await connect(input => readFleetJobCurrentBatch(input, { read }));
    const raw = await client.callTool({ name: 'fleet_job_current_batch', arguments: { jobIds: ['RQ-X'] } });
    const text = body(raw);
    expect(raw.isError).not.toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain(home);
    expect(text).toContain('REDACTED');
  });

  it('reports a reader failure as a sanitized tool error, never fabricated evidence', async () => {
    const client = await connect(async () => { throw new Error('git missing'); });
    const raw = await client.callTool({ name: 'fleet_job_current_batch', arguments: { jobIds: ['RQ-X'] } });
    expect(raw.isError).toBe(true);
    expect(body(raw)).not.toContain('git missing');
  });

  it.each([
    {},
    { jobIds: null }, { jobIds: 'RQ-X' }, { jobIds: [] },
    { jobIds: Array.from({ length: 21 }, (_, i) => `RQ-${i}`) },
    { jobIds: ['RQ-A', 'RQ-A'] }, { jobIds: [null] }, { jobIds: [5] },
    { jobIds: ['RQ-'] }, { jobIds: ['nope'] }, { jobIds: ['rq-a'] },
    { jobIds: ['RQ-A B'] }, { jobIds: ['RQ-A/B'] }, { jobIds: ['JOB-1'] },
    { jobIds: ['RQ-X'], limit: 5 }, { jobIds: ['RQ-X'], ref: 'HEAD' },
    { jobIds: ['RQ-X'], jobId: 'RQ-X' }, { jobIds: ['RQ-X'], path: 'src/x.ts' },
    { jobIds: ['RQ-X'], cwd: '/tmp' },
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const read = vi.fn(async () => { throw new Error('must not run'); });
    const client = await connect(input => readFleetJobCurrentBatch(input, { read }));
    await expect(client.callTool({ name: 'fleet_job_current_batch', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(read).not.toHaveBeenCalled();
  });
});
