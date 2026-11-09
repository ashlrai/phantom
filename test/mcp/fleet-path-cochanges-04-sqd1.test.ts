import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pathCochanges } from '../../src/core/fleet/path-cochanges.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetPathCochanges } from '../../src/mcp/fleet-path-cochanges.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(reader?: FleetReaders['pathCochanges']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cochanges-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({ ok: true }), loop: async () => ({}), pathCochanges: reader }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const sha = (c: string) => c.repeat(40);

describe('fleet_path_cochanges over MCP', () => {
  it('advertises a strict read-only schema and keeps the existing tools listed', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'fleet_path_cochanges');
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
    expect(tool?.description).toMatch(/does not prove a dependency or authorize edits/i);
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(
      ['fleet_status', 'fleet_path_history', 'fleet_job_overlap', 'fleet_job_history']));
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ ok: true });
  });

  it('runs the shared core reader once and preserves evidence, counts and every truncation flag', async () => {
    const log = `${sha('a')}\0bridge(RQ-A-1): first\0${sha('b')}\0plain subject\0${sha('c')}\0bridge(RQ-C-3): third\0`;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return `${sha('d')}\n`;
      if (args[0] === '--literal-pathspecs' && args[1] === 'log') return log;
      if (args[0] === 'diff-tree') {
        return args.at(-2) === sha('a') ? 'src/shared.ts\0src/a.ts\0src/x.ts\0' : 'src/shared.ts\0src/x.ts\0';
      }
      throw new Error('unexpected git');
    });
    const read = vi.fn((path: string, options?: { limit?: number }) => pathCochanges(path, { ...options, git: run }));
    const client = await connect(input => readFleetPathCochanges(input, { read }));
    const out = parse(await client.callTool({ name: 'fleet_path_cochanges', arguments: { path: 'src/shared.ts', limit: 5 } }));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('src/shared.ts', { limit: 5 });
    expect(run.mock.calls.filter(call => call[0][0] === '--literal-pathspecs')).toHaveLength(1);
    // Only the two bridge-subject commits are inspected; the plain subject is skipped.
    expect(run.mock.calls.filter(call => call[0][0] === 'diff-tree')).toHaveLength(2);
    expect(out).toMatchObject({
      snapshotKind: 'local-persisted', authority: 'none',
      path: 'src/shared.ts', resolvedRef: sha('d'),
      sampledCount: 3, examinedCount: 2,
      commitsTruncated: false, matchesTruncated: false, pathsTruncated: false, omittedPaths: 0,
      paths: [
        { path: 'src/x.ts', count: 2, evidence: [{ sha: sha('a'), jobId: 'RQ-A-1' }, { sha: sha('c'), jobId: 'RQ-C-3' }] },
        { path: 'src/a.ts', count: 1, evidence: [{ sha: sha('a'), jobId: 'RQ-A-1' }] },
      ],
      notice: 'Cochange evidence does not prove a dependency or authorize edits.',
    });
    expect(out.generatedAt).toEqual(expect.any(String));
  });

  it('forwards literal bracket and leading-dash paths verbatim with the default limit', async () => {
    for (const path of ['literal [x].txt', '-leading-dash.ts', 'dir/file with spaces.ts']) {
      const read = vi.fn(async () => ({
        path, resolvedRef: sha('d'), sampledCount: 0, examinedCount: 0,
        commitsTruncated: false, matchesTruncated: false, pathsTruncated: false, omittedPaths: 0,
        paths: [], notice: 'Cochange evidence does not prove a dependency or authorize edits.',
      }));
      const client = await connect(input => readFleetPathCochanges(input, { read }));
      await client.callTool({ name: 'fleet_path_cochanges', arguments: { path } });
      expect(read).toHaveBeenCalledWith(path, { limit: 20 });
    }
  });

  it('applies the shared public scrub to evidence and keeps explicit truncation flags', async () => {
    const home = process.env.HOME!;
    const read = vi.fn(async (path: string) => ({
      path, resolvedRef: sha('d'), sampledCount: 100, examinedCount: 20,
      commitsTruncated: true, matchesTruncated: true, pathsTruncated: true, omittedPaths: 3,
      paths: [{ path: `${home}/docs/example.txt`, count: 7, evidence: [{ sha: sha('e'), jobId: 'RQ-LEAK-1' }] }],
      notice: 'Cochange evidence does not prove a dependency or authorize edits.',
    }));
    const client = await connect(input => readFleetPathCochanges(input, { read }));
    const raw = await client.callTool({ name: 'fleet_path_cochanges', arguments: { path: 'x.ts', limit: 1 } });
    expect(read).toHaveBeenCalledWith('x.ts', { limit: 1 });
    expect(parse(raw)).toMatchObject({ commitsTruncated: true, matchesTruncated: true, pathsTruncated: true, omittedPaths: 3 });
    expect(JSON.stringify(raw)).not.toContain(home);
    expect(JSON.stringify(raw)).toContain('~');
  });

  it.each([
    {},
    { path: 5 }, { path: null }, { path: '' }, { path: '.' },
    { path: '/abs/x.ts' }, { path: 'C:\\x.ts' }, { path: '\\\\share\\x' },
    { path: '..' }, { path: '../x' }, { path: 'a/../b' }, { path: 'a/b/..' }, { path: 'a\\b' },
    { path: 'a//b' }, { path: 'trailing/' }, { path: 'a\nb' }, { path: 'a\tb' }, { path: 'a\x7fb' },
    { path: 'x', limit: 0 }, { path: 'x', limit: 101 }, { path: 'x', limit: 1.5 },
    { path: 'x', limit: '2' }, { path: 'x', limit: null },
    { path: 'x', ref: 'HEAD' }, { path: 'x', cwd: '/tmp' }, { path: 'x', root: '/' },
    { path: 'x', executable: 'git' }, { path: 'x', jobId: 'RQ-X' }, { path: 'x', extra: 1 },
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_path_cochanges', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports reader failures as a sanitized tool error, never fabricated evidence', async () => {
    const client = await connect(async () => { throw new Error('fatal: private local detail'); });
    const result = await client.callTool({ name: 'fleet_path_cochanges', arguments: { path: 'x.ts' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/private local detail/);
  });

  it('rejects unknown tools without disturbing the rest of the server', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_path_cochanges_write' })).rejects.toMatchObject({ code: -32602 });
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ ok: true });
  });

  it('reads a real temp repository through the production default: literal names stay exact', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-cochanges-'));
    const cwd = process.cwd();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    const commit = (subject: string, files: string[]) => {
      for (const name of files) writeFileSync(join(dir, name), `${subject}\n`);
      git('add', '--all'); git('commit', '-m', subject);
      return git('rev-parse', 'HEAD').trim();
    };
    try {
      git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
      const first = commit('bridge(RQ-LIT-7): bracket file (#13)', ['literal [x].txt', 'shared space.txt', 'a.txt']);
      commit('plain commit', ['literal [x].txt', 'plain.txt']);
      const second = commit('bridge(RQ-LIT-7): again (#14)', ['literal [x].txt', 'shared space.txt']);
      git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      process.chdir(dir);
      const client = await connect();
      const out = parse(await client.callTool({ name: 'fleet_path_cochanges', arguments: { path: 'literal [x].txt' } }));
      expect(out).toMatchObject({ path: 'literal [x].txt', sampledCount: 3, examinedCount: 2,
        paths: [{ path: 'shared space.txt', count: 2, evidence: [{ sha: second, jobId: 'RQ-LIT-7' }, { sha: first, jobId: 'RQ-LIT-7' }] },
          { path: 'a.txt', count: 1 }] });
      expect(JSON.stringify(out)).not.toContain('plain.txt');
      expect(out.notice).toMatch(/does not prove/i);
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
});
