import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetJobHistory, type FleetJobHistoryArgs } from '../../src/mcp/fleet-job-history.js';
import { jobPathHistory } from '../../src/core/fleet/job-path-history.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
});

async function connect(jobHistory?: FleetReaders['jobHistory'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'job-history-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, jobHistory }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

/** The injected projection: the server's reader slot with a fake git inside the real reader. */
const viaRealReader = (run: (args: string[]) => Promise<string>) =>
  (input: FleetJobHistoryArgs) =>
    readFleetJobHistory(input, { read: (job, ref, limit) => jobPathHistory(job, ref, limit, run) });

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40);
const gitLogFor = (...commits: Array<[string, string, string]>) =>
  commits.map(([sha, date, subject]) => `${sha}\0${date}\0${subject}\0\n`).join('');

describe('fleet_job_history over MCP', () => {
  it('is advertised read-only with a required exact jobId and a bounded limit', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_job_history');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        jobId: { type: 'string', description: expect.stringContaining('Exact') },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['jobId'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/origin\/master/);
    expect(tool?.description).toMatch(/does not prove the job never landed/i);
  });

  it('round trips jobId and limit through the injected existing-reader adapter', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'log') return gitLogFor(
        [SHA1, '2026-10-31T00:33:00Z', 'bridge(RQ-EXAMPLE-1): landed one (#101)'],
        [SHA2, '2026-10-30T23:51:00Z', 'plain commit'],
        [SHA3, '2026-10-30T22:00:00Z', 'bridge(RQ-EXAMPLE-1): landed two (#102)'],
      );
      return args.at(-2) === SHA1 ? 'src/one.ts\0' : 'src/two.ts\0src/three.ts\0';
    });
    const read = vi.fn((job: string, ref: string, limit: number) => jobPathHistory(job, ref, limit, run));
    const client = await connect(input => readFleetJobHistory(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-EXAMPLE-1', limit: 5 } }));
    expect(read).toHaveBeenCalledWith('RQ-EXAMPLE-1', 'origin/master', 5);
    expect(run).toHaveBeenNthCalledWith(1, ['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', 'origin/master', '--']);
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      jobId: 'RQ-EXAMPLE-1', ref: 'origin/master',
      scanBound: 1000, scanned: 3, scanMayBeTruncated: false,
      limit: 5, matchesTruncated: false,
      commits: [
        { sha: SHA1, date: '2026-10-31T00:33:00Z', pr: 101, paths: ['src/one.ts'] },
        { sha: SHA3, date: '2026-10-30T22:00:00Z', pr: 102, paths: ['src/three.ts', 'src/two.ts'] },
      ],
      paths: ['src/one.ts', 'src/three.ts', 'src/two.ts'],
    });
  });

  it('applies the default limit of 20 when limit is omitted', async () => {
    const read = vi.fn(async () => ({ jobId: 'RQ-X', ref: 'origin/master', scanBound: 1000, scanned: 0,
      scanMayBeTruncated: false, limit: 20, matchesTruncated: false, commits: [], paths: [] }));
    const client = await connect(input => readFleetJobHistory(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-X' } }));
    expect(read).toHaveBeenCalledWith('RQ-X', 'origin/master', 20);
    expect(out.limit).toBe(20);
  });

  it('matches exact job ids only — unrelated RQ prefixes never collide', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'log') return gitLogFor(
        [SHA1, 'd1', 'bridge(RQ-EXAMPLE-EXTRA): other job (#1)'],
        [SHA2, 'd2', 'bridge(RQ-OTHER-9): other job (#2)'],
      );
      return 'src/other.ts\0';
    });
    const client = await connect(viaRealReader(run));
    const out = parse(await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-EXAMPLE' } }));
    expect(out).toMatchObject({ jobId: 'RQ-EXAMPLE', scanned: 2, commits: [], paths: [] });
    expect(run).toHaveBeenCalledTimes(1); // no matching commit, so no diff-tree calls
    expect(out.note).toMatch(/does not prove the job never landed/i);
  });

  it('preserves scan-bound and match truncation indicators', async () => {
    const read = async () => ({ jobId: 'RQ-X', ref: 'origin/master', scanBound: 1000, scanned: 1000,
      scanMayBeTruncated: true, limit: 1, matchesTruncated: true,
      commits: [{ sha: SHA1, date: 'd', pr: 7, paths: ['src/p.ts'] }], paths: ['src/p.ts'] });
    const client = await connect(input => readFleetJobHistory(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-X', limit: 1 } }));
    expect(out).toMatchObject({ scanBound: 1000, scanned: 1000, scanMayBeTruncated: true, matchesTruncated: true });
  });

  it('sanitizes secret-shaped and home-path text inside returned evidence', async () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(3);
    const home = process.env.HOME!;
    const read = async () => ({ jobId: 'RQ-X', ref: 'origin/master', scanBound: 1000, scanned: 1,
      scanMayBeTruncated: false, limit: 20, matchesTruncated: false,
      commits: [{ sha: SHA1, date: 'd', pr: null, paths: [`leak/${token}.txt`, `${home}/secret.ts`] }],
      paths: [`leak/${token}.txt`, `${home}/secret.ts`] });
    const client = await connect(input => readFleetJobHistory(input, { read }));
    const raw = await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-X' } });
    const text = (raw.content as Array<{ text: string }>)[0].text;
    expect(raw.isError).not.toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain(home);
    expect(text).toContain('REDACTED');
    expect(text).toContain('~');
  });

  it.each([
    {},
    { jobId: 5 }, { jobId: null }, { jobId: 'RQ-' }, { jobId: 'JOB-1' },
    { jobId: 'rq-x' }, { jobId: 'RQ-A B' }, { jobId: 'RQ-A..B' }, { jobId: 'RQ-A/B' },
    { jobId: 'RQ-X', limit: 0 }, { jobId: 'RQ-X', limit: 101 }, { jobId: 'RQ-X', limit: 1.5 },
    { jobId: 'RQ-X', limit: '2' }, { jobId: 'RQ-X', limit: null },
    { jobId: 'RQ-X', ref: 'HEAD' }, { jobId: 'RQ-X', path: 'src' },
    { jobId: 'RQ-X', cwd: '/tmp' }, { jobId: 'RQ-X', root: '/' }, { jobId: 'RQ-X', extra: 1 },
  ])('rejects invalid arguments before any read: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_job_history', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a git failure as a tool error, never as fabricated empty history', async () => {
    const client = await connect(async () => { throw new Error('fatal: not a git repo; token ghp_secretvalue'); });
    const result = await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-X' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/ghp_|not a git repo/);
  });

  it('keeps unknown-tool rejection and leaves existing tools working', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_job_history_delete' })).rejects.toMatchObject({ code: -32602 });
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ pending: 2 });
  });
});
