import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetJobPrecheck, MAX_FLEET_JOB_PRECHECK_BYTES } from '../../src/mcp/fleet-job-precheck.js';
import type { JobPrecheckGit } from '../../src/core/fleet/job-precheck.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
});

async function connect(jobPrecheck?: FleetReaders['jobPrecheck'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'job-precheck-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({ pending: 2 }), loop: async () => ({}), ...readers, jobPrecheck }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const textOf = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

/** The injected projection: the server's reader slot with a fake git inside the real reader. */
const viaRealReader = (git: JobPrecheckGit) =>
  (input: Parameters<typeof readFleetJobPrecheck>[0]) => readFleetJobPrecheck(input, { git });

function fake(master: Record<string, string | null>): JobPrecheckGit & { probed: string[] } {
  const git = {
    probed: [] as string[],
    async exists(path: string) { git.probed.push(path); return Object.prototype.hasOwnProperty.call(master, path); },
    async lastCommit(path: string) {
      const subject = master[path];
      return subject ? { sha: 'abc1234', subject } : null;
    },
  };
  return git;
}

describe('fleet_job_precheck over MCP', () => {
  it('is advertised read-only with required markdown and an optional exact jobId', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_job_precheck');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        markdown: { type: 'string', minLength: 1, description: expect.stringContaining('8000') },
        jobId: { type: 'string', description: expect.stringContaining('exact') },
      },
      required: ['markdown'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/origin\/master/);
    expect(tool?.description).toMatch(/cannot prove semantic completion/);
    expect(tool?.description).toMatch(/never writes a file/i);
  });

  it('reports fresh when no named src path is on origin/master', async () => {
    const git = fake({ 'docs/guide.md': 'docs only' });
    const client = await connect(viaRealReader(git));
    const out = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'Add src/new.ts, test/new.test.ts and update docs/guide.md.' } }));
    expect(git.probed).toEqual(['src/new.ts', 'test/new.test.ts', 'docs/guide.md']);
    expect(out).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      ref: 'origin/master', verdict: 'fresh', newTestFiles: ['test/new.test.ts'],
      facts: [
        { path: 'src/new.ts', onMaster: false },
        { path: 'test/new.test.ts', onMaster: false },
        { path: 'docs/guide.md', onMaster: true, lastCommit: { sha: 'abc1234', subject: 'docs only' } },
      ],
    });
    expect(out).not.toHaveProperty('jobId');
    expect(out.note).toMatch(/recorded evidence/i);
    expect(out.note).toMatch(/cannot prove semantic completion/i);
  });

  it('reports partly-on-master when named src work is present without bridge evidence', async () => {
    const git = fake({ 'src/existing.ts': 'ordinary maintenance commit' });
    const client = await connect(viaRealReader(git));
    const out = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'Update src/existing.ts and src/new.ts.' } }));
    expect(out).toMatchObject({
      verdict: 'partly-on-master',
      facts: [
        { path: 'src/existing.ts', onMaster: true, lastCommit: { sha: 'abc1234', subject: 'ordinary maintenance commit' } },
        { path: 'src/new.ts', onMaster: false },
      ],
    });
  });

  it('reports likely-done when every named non-test src path landed under a bridge subject', async () => {
    const git = fake({ 'src/a.ts': 'bridge(RQ-EXAMPLE-1): landed (#42)', 'src/b.ts': 'also bridge(RQ-OTHER-9) in the subject' });
    const client = await connect(viaRealReader(git));
    const out = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts src/b.ts src/new.test.ts test/new.test.ts' } }));
    expect(out).toMatchObject({ verdict: 'likely-done', newTestFiles: ['src/new.test.ts', 'test/new.test.ts'] });
    expect(out.note).toMatch(/does not prove no overlapping work exists/i);
  });

  it('applies an exact optional jobId identity to each path\'s last commit', async () => {
    const git = fake({ 'src/a.ts': 'bridge(RQ-EXAMPLE-1): landed (#42)' });
    const client = await connect(viaRealReader(git));
    const match = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts', jobId: 'RQ-EXAMPLE-1' } }));
    expect(match).toMatchObject({ jobId: 'RQ-EXAMPLE-1', verdict: 'likely-done', facts: [{ onMaster: true, jobIdMatch: true }] });
    const other = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts', jobId: 'RQ-OTHER-1' } }));
    expect(other).toMatchObject({ jobId: 'RQ-OTHER-1', verdict: 'partly-on-master', facts: [{ onMaster: true, jobIdMatch: false }] });
    const prefix = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts', jobId: 'RQ-EXAMPLE-10' } }));
    expect(prefix.facts[0].jobIdMatch).toBe(false);
  });

  it('enforces the 8000-byte UTF-8 limit rather than a character count', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    // 2667 × U+754C is 8001 bytes: inside any character count, over the byte limit.
    await expect(client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: '界'.repeat(2667) } })).rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'a'.repeat(8001) } })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
    expect(MAX_FLEET_JOB_PRECHECK_BYTES).toBe(8000);
  });

  it('accepts a markdown body at exactly the byte limit', async () => {
    const git = fake({});
    const client = await connect(viaRealReader(git));
    const markdown = 'a'.repeat(7991) + ' src/x.ts'; // exactly 8000 UTF-8 bytes
    expect(Buffer.byteLength(markdown, 'utf8')).toBe(8000);
    const out = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown } }));
    expect(out.verdict).toBe('fresh');
    expect(git.probed).toEqual(['src/x.ts']);
    const multibyte = '界'.repeat(2666) + 'aa'; // also exactly 8000 bytes
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(8000);
    const again = parse(await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: multibyte } }));
    expect(again.verdict).toBe('fresh');
  });

  it.each([
    {},
    { markdown: 5 }, { markdown: null }, { markdown: true }, { markdown: [] }, { markdown: {} },
    { markdown: '' }, { markdown: '   \n  ' },
    { markdown: 'x', jobId: 5 }, { markdown: 'x', jobId: null }, { markdown: 'x', jobId: '' },
    { markdown: 'x', jobId: 'RQ-' }, { markdown: 'x', jobId: 'rq-x' }, { markdown: 'x', jobId: 'RQ-A B' },
    { markdown: 'x', jobId: 'RQ-A..B' }, { markdown: 'x', jobId: 'RQ-A/B' },
    { markdown: 'x', ref: 'HEAD' }, { markdown: 'x', ref: 'origin/master' },
    { markdown: 'x', path: 'src' }, { markdown: 'x', file: 'draft.md' },
    { markdown: 'x', root: '/' }, { markdown: 'x', cwd: '/tmp' },
    { markdown: 'x', extra: 1 }, { markdown: 'x', limit: 1 },
  ])('rejects invalid arguments before invoking git: %j', async args => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_job_precheck', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects a non-object arguments payload before invoking git', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_job_precheck', arguments: 'src/a.ts' as never })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it('reports a git failure as a sanitized tool error, never as a fresh verdict', async () => {
    const git: JobPrecheckGit = {
      exists: async () => { throw new Error('fatal: bad revision origin/master; token ghp_secretvalue'); },
      lastCommit: async () => null,
    };
    const client = await connect(viaRealReader(git));
    const result = await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/ghp_|bad revision|fresh/);
  });

  it('scrubs secret-shaped and home-path text inside returned evidence', async () => {
    const token = 'ghp_' + 'A1b2C3d4'.repeat(3);
    const home = process.env.HOME!;
    const git = fake({ 'src/a.ts': `bridge(RQ-EXAMPLE-1): leaked ${token} under ${home}/repo (#9)` });
    const client = await connect(viaRealReader(git));
    const raw = await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown: 'src/a.ts' } });
    const text = textOf(raw);
    expect(raw.isError).not.toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain(home);
    expect(text).toContain('REDACTED');
    expect(text).toContain('~');
  });

  it('never echoes the submitted markdown in the report', async () => {
    const markdown = 'UNIQUE-DRAFT-PROSE rework src/a.ts with internal notes nobody should see';
    const client = await connect(viaRealReader(fake({})));
    const raw = await client.callTool({ name: 'fleet_job_precheck', arguments: { markdown } });
    const text = textOf(raw);
    expect(text).not.toContain('UNIQUE-DRAFT-PROSE');
    expect(text).not.toContain('internal notes');
    expect(JSON.parse(text).facts.map((fact: { path: string }) => fact.path)).toEqual(['src/a.ts']);
  });

  it('leaves the existing fleet_job_history tool listed and working unchanged', async () => {
    const jobHistory = vi.fn(async () => ({ jobId: 'RQ-X', ref: 'origin/master', scanned: 0, commits: [], paths: [] }));
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader, { jobHistory });
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('fleet_job_history');
    expect(names).toContain('fleet_job_precheck');
    const out = parse(await client.callTool({ name: 'fleet_job_history', arguments: { jobId: 'RQ-X' } }));
    expect(jobHistory).toHaveBeenCalledWith({ jobId: 'RQ-X', limit: 20 });
    expect(out.jobId).toBe('RQ-X');
    expect(reader).not.toHaveBeenCalled();
    await expect(client.callTool({ name: 'fleet_job_precheck_delete' })).rejects.toMatchObject({ code: -32602 });
  });
});
