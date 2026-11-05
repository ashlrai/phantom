import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, MAX_FLEET_OUTPUT_BYTES, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetJobCurrent, type FleetJobCurrentArgs } from '../../src/mcp/fleet-job-current.js';
import { jobCurrent, type JobCurrentReport } from '../../src/core/fleet/job-current.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
});

async function connect(reader?: FleetReaders['jobCurrent'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'job-current-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, jobCurrent: reader }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

/** The injected projection: the server's reader slot with a fake git inside the real reader. */
const viaRealReader = (run: (args: string[]) => Promise<string>) =>
  (input: FleetJobCurrentArgs) =>
    readFleetJobCurrent(input, { read: job => jobCurrent(job, run) });

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
const PINNED = 'd'.repeat(40);
const OID = (c: string) => c.repeat(40);
const gitLogFor = (...commits: Array<[string, string, string]>) =>
  commits.map(([sha, date, subject]) => `${sha}\0${date}\0${subject}\0\n`).join('');
const treeEntry = (oid: string, path: string) => `100644 blob ${oid}\t${path}\0`;

describe('fleet_job_current over MCP', () => {
  it('is advertised read-only with exactly one required jobId and no caller ref', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_job_current');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        jobId: { type: 'string', description: expect.stringContaining('Exact') },
      },
      required: ['jobId'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/origin\/master/);
    expect(tool?.description).toMatch(/does not prove the job never landed/i);
    expect(tool?.description).toMatch(/never missing work/i);
    expect(tool?.description).toMatch(/correctness, live lane, dispatch or merge-queue verdict/i);
  });

  it('round trips the exact jobId once and returns every status class with tree OIDs', async () => {
    const atCommit = { 'src/kept.ts': OID('1'), 'src/edited.ts': OID('2'), 'src/deleted.ts': OID('3') };
    const atNow = { 'src/kept.ts': OID('1'), 'src/edited.ts': OID('4') };
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${PINNED}\n`;
      if (args[0] === 'log') return gitLogFor([SHA1, '2026-10-31T00:33:00Z', 'bridge(RQ-CUR-7): landed work (#42)']);
      if (args[0] === 'diff-tree') return 'src/deleted.ts\0src/edited.ts\0src/kept.ts\0src/purged.ts\0';
      if (args[0] === 'ls-tree') {
        const present = args[3] === SHA1 ? atCommit : atNow;
        return args.slice(5).map(spec => {
          const oid = (present as Record<string, string>)[spec.slice(10)];
          return oid ? treeEntry(oid, spec.slice(10)) : '';
        }).join('');
      }
      throw new Error('unexpected git call');
    });
    const read = vi.fn((job: string) => jobCurrent(job, run));
    const client = await connect(input => readFleetJobCurrent(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-CUR-7' } }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('RQ-CUR-7');
    expect(run.mock.calls.map(call => call[0][0])).toEqual(['rev-parse', 'log', 'diff-tree', 'ls-tree', 'ls-tree']);
    const trees = run.mock.calls.filter(call => call[0][0] === 'ls-tree');
    expect(trees.map(call => call[0][3])).toEqual([SHA1, PINNED]);
    for (const call of trees) {
      expect(call[0].slice(5)).toEqual([
        ':(literal)src/deleted.ts', ':(literal)src/edited.ts', ':(literal)src/kept.ts', ':(literal)src/purged.ts',
      ]);
    }
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      jobId: 'RQ-CUR-7', ref: 'origin/master', resolvedRef: PINNED,
      scanBound: 1000, scanned: 1, scanMayBeTruncated: false, matchesTruncated: false,
      commit: { sha: SHA1, date: '2026-10-31T00:33:00Z', pr: 42 },
      pathBound: 200, omittedPaths: 0,
      summary: { unchanged: 1, changed: 1, absentNow: 1, absentAtBoth: 1 },
    });
    expect(out.entries).toEqual([
      { path: 'src/deleted.ts', status: 'absent-now', atCommit: { mode: '100644', type: 'blob', oid: OID('3') }, atCurrent: null },
      { path: 'src/edited.ts', status: 'changed', atCommit: { mode: '100644', type: 'blob', oid: OID('2') }, atCurrent: { mode: '100644', type: 'blob', oid: OID('4') } },
      { path: 'src/kept.ts', status: 'unchanged', atCommit: { mode: '100644', type: 'blob', oid: OID('1') }, atCurrent: { mode: '100644', type: 'blob', oid: OID('1') } },
      { path: 'src/purged.ts', status: 'absent-at-both', atCommit: null, atCurrent: null },
    ]);
    expect(out.note).toMatch(/does not prove the job never landed/i);
    expect(out.note).toMatch(/never missing work/i);
  });

  it('returns a null commit with resolvedRef and no tree reads when nothing matches', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${PINNED}\n`;
      if (args[0] === 'log') return gitLogFor(
        [SHA1, 'd1', 'plain commit'],
        [SHA2, 'd2', 'bridge(RQ-OTHER-9): other job (#7)'],
      );
      throw new Error('unexpected git call');
    });
    const client = await connect(viaRealReader(run));
    const out = parse(await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-CUR-7' } }));
    expect(out).toMatchObject({
      jobId: 'RQ-CUR-7', resolvedRef: PINNED, scanned: 2,
      commit: null, entries: [], omittedPaths: 0,
      summary: { unchanged: 0, changed: 0, absentNow: 0, absentAtBoth: 0 },
    });
    expect(run.mock.calls.map(call => call[0][0])).toEqual(['rev-parse', 'log']);
  });

  it('compares only the newest matching commit and flags older matches as truncated', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${PINNED}\n`;
      if (args[0] === 'log') return gitLogFor(
        [SHA1, '2026-10-31T00:33:00Z', 'bridge(RQ-CUR-7): newest (#42)'],
        [SHA2, '2026-10-30T23:51:00Z', 'bridge(RQ-CUR-7): older (#41)'],
      );
      if (args[0] === 'diff-tree') return 'src/a.ts\0';
      if (args[0] === 'ls-tree') return treeEntry(OID('5'), 'src/a.ts');
      throw new Error('unexpected git call');
    });
    const client = await connect(viaRealReader(run));
    const out = parse(await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-CUR-7' } }));
    expect(out).toMatchObject({ matchesTruncated: true, commit: { sha: SHA1, pr: 42 } });
    const diffTrees = run.mock.calls.filter(call => call[0][0] === 'diff-tree');
    expect(diffTrees).toHaveLength(1);
    expect(diffTrees[0][0]).toContain(SHA1);
  });

  it('passes scan-bound and path-bound truncation indicators through unchanged', async () => {
    const read = async (): Promise<JobCurrentReport> => ({
      jobId: 'RQ-X', ref: 'origin/master', resolvedRef: PINNED,
      scanBound: 1000, scanned: 1000, scanMayBeTruncated: true, matchesTruncated: true,
      commit: { sha: SHA1, date: 'd', pr: 3 }, pathBound: 200, omittedPaths: 5,
      summary: { unchanged: 190, changed: 5, absentNow: 3, absentAtBoth: 2 }, entries: [],
    });
    const client = await connect(input => readFleetJobCurrent(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-X' } }));
    expect(out).toMatchObject({
      resolvedRef: PINNED, scanBound: 1000, scanned: 1000,
      scanMayBeTruncated: true, matchesTruncated: true, pathBound: 200, omittedPaths: 5,
    });
  });

  it('sanitizes secret-shaped and home-path text inside returned evidence', async () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(3);
    const home = process.env.HOME!;
    const read = async (): Promise<JobCurrentReport> => ({
      jobId: 'RQ-X', ref: 'origin/master', resolvedRef: PINNED,
      scanBound: 1000, scanned: 1, scanMayBeTruncated: false, matchesTruncated: false,
      commit: { sha: SHA1, date: 'd', pr: null }, pathBound: 200, omittedPaths: 0,
      summary: { unchanged: 1, changed: 1, absentNow: 0, absentAtBoth: 0 },
      entries: [
        { path: `leak/${token}.txt`, status: 'changed',
          atCommit: { mode: '100644', type: 'blob', oid: OID('1') },
          atCurrent: { mode: '100644', type: 'blob', oid: OID('4') } },
        { path: `${home}/secret.ts`, status: 'unchanged',
          atCommit: { mode: '100644', type: 'blob', oid: OID('1') },
          atCurrent: { mode: '100644', type: 'blob', oid: OID('1') } },
      ],
    });
    const client = await connect(input => readFleetJobCurrent(input, { read }));
    const raw = await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-X' } });
    const text = (raw.content as Array<{ text: string }>)[0].text;
    expect(raw.isError).not.toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain(home);
    expect(text).toContain('REDACTED');
    expect(text).toContain('~');
  });

  it('marks oversized evidence as an error without emitting partial JSON', async () => {
    const read = async (): Promise<JobCurrentReport> => ({
      jobId: 'RQ-X', ref: 'origin/master', resolvedRef: PINNED,
      scanBound: 1000, scanned: 1, scanMayBeTruncated: false, matchesTruncated: false,
      commit: null, pathBound: 200, omittedPaths: 0,
      summary: { unchanged: 1, changed: 0, absentNow: 0, absentAtBoth: 0 },
      entries: [{ path: `big/${'界'.repeat(MAX_FLEET_OUTPUT_BYTES / 2)}.ts`, status: 'unchanged',
        atCommit: { mode: '100644', type: 'blob', oid: OID('1') },
        atCurrent: { mode: '100644', type: 'blob', oid: OID('1') } }],
    });
    const client = await connect(input => readFleetJobCurrent(input, { read }));
    const result = await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-X' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text)
      .toBe('Fleet observation exceeds the output limit; request a smaller limit.');
  });

  it.each([
    {},
    { jobId: 5 }, { jobId: null }, { jobId: 'RQ-' }, { jobId: 'JOB-1' },
    { jobId: 'rq-x' }, { jobId: 'rq-cur-7' }, { jobId: 'RQ-A B' }, { jobId: 'RQ-A..B' }, { jobId: 'RQ-A/B' },
    { jobId: 'RQ-X', limit: 5 }, { jobId: 'RQ-X', ref: 'HEAD' }, { jobId: 'RQ-X', path: 'src' },
    { jobId: 'RQ-X', cwd: '/tmp' }, { jobId: 'RQ-X', root: '/' }, { jobId: 'RQ-X', extra: 1 },
  ])('rejects invalid arguments before any read: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_job_current', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a git failure as a tool error, never as fabricated empty evidence', async () => {
    const client = await connect(async () => { throw new Error('fatal: not a git repo; token ghp_secretvalue'); });
    const result = await client.callTool({ name: 'fleet_job_current', arguments: { jobId: 'RQ-X' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/ghp_|not a git repo/);
  });

  it('keeps unknown-tool rejection and leaves existing tools working', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_job_current_delete' })).rejects.toMatchObject({ code: -32602 });
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ pending: 2 });
  });
});
