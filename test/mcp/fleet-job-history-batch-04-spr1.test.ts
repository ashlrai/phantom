import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetJobHistoryBatch } from '../../src/mcp/fleet-job-history-batch.js';
import { jobHistoryBatch } from '../../src/core/fleet/job-history-batch.js';

const exec = promisify(execFile);
const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
});

async function connect(reader?: FleetReaders['jobHistoryBatch'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'job-history-batch-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, jobHistoryBatch: reader }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const body = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40), SHA4 = 'd'.repeat(40);
const OID = 'e'.repeat(40);
const gitLogFor = (...commits: Array<[string, string, string]>) =>
  commits.map(([sha, date, subject]) => `${sha}\0${date}\0${subject}\0\n`).join('');

describe('fleet_job_history_batch over MCP', () => {
  it('is advertised read-only with a required distinct jobIds list and a bounded limit', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_job_history_batch');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        jobIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', description: expect.stringContaining('Exact') },
          description: expect.stringContaining('order'),
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['jobIds'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/origin\/master/);
    expect(tool?.description).toMatch(/one bounded git scan/i);
    expect(tool?.description).toMatch(/does not prove a job never landed/i);
    expect(tool?.description).toMatch(/never authorizes dispatch or merge/i);
  });

  it('answers many ids from one reader call, in input order, on the resolved ref', async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${OID}\n`;
      if (args[0] === 'log') return gitLogFor(
        [SHA1, '2026-10-31T00:33:00Z', 'bridge(RQ-TASKGRAPH-1): task graph (#201)'],
        [SHA2, '2026-10-31T00:00:00Z', 'plain commit'],
        [SHA3, '2026-10-30T23:51:00Z', 'bridge(RQ-AGENTSTATE-2): shared state (#202)'],
        [SHA4, '2026-10-30T22:00:00Z', 'bridge(RQ-TASKGRAPH-1-EXTRA): lookalike (#203)'],
      );
      return args.at(-2) === SHA1 ? 'src/graph.ts\0' : args.at(-2) === SHA3 ? 'src/state.ts\0src/state.test.ts\0' : 'src/extra.ts\0';
    });
    const read = vi.fn((ids: string[], limit: number) => jobHistoryBatch(ids, limit, run));
    const client = await connect(input => readFleetJobHistoryBatch(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_history_batch', arguments: { jobIds: ['RQ-AGENTSTATE-2', 'RQ-TASKGRAPH-1', 'RQ-MISSING-9'], limit: 5 } }));
    // One reader call for all ids; inside it, one rev-parse pins the OID and one log scan serves every id.
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(['RQ-AGENTSTATE-2', 'RQ-TASKGRAPH-1', 'RQ-MISSING-9'], 5);
    expect(run.mock.calls.filter(call => call[0][0] === 'rev-parse')).toEqual([[['rev-parse', '--verify', 'origin/master^{commit}']]]);
    expect(run.mock.calls.filter(call => call[0][0] === 'log')).toEqual([[['log', '-n1000', '--format=%H%x00%cI%x00%s%x00', OID, '--']]]);
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      ref: 'origin/master', resolvedRef: OID,
      scanBound: 1000, scanned: 4, scanMayBeTruncated: false, limit: 5,
    });
    expect(out.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-AGENTSTATE-2', 'RQ-TASKGRAPH-1', 'RQ-MISSING-9']);
    expect(out.jobs[0]).toMatchObject({ matchesTruncated: false, paths: ['src/state.test.ts', 'src/state.ts'] });
    expect(out.jobs[0].commits).toEqual([{ sha: SHA3, date: '2026-10-30T23:51:00Z', pr: 202, paths: ['src/state.test.ts', 'src/state.ts'] }]);
    // Exact ids only: the RQ-TASKGRAPH-1-EXTRA lookalike never lands in RQ-TASKGRAPH-1.
    expect(out.jobs[1]).toMatchObject({ matchesTruncated: false, paths: ['src/graph.ts'] });
    expect(out.jobs[2]).toMatchObject({ jobId: 'RQ-MISSING-9', matchesTruncated: false, commits: [], paths: [] });
    expect(out.note).toMatch(/does not prove the job never landed/i);
    expect(out.note).toMatch(/never authorizes dispatch or merge/i);
  });

  it('applies the default limit of 20 when limit is omitted', async () => {
    const read = vi.fn(async () => ({ resolvedRef: OID, scanBound: 1000, scanned: 0,
      scanMayBeTruncated: false, limit: 20, jobs: [] }));
    const client = await connect(input => readFleetJobHistoryBatch(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_history_batch', arguments: { jobIds: ['RQ-X'] } }));
    expect(read).toHaveBeenCalledWith(['RQ-X'], 20);
    expect(out.limit).toBe(20);
  });

  it('preserves resolvedRef and scan/match truncation indicators', async () => {
    const read = async () => ({ resolvedRef: OID, scanBound: 1000, scanned: 1000,
      scanMayBeTruncated: true, limit: 1,
      jobs: [{ jobId: 'RQ-X', matchesTruncated: true,
        commits: [{ sha: SHA1, date: 'd', pr: 7, paths: ['src/p.ts'] }], paths: ['src/p.ts'] }] });
    const client = await connect(input => readFleetJobHistoryBatch(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_job_history_batch', arguments: { jobIds: ['RQ-X'], limit: 1 } }));
    expect(out).toMatchObject({ resolvedRef: OID, scanBound: 1000, scanned: 1000, scanMayBeTruncated: true, limit: 1 });
    expect(out.jobs[0]).toMatchObject({ jobId: 'RQ-X', matchesTruncated: true });
  });

  it('sanitizes secret-shaped and home-path text inside returned evidence', async () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(3);
    const home = process.env.HOME!;
    const read = async () => ({ resolvedRef: OID, scanBound: 1000, scanned: 1,
      scanMayBeTruncated: false, limit: 20,
      jobs: [{ jobId: 'RQ-X', matchesTruncated: false,
        commits: [{ sha: SHA1, date: 'd', pr: null, paths: [`leak/${token}.txt`, `${home}/secret.ts`] }],
        paths: [`leak/${token}.txt`, `${home}/secret.ts`] }] });
    const client = await connect(input => readFleetJobHistoryBatch(input, { read }));
    const raw = await client.callTool({ name: 'fleet_job_history_batch', arguments: { jobIds: ['RQ-X'] } });
    const text = body(raw);
    expect(raw.isError).not.toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain(home);
    expect(text).toContain('REDACTED');
    expect(text).toContain('~');
  });

  it.each([
    {},
    { jobIds: null }, { jobIds: 'RQ-X' }, { jobIds: [] },
    { jobIds: Array.from({ length: 21 }, (_, i) => `RQ-${i}`) },
    { jobIds: ['RQ-A', 'RQ-A'] }, { jobIds: [null] }, { jobIds: [5] },
    { jobIds: ['RQ-'] }, { jobIds: ['nope'] }, { jobIds: ['rq-a'] },
    { jobIds: ['RQ-A B'] }, { jobIds: ['RQ-A/B'] }, { jobIds: ['JOB-1'] },
    { jobIds: ['RQ-X'], limit: 0 }, { jobIds: ['RQ-X'], limit: 101 }, { jobIds: ['RQ-X'], limit: 1.5 },
    { jobIds: ['RQ-X'], limit: '2' }, { jobIds: ['RQ-X'], limit: null },
    { jobIds: ['RQ-X'], jobId: 'RQ-X' }, { jobIds: ['RQ-X'], ref: 'HEAD' },
    { jobIds: ['RQ-X'], path: 'src' }, { jobIds: ['RQ-X'], cwd: '/tmp' },
    { jobIds: ['RQ-X'], root: '/' }, { jobIds: ['RQ-X'], extra: 1 },
  ])('rejects invalid arguments before any read: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_job_history_batch', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a reader failure as a tool error, never as fabricated empty history', async () => {
    const client = await connect(async () => { throw new Error('fatal: not a git repo; token ghp_secretvalue'); });
    const result = await client.callTool({ name: 'fleet_job_history_batch', arguments: { jobIds: ['RQ-X'] } });
    expect(result.isError).toBe(true);
    expect(body(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/ghp_|not a git repo/);
  });

  it('finds two bridge subjects in one audit through a real temporary git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-job-history-batch-'));
    const run = vi.fn(async (args: string[]) => (await exec('git', args, { cwd: dir, encoding: 'utf8' })).stdout);
    const read = vi.fn((ids: string[], limit: number) => jobHistoryBatch(ids, limit, run));
    try {
      await run(['init']); await run(['config', 'user.name', 'Fake']); await run(['config', 'user.email', 'fake@example.invalid']);
      writeFileSync(join(dir, 'graph.ts'), 'a');
      await run(['add', '.']); await run(['commit', '-m', 'bridge(RQ-TASKGRAPH-1): Oct 31 task graph (#301)']);
      writeFileSync(join(dir, 'plain.txt'), 'p');
      await run(['add', '.']); await run(['commit', '-m', 'plain cleanup']);
      writeFileSync(join(dir, 'state.ts'), 's');
      await run(['add', '.']); await run(['commit', '-m', 'bridge(RQ-AGENTSTATE-2): shared agent state (#302)']);
      await run(['update-ref', 'refs/remotes/origin/master', 'HEAD']);
      const oid = (await run(['rev-parse', 'HEAD'])).trim();
      run.mockClear();
      const client = await connect(input => readFleetJobHistoryBatch(input, { read }));
      const out = parse(await client.callTool({ name: 'fleet_job_history_batch', arguments: { jobIds: ['RQ-TASKGRAPH-1', 'RQ-AGENTSTATE-2'] } }));
      // One reader call; inside it one rev-parse pins the OID and one log scan serves both ids.
      expect(read).toHaveBeenCalledTimes(1);
      expect(run.mock.calls.filter(call => call[0][0] === 'rev-parse')).toHaveLength(1);
      expect(run.mock.calls.filter(call => call[0][0] === 'log')).toHaveLength(1);
      expect(out).toMatchObject({ resolvedRef: oid, scanned: 3, scanMayBeTruncated: false, limit: 20 });
      expect(out.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-TASKGRAPH-1', 'RQ-AGENTSTATE-2']);
      expect(out.jobs[0]).toMatchObject({ matchesTruncated: false, paths: ['graph.ts'] });
      expect(out.jobs[0].commits[0]).toMatchObject({ pr: 301, paths: ['graph.ts'] });
      expect(out.jobs[1]).toMatchObject({ matchesTruncated: false, paths: ['state.ts'] });
      expect(out.jobs[1].commits[0]).toMatchObject({ pr: 302, paths: ['state.ts'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the single-id tool and unknown-tool rejection working', async () => {
    const jobHistory = vi.fn(async () => ({ ok: 1 }));
    const client = await connect(undefined, { jobHistory });
    await expect(client.callTool({ name: 'fleet_job_history_batch_delete' })).rejects.toMatchObject({ code: -32602 });
    expect(await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-X' } }))
      .toMatchObject({ content: [{ text: '{"ok":1}' }] });
  });
});
