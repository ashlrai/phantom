import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  readFleetPathHistory, type FleetPathHistoryArgs, type FleetPathHistoryDeps,
} from '../../src/mcp/fleet-path-history.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
});

async function connect(pathHistory?: FleetReaders['pathHistory'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'path-history-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, pathHistory }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

/** The injected projection: the server's reader slot with a fake git log inside the real adapter. */
const viaRealReader = (log: NonNullable<FleetPathHistoryDeps['log']>) =>
  (input: FleetPathHistoryArgs) => readFleetPathHistory(input, { log });

const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40), SHA3 = 'c'.repeat(40), SHA4 = 'd'.repeat(40);
const commit = (sha: string, date: string, subject: string) => ({ sha, date, subject });

describe('fleet_path_history over MCP', () => {
  it('is advertised read-only with a required literal path and a bounded limit', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_path_history');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: expect.stringContaining('literal pathspec') },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['path'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/origin\/master/);
    expect(tool?.description).toMatch(/does not prove no job landed work on the path/i);
  });

  it('passes a spaced path verbatim to the injected git log and deduplicates job ids', async () => {
    const log = vi.fn(async () => [
      commit(SHA1, '2026-10-31T00:33:00Z', 'bridge(RQ-EXAMPLE-1): landed one (#101)'),
      commit(SHA2, '2026-10-30T23:51:00Z', 'plain commit'),
      commit(SHA3, '2026-10-30T22:00:00Z', 'bridge(RQ-OTHER-2): landed two (#102)'),
      commit(SHA4, '2026-10-30T21:00:00Z', 'bridge(RQ-EXAMPLE-1): same job, older (#101)'),
    ]);
    const client = await connect(viaRealReader(log));
    const out = parse(await client.callTool({ name: 'fleet_path_history', arguments: { path: 'src/mcp/fleet server.ts', limit: 5 } }));
    expect(log).toHaveBeenNthCalledWith(1, 'src/mcp/fleet server.ts', 15);
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      path: 'src/mcp/fleet server.ts', ref: 'origin/master',
      scanBound: 15, scanned: 4, scanMayBeTruncated: false,
      limit: 5, matchesTruncated: false,
      jobs: [
        { jobId: 'RQ-EXAMPLE-1', pr: 101, sha: SHA1, date: '2026-10-31T00:33:00Z', title: 'landed one' },
        { jobId: 'RQ-OTHER-2', pr: 102, sha: SHA3, date: '2026-10-30T22:00:00Z', title: 'landed two' },
      ],
    });
  });

  it('applies the default limit of 20 and reports an empty bounded scan honestly', async () => {
    const log = vi.fn(async () => []);
    const client = await connect(viaRealReader(log));
    const out = parse(await client.callTool({ name: 'fleet_path_history', arguments: { path: 'a.ts' } }));
    expect(log).toHaveBeenCalledWith('a.ts', 60);
    expect(out).toMatchObject({ limit: 20, scanBound: 60, scanned: 0, jobs: [] });
    expect(out.note).toMatch(/does not prove no fleet job landed work on this path/i);
  });

  it.each(['src/[a-z].ts', 'src/*.ts', 'x?.ts', 'docs/{a,b}.md', '-leading-dash.ts'])(
    'forwards pathspec metacharacters untouched for literal handling: %s', async path => {
      const log = vi.fn(async () => []);
      const client = await connect(viaRealReader(log));
      await client.callTool({ name: 'fleet_path_history', arguments: { path } });
      expect(log).toHaveBeenCalledWith(path, 60);
    });

  it('reports bounded-scan metadata: scan bound, scanned count and both caps', async () => {
    const log = async () => [
      commit(SHA1, 'd1', 'bridge(RQ-A-1): first (#1)'),
      commit(SHA2, 'd2', 'bridge(RQ-B-2): second (#2)'),
      commit(SHA3, 'd3', 'plain tail'),
    ];
    const client = await connect(viaRealReader(log));
    const out = parse(await client.callTool({ name: 'fleet_path_history', arguments: { path: 'x.ts', limit: 1 } }));
    expect(out).toMatchObject({ scanBound: 3, scanned: 3, scanMayBeTruncated: true, limit: 1, matchesTruncated: true });
    expect(out.jobs).toHaveLength(1);
  });

  it('sanitizes secret-shaped and home-path text inside returned evidence', async () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(3);
    const home = process.env.HOME!;
    const log = async () => [commit(SHA1, 'd', `bridge(RQ-LEAK-1): token ${token} in ${home}/x.ts (#5)`)];
    const client = await connect(viaRealReader(log));
    const raw = await client.callTool({ name: 'fleet_path_history', arguments: { path: 'x.ts' } });
    const text = (raw.content as Array<{ text: string }>)[0].text;
    expect(raw.isError).not.toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain(home);
    expect(text).toContain('REDACTED');
    expect(text).toContain('~');
  });

  it.each([
    {},
    { path: 5 }, { path: null }, { path: '' }, { path: '.' },
    { path: '/abs/x.ts' }, { path: '~/x.ts' }, { path: 'C:\\x.ts' }, { path: '\\\\share\\x' },
    { path: '..' }, { path: '../x' }, { path: 'a/../b' }, { path: 'a/b/..' }, { path: 'a\\..\\b' }, { path: 'a\\b' },
    { path: 'a\nb' }, { path: 'a\tb' }, { path: 'a\x07b' }, { path: ':(glob)src/*.ts' },
    { path: 'x', limit: 0 }, { path: 'x', limit: 101 }, { path: 'x', limit: 1.5 },
    { path: 'x', limit: '2' }, { path: 'x', limit: null },
    { path: 'x', ref: 'HEAD' }, { path: 'x', jobId: 'RQ-X' },
    { path: 'x', cwd: '/tmp' }, { path: 'x', root: '/' }, { path: 'x', extra: 1 },
  ])('rejects invalid arguments before any read: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_path_history', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a git failure as a tool error, never as fabricated empty history', async () => {
    const client = await connect(async () => { throw new Error('fatal: not a git repo; token ghp_secretvalue'); });
    const result = await client.callTool({ name: 'fleet_path_history', arguments: { path: 'x.ts' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/ghp_|not a git repo/);
  });

  it('keeps unknown-tool rejection and leaves existing tools working', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_path_history_delete' })).rejects.toMatchObject({ code: -32602 });
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ pending: 2 });
  });

  it('reads a real temp repository: a spaced filename lands, metacharacters stay literal', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-path-history-'));
    const cwd = process.cwd();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
      for (const [file, subject] of [
        ['file with spaces.txt', 'bridge(RQ-SPACE-01): spaced file (#11)'],
        ['literal x.txt', 'bridge(RQ-GLOB-99): decoy only a glob would add (#12)'],
        ['literal [x].txt', 'bridge(RQ-LIT-7): bracket file (#13)'],
      ]) {
        writeFileSync(join(dir, file), file);
        git('add', '-A'); git('commit', '-m', subject);
      }
      git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      process.chdir(dir);
      const client = await connect();
      const spaced = parse(await client.callTool({ name: 'fleet_path_history', arguments: { path: 'file with spaces.txt' } }));
      expect(spaced.jobs).toEqual([
        { jobId: 'RQ-SPACE-01', pr: 11, sha: expect.any(String), date: expect.any(String), title: 'spaced file' },
      ]);
      expect(spaced).toMatchObject({ ref: 'origin/master', scanned: 1, scanMayBeTruncated: false });
      // `literal [x].txt` expanded as glob magic would also match the RQ-GLOB-99 decoy.
      const literal = parse(await client.callTool({ name: 'fleet_path_history', arguments: { path: 'literal [x].txt' } }));
      expect(literal.jobs.map((job: { jobId: string }) => job.jobId)).toEqual(['RQ-LIT-7']);
      const absent = parse(await client.callTool({ name: 'fleet_path_history', arguments: { path: 'never/committed.ts' } }));
      expect(absent.jobs).toEqual([]);
      expect(absent.note).toMatch(/does not prove/i);
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
});
