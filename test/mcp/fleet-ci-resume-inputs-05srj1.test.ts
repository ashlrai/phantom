import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { MAX_FLEET_CI_RESUME_INPUT_BYTES, readFleetCiResumeInputs } from '../../src/mcp/fleet-ci-resume-inputs.js';
import { planCiResumeInputs } from '../../src/core/fleet/ci-resume-inputs.js';
import { defaultGitRunner, type GitRunner } from '../../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const GIT_ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 << 20 });
const commit = (root: string): string => {
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c');
  return git(root, 'rev-parse', 'HEAD').trim();
};

const manifest = () => ({ version: 1, repo: REPO, shared: ['package-lock.json'], jobs: [
  { id: 'job-a', command: 'npm run test:a', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/a'] },
  { id: 'job-b', command: 'npm run test:b', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/b'] },
] });
const receipt = (job: string, inputsDigest: string, extra: Record<string, unknown> = {}) =>
  ({ job, run: 991, attempt: 2, jobId: 7000, conclusion: 'success', inputsDigest, ...extra });
const prior = (receipts: unknown[], repo = REPO) => ({ version: 1, repo, receipts });

// One read-only fixture: the planner never writes to the repository.
const dirs: string[] = [];
let root: string, base: string, head: string, digests: Record<string, string>;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcp-ci-resume-')); dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  const put = (p: string, c: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); };
  put('src/a/x.ts', 'a\n'); put('src/b/y.ts', 'b\n'); put('package-lock.json', '{}\n'); put('docs/readme.md', 'd\n');
  base = commit(root);
  const seed = await planCiResumeInputs({ manifest: manifest(), prior: prior([]), base, head: base, cwd: root });
  digests = Object.fromEntries(seed.jobs.map((j) => [j.job, j.baseDigest]));
  writeFileSync(join(root, 'src/b/y.ts'), 'b changed\n');
  head = commit(root);
});
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map((c) => c.close())); });

async function connect(ciResumeInputs?: FleetReaders['ciResumeInputs'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ci-resume-inputs-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers, ciResumeInputs }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const textOf = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;
const job = (plan: { jobs: Array<{ job: string }> }, id: string) => plan.jobs.find((j) => j.job === id)!;
const baseArgs = (over: Record<string, unknown> = {}) => ({ manifest: manifest(), prior: prior([]), base, head, ...over });

describe('fleet_ci_resume_inputs over MCP', () => {
  it('is advertised read-only with the four required inputs and no caller selectors', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'fleet_ci_resume_inputs');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        manifest: { type: 'object', description: expect.stringContaining('never a file path') },
        prior: { type: 'object', description: expect.stringContaining('never a file path') },
        base: { type: 'string', pattern: '^[0-9a-fA-F]{4,64}$', description: expect.stringContaining('exadecimal') },
        head: { type: 'string', pattern: '^[0-9a-fA-F]{4,64}$', description: expect.stringContaining('fix') },
      },
      required: ['manifest', 'prior', 'base', 'head'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/planCiResumeInputs/);
    expect(tool?.description).toMatch(/server's own cwd/);
    expect(tool?.description).toMatch(/never posts a status/i);
  });

  it('returns the shared planner verdict over a real two-commit repository', async () => {
    const calls: string[][] = [];
    const recordingGit: GitRunner = async (bin, argv, opts) => {
      calls.push([bin, ...argv]);
      return defaultGitRunner(bin, argv, opts);
    };
    const client = await connect((input) => readFleetCiResumeInputs(input, { cwd: root, git: recordingGit }));
    const priors = prior([receipt('job-a', digests['job-a']!), receipt('job-b', digests['job-b']!)]);
    const result = await client.callTool({ name: 'fleet_ci_resume_inputs',
      arguments: { manifest: manifest(), prior: priors, base, head } });
    expect(result.isError).not.toBe(true);
    const out = parse(result);
    const direct = await planCiResumeInputs({ manifest: manifest(), prior: priors, base, head, cwd: root });
    expect(out.plan).toEqual(direct);
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none' });
    expect(out.note).toMatch(/advisory/i);
    expect(job(out.plan, 'job-a')).toMatchObject({
      decision: 'reuse', reasons: ['inputs_unchanged'], baseDigest: digests['job-a'], headDigest: digests['job-a'],
    });
    expect(job(out.plan, 'job-b')).toMatchObject({ decision: 'rerun', changedCoveredPaths: ['src/b/y.ts'] });
    expect(job(out.plan, 'job-b').reasons).toContain('inputs_changed');
    expect(out.plan.summary).toEqual({ reuse: 1, rerun: 1 });
    expect(out.plan.unmappedChangedPaths).toEqual([]);
    // Read-only plumbing only: no checkout, write, status or workflow call.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c[0] === 'git' && ['rev-parse', 'ls-tree', 'diff-tree'].includes(c[1]!))).toBe(true);
  });

  it('reruns jobs whose prior receipts failed or carry unverified digests', async () => {
    const client = await connect((input) => readFleetCiResumeInputs(input, { cwd: root }));
    for (const conclusion of ['failure', 'cancelled']) {
      const out = parse(await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: {
        manifest: manifest(),
        prior: prior([receipt('job-a', digests['job-a']!, { conclusion }), receipt('job-b', digests['job-b']!)]),
        base, head: base } }));
      expect(job(out.plan, 'job-a')).toMatchObject({ decision: 'rerun' });
      expect(job(out.plan, 'job-a').reasons).toContain('prior_not_success');
      expect(job(out.plan, 'job-b')).toMatchObject({ decision: 'reuse' });
    }
    const foreign = `sha256:${'0'.repeat(64)}`;
    const out = parse(await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: {
      manifest: manifest(), prior: prior([receipt('job-a', foreign)]), base, head: base } }));
    expect(job(out.plan, 'job-a')).toMatchObject({ decision: 'rerun' });
    expect(job(out.plan, 'job-a').reasons).toContain('prior_digest_unverified');
    expect(job(out.plan, 'job-b').reasons).toEqual(['no_prior_receipt']);
  });

  it('rejects prior receipts on repo mismatch instead of reusing them', async () => {
    const client = await connect((input) => readFleetCiResumeInputs(input, { cwd: root }));
    const out = parse(await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: {
      manifest: manifest(),
      prior: prior([receipt('job-a', digests['job-a']!), receipt('job-b', digests['job-b']!)], 'other/repo'),
      base, head: base } }));
    for (const j of out.plan.jobs as Array<{ decision: string; reasons: string[] }>) {
      expect(j.decision).toBe('rerun');
      expect(j.reasons).toEqual(['prior_repo_mismatch']);
    }
  });

  it('keeps unmapped coverage a rerun even with verified receipts', async () => {
    writeFileSync(join(root, 'docs/readme.md'), 'doc changed\n');
    const head2 = commit(root);
    const client = await connect((input) => readFleetCiResumeInputs(input, { cwd: root }));
    const out = parse(await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: {
      manifest: manifest(),
      prior: prior([receipt('job-a', digests['job-a']!), receipt('job-b', digests['job-b']!)]),
      base, head: head2 } }));
    expect(out.plan.unmappedChangedPaths).toEqual(['docs/readme.md']);
    expect(job(out.plan, 'job-a')).toMatchObject({ decision: 'rerun', reasons: ['unmapped_changes'] });
    expect(job(out.plan, 'job-b').reasons).toEqual(expect.arrayContaining(['inputs_changed', 'unmapped_changes']));
  });

  // Lazy factories: the table is built before beforeAll resolves base/head.
  it.each<[string, () => Record<string, unknown>]>([
    ['injected cwd', () => ({ ...baseArgs(), cwd: '/tmp' })],
    ['injected root', () => ({ ...baseArgs(), root: '/' })],
    ['injected path', () => ({ ...baseArgs(), path: 'src/a' })],
    ['injected dir', () => ({ ...baseArgs(), dir: '.' })],
    ['injected repo', () => ({ ...baseArgs(), repo: REPO })],
    ['injected git', () => ({ ...baseArgs(), git: {} })],
    ['injected env', () => ({ ...baseArgs(), env: {} })],
    ['injected executable', () => ({ ...baseArgs(), executable: 'git' })],
    ['injected gitOptions', () => ({ ...baseArgs(), gitOptions: [] })],
    ['injected ref', () => ({ ...baseArgs(), ref: 'main' })],
    ['injected extra key', () => ({ ...baseArgs(), extra: 1 })],
    ['injected limit', () => ({ ...baseArgs(), limit: 1 })],
    ['missing manifest', () => ({ prior: prior([]), base, head })],
    ['missing prior', () => ({ manifest: manifest(), base, head })],
    ['missing head', () => ({ manifest: manifest(), prior: prior([]), base })],
    ['missing base', () => ({ manifest: manifest(), prior: prior([]), head })],
    ['manifest as a file path', () => ({ ...baseArgs(), manifest: 'manifest.json' })],
    ['manifest as an array', () => ({ ...baseArgs(), manifest: ['./x'] })],
    ['manifest null', () => ({ ...baseArgs(), manifest: null })],
    ['manifest number', () => ({ ...baseArgs(), manifest: 5 })],
    ['manifest boolean', () => ({ ...baseArgs(), manifest: true })],
    ['prior as a file path', () => ({ ...baseArgs(), prior: 'prior.json' })],
    ['prior as an array', () => ({ ...baseArgs(), prior: [] })],
    ['prior number', () => ({ ...baseArgs(), prior: 5 })],
    ['base a ref name', () => ({ ...baseArgs(), base: 'HEAD' })],
    ['base a branch name', () => ({ ...baseArgs(), base: 'main' })],
    ['base non-hex', () => ({ ...baseArgs(), base: 'zz' })],
    ['head a revision expression', () => ({ ...baseArgs(), head: 'HEAD~1' })],
    ['head non-hex suffix', () => ({ ...baseArgs(), head: 'abc123!' })],
    ['base a number', () => ({ ...baseArgs(), base: 12345 })],
    ['manifest wrong version', () => ({ ...baseArgs(), manifest: { version: 2, repo: REPO, jobs: [{ id: 'j', command: 'c', os: 'o', arch: 'a', toolchain: 't', paths: ['x'] }] } })],
    ['manifest empty jobs', () => ({ ...baseArgs(), manifest: { version: 1, repo: REPO, jobs: [] } })],
    ['manifest invalid repo', () => ({ ...baseArgs(), manifest: { version: 1, repo: 'not a repo', jobs: [{ id: 'j', command: 'c', os: 'o', arch: 'a', toolchain: 't', paths: ['x'] }] } })],
    ['manifest traversal path', () => ({ ...baseArgs(), manifest: { version: 1, repo: REPO, jobs: [{ id: 'j', command: 'c', os: 'o', arch: 'a', toolchain: 't', paths: ['../escape'] }] } })],
    ['prior receipts not an array', () => ({ ...baseArgs(), prior: { version: 1, repo: REPO, receipts: 'x' } })],
    ['prior receipt missing digest', () => ({ ...baseArgs(), prior: { version: 1, repo: REPO, receipts: [{ job: 'job-a', run: 1, conclusion: 'success' }] } })],
  ])('rejects injected, missing or malformed arguments before the reader: %s', async (_label, bad) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_ci_resume_inputs', arguments: bad() })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('bounds oversized serialized manifest and prior documents before the reader', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    const filler = 'x'.repeat(MAX_FLEET_CI_RESUME_INPUT_BYTES);
    expect(MAX_FLEET_CI_RESUME_INPUT_BYTES).toBe(1024 * 1024);
    for (const over of [{ manifest: { ...manifest(), filler } }, { prior: { ...prior([]), filler } }]) {
      await expect(client.callTool({ name: 'fleet_ci_resume_inputs', arguments: { ...baseArgs(), ...over } }))
        .rejects.toMatchObject({ code: -32602 });
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects a non-object arguments payload before the reader', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_ci_resume_inputs', arguments: 'manifest.json' as never })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it('sanitizes an unexpected reader exception', async () => {
    const client = await connect(async () => { throw new Error('private-planner-detail'); });
    const result = await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: baseArgs() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toContain('private-planner-detail');
  });

  it('reports a git failure as a sanitized tool error, never a fabricated verdict', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mcp-ci-resume-empty-')); dirs.push(empty);
    const client = await connect((input) => readFleetCiResumeInputs(input, { cwd: empty }));
    const result = await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: baseArgs() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toMatch(/rerun|reuse|rev-parse|fatal/i);
  });

  it('leaves the rest of the read-only surface listed and rejects mutation-sounding names', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader, { status: async () => ({ pending: 1 }) });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('fleet_ci_resume_inputs');
    expect(names).toContain('fleet_status');
    expect(parse(await client.callTool({ name: 'fleet_status' }))).toEqual({ pending: 1 });
    for (const name of ['fleet_ci_resume', 'fleet_ci_resume_inputs_apply', 'fleet_ci_rerun']) {
      await expect(client.callTool({ name })).rejects.toMatchObject({ code: -32602 });
    }
    expect(reader).not.toHaveBeenCalled();
  });
});
