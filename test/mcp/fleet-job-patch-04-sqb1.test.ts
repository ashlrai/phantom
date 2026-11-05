import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, MAX_FLEET_OUTPUT_BYTES, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetJobPatch } from '../../src/mcp/fleet-job-patch.js';
import { jobPatch } from '../../src/core/fleet/job-patch.js';

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(c => c.close())); });

async function connect(jobPatchReader?: FleetReaders['jobPatch']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'job-patch-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), jobPatch: jobPatchReader }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const text = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0].text;
const base = {
  schema: 'fleet.job-patch.v1', jobId: 'RQ-EXAMPLE-1', resolvedRef: 'a'.repeat(40), status: 'found', commit: 'b'.repeat(40),
  pr: 7, paths: ['src/a.ts'], selectedPath: null, scanBound: 1000, scanned: 3, scanMayBeTruncated: false,
  matchesTruncated: false, patch: 'diff --git a/src/a.ts b/src/a.ts\n+x\n', patchTruncated: false,
};
const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'fleet_job_patch', arguments: args });

describe('fleet_job_patch over MCP', () => {
  it('advertises a read-only schema with strict args', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_job_patch');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ required: ['jobId'], additionalProperties: false });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual(['jobId', 'path']);
    expect(tool?.description).toMatch(/never a correctness verdict or permission to merge/);
  });

  it('passes valid arguments to the injected reader and keeps caveats', async () => {
    const reader = vi.fn(async () => ({ ...base, status: 'not-found-in-bounded-scan', commit: null, pr: null, paths: [], patch: '',
      scanMayBeTruncated: true, matchesTruncated: true, selectedPath: 'src/a.ts', patchTruncated: true }));
    const client = await connect(reader);
    const out = JSON.parse(text(await call(client, { jobId: 'RQ-EXAMPLE-1', path: 'src/a.ts' })));
    expect(reader).toHaveBeenCalledWith({ jobId: 'RQ-EXAMPLE-1', path: 'src/a.ts' });
    expect(out).toMatchObject({ status: 'not-found-in-bounded-scan', scanMayBeTruncated: true, matchesTruncated: true,
      selectedPath: 'src/a.ts', patchTruncated: true, resolvedRef: 'a'.repeat(40) });
  });

  it.each([
    [{}], [{ jobId: 'rq bad' }], [{ jobId: 7 }], [{ jobId: 'RQ-EXAMPLE-1', cwd: '/tmp' }], [{ jobId: 'RQ-EXAMPLE-1', root: '/' }],
    [{ jobId: 'RQ-EXAMPLE-1', ref: 'HEAD' }], [{ jobId: 'RQ-EXAMPLE-1', path: '/etc/passwd' }], [{ jobId: 'RQ-EXAMPLE-1', path: '../x' }],
    [{ jobId: 'RQ-EXAMPLE-1', path: 'a//b' }], [{ jobId: 'RQ-EXAMPLE-1', path: 'a\\b' }], [{ jobId: 'RQ-EXAMPLE-1', path: '' }],
    [{ jobId: 'RQ-EXAMPLE-1', path: null }], [{ jobId: 'RQ-EXAMPLE-1', path: 3 }],
  ])('rejects %j before the reader runs', async args => {
    const reader = vi.fn(async () => base);
    await expect(call(await connect(reader), args)).rejects.toThrow(/Invalid fleet tool arguments/);
    expect(reader).not.toHaveBeenCalled();
  });

  it('scrubs secret-shaped output and reports sanitized errors', async () => {
    const secret = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(6);
    const ok = await call(await connect(async () => ({ ...base, patch: `+key=${secret}\n` })), { jobId: 'RQ-EXAMPLE-1' });
    expect(text(ok)).not.toContain(secret);
    const failing = await call(await connect(async () => { throw new Error(`boom /Users/x ${secret}`); }), { jobId: 'RQ-EXAMPLE-1' });
    expect(failing.isError).toBe(true);
    expect(text(failing)).not.toMatch(/boom|Users|sk-ant/);
    expect(text(failing)).not.toMatch(/not-found/);
  });

  it('clips oversized patches explicitly instead of failing or implying completeness', async () => {
    const patch = Array.from({ length: 4000 }, (_, i) => `+line "${i}" padding padding\n`).join('');
    const result = await call(await connect(input => readFleetJobPatch(input, { read: async () => ({ ...base, patch }) as never })), { jobId: 'RQ-EXAMPLE-1' });
    expect(result.isError).toBeFalsy();
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(MAX_FLEET_OUTPUT_BYTES);
    const out = JSON.parse(text(result));
    expect(out.outputClipped).toBe(true);
    expect(out.outputClippedBytes).toBe(Buffer.byteLength(patch) - Buffer.byteLength(out.patch));
    expect(out.patch.endsWith('\n')).toBe(true);
    expect(patch.startsWith(out.patch)).toBe(true);
  });
});

describe('fleet_job_patch with a real temporary git fixture', () => {
  it('preserves an actual landed job patch through the real reader', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'job-patch-')));
    const cwd = process.cwd();
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
      git('init', '-q', '-b', 'master');
      writeFileSync(join(dir, 'seed.txt'), 'seed\n'); git('add', '.'); git('commit', '-qm', 'seed');
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n'); writeFileSync(join(dir, 'src/b.ts'), 'export const b = 2;\n');
      git('add', '.'); git('commit', '-qm', 'bridge(RQ-FIXTURE-1): land a and b (#42)');
      git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      process.chdir(dir);
      const direct = await jobPatch('RQ-FIXTURE-1', 'src/a.ts');
      const viaTool = await readFleetJobPatch({ jobId: 'RQ-FIXTURE-1', path: 'src/a.ts' });
      expect(viaTool).toMatchObject({ status: 'found', pr: 42, selectedPath: 'src/a.ts', patchTruncated: false, outputClipped: false,
        resolvedRef: direct.resolvedRef, paths: ['src/a.ts', 'src/b.ts'] });
      expect(viaTool.patch).toBe(direct.patch);
      expect(viaTool.patch).toContain('+export const a = 1;');
      expect(viaTool.patch).not.toContain('b.ts');
      const missing = await readFleetJobPatch({ jobId: 'RQ-FIXTURE-2' });
      expect(missing).toMatchObject({ status: 'not-found-in-bounded-scan', patch: '' });
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
});
