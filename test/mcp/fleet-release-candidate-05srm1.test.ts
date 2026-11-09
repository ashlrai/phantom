/**
 * RQ-PHX-MCPCANDIDATE05SRM1 — fleet_release_candidate: read-only release
 * diagnostics through the isolated fleet MCP server so a shell-free release
 * supervisor can inspect the exact candidate, the gate artifact and the
 * master-moved blocker. The tool delegates to the same planReleaseCandidate
 * planner as `ashlr fleet release-candidate` — never a second release
 * implementation.
 *
 * Hermetic: in-memory MCP transports, an injected planner and fake `gh api`
 * route maps; no live GitHub, no local signing, no filesystem state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  parseFleetReleaseCandidateArgs, readFleetReleaseCandidate,
  type FleetReleaseCandidateDeps,
} from '../../src/mcp/fleet-release-candidate.js';
import type { ReleaseCandidatePlan } from '../../src/core/fleet/release-candidate-plan.js';
import type { GitRunner, GitRunResult } from '../../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.7'; // Fixture tag only, not production state.
const CAND = 'a'.repeat(40);
const TREE_C = 'b'.repeat(40);
const MASTER = 'c'.repeat(40);
const TREE_M = 'd'.repeat(40);
const GATE = 777001;
const ART = 555001;
const ATTEST_FAIL = 888001;
const base = `repos/${REPO}`;

const res = (code: number, stdout: unknown, stderr = ''): GitRunResult =>
  ({ code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr, timedOut: false, truncated: false, missing: false });
const ok = (body: unknown) => res(0, body);
const busted = () => res(1, '', 'gh: boom');
const run = (id: number, sha: string, patch: Record<string, unknown> = {}) => ({
  id, run_attempt: 1, head_sha: sha, head_branch: 'master', status: 'completed',
  conclusion: 'success', event: 'workflow_dispatch', repository: { full_name: REPO }, ...patch,
});
const runs = (rows: unknown[]) => ({ total_count: rows.length, workflow_runs: rows });
const ciRun = (sha: string, patch: Record<string, unknown> = {}) => run(GATE, sha, { path: '.github/workflows/ci.yml', ...patch });
const branch = (sha: string, tree: string) => ok({ name: 'master', commit: { sha, commit: { tree: { sha: tree } } } });
const masterAt = (sha: string, tree: string) => ({ [`${base}/branches/master`]: branch(sha, tree) });
const releaseRows = (patch: Record<string, unknown> = {}) =>
  ok([{ id: 42, tag_name: TAG, draft: true, prerelease: false, assets: [], target_commitish: CAND, ...patch }]);

/** Default fixture: master moved after a green gate (the reported mismatch). */
const routes = (patch: Record<string, GitRunResult> = {}): Record<string, GitRunResult> => ({
  [base]: ok({ full_name: REPO, default_branch: 'master' }),
  [`${base}/git/ref/tags/${TAG}`]: ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: CAND } }),
  [`${base}/git/commits/${CAND}`]: ok({ sha: CAND, tree: { sha: TREE_C } }),
  [`${base}/branches/master`]: branch(MASTER, TREE_M),
  [`${base}/releases?per_page=100&page=1`]: releaseRows(),
  [`${base}/actions/workflows/ci.yml/runs?head_sha=${CAND}&branch=master&per_page=100`]: ok(runs([ciRun(CAND)])),
  [`${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`]:
    ok(runs([run(ATTEST_FAIL, MASTER, { path: '.github/workflows/attest-ci-build.yml', conclusion: 'failure', event: 'schedule' })])),
  [`${base}/actions/runs/${GATE}/artifacts?per_page=100`]:
    ok({ total_count: 1, artifacts: [{ id: ART, name: `ashlr-build-${GATE}-1`, digest: `sha256:${'f'.repeat(64)}`, expired: false }] }),
  ...patch,
});
function fake(map: Record<string, GitRunResult>) {
  const calls: string[][] = [];
  const gh: GitRunner = async (bin, argv) => {
    calls.push([...argv]);
    return argv[0] === 'api' ? map[argv[1]!] ?? busted() : busted();
  };
  return { gh, calls };
}

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});

async function connect(releaseCandidate?: FleetReaders['releaseCandidate']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), releaseCandidate });
  const client = new Client({ name: 'release-candidate-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

/** The real adapter through the real server, with planner seams injected. */
function realReader(deps: FleetReleaseCandidateDeps = {}): FleetReaders['releaseCandidate'] {
  return async (input) => readFleetReleaseCandidate(input, deps);
}

describe('fleet_release_candidate over MCP', () => {
  it('is advertised read-only with a strict repo/tag schema and master-moved diagnostics', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_release_candidate');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.description).toMatch(/[Rr]ead-only/);
    expect(tool?.description).toMatch(/master[- ]moved|masterMoved/);
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        repo: { type: 'string', pattern: String.raw`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$`, description: expect.any(String) },
        tag: { type: 'string', pattern: String.raw`^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$`, description: expect.any(String) },
      },
      required: ['repo', 'tag'],
      additionalProperties: false,
    });
  });

  it('invokes the injected reader exactly once with the validated arguments', async () => {
    const reader = vi.fn(async () => ({ seen: true }));
    const client = await connect(reader);
    expect(parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }))).toEqual({ seen: true });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith({ repo: REPO, tag: TAG });
  });

  it('reaches the injected planner exactly once, with no candidate-sha override', async () => {
    const minimal = { version: 1, repo: REPO, tag: TAG, outcome: 'unknown' } as ReleaseCandidatePlan;
    const plan = vi.fn(async (_repo: string, _tag: string, _opts?: { runner?: GitRunner; candidateSha?: string }) => minimal);
    const client = await connect(realReader({ plan }));
    const out = parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }));
    expect(plan).toHaveBeenCalledTimes(1);
    const [repo, tag, opts] = plan.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(tag).toBe(TAG);
    expect(opts?.candidateSha).toBeUndefined();
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'remote-api', authority: 'none', plan: { outcome: 'unknown' } });
  });

  it.each([
    { repo: REPO },
    { tag: TAG },
    { repo: REPO, tag: 'latest' },
    { repo: REPO, tag: '1.2.3' },
    { repo: REPO, tag: 'v1.2' },
    { repo: REPO, tag: 'v1.02.3' },
    { repo: REPO, tag: 'v1.2.3-rc1' },
    { repo: 'bad/repo!', tag: TAG },
    { repo: 'a--b/x', tag: TAG },
    { repo: 'a-/x', tag: TAG },
    { repo: 'o/.', tag: TAG },
    { repo: 42, tag: TAG },
    { repo: REPO, tag: null },
    { repo: REPO, tag: TAG, sha: CAND },
    { repo: REPO, tag: TAG, candidateSha: CAND },
    { repo: REPO, tag: TAG, runner: 'x' },
    { repo: REPO, tag: TAG, cwd: '/tmp' },
    { repo: REPO, tag: TAG, dir: '/tmp' },
    { repo: REPO, tag: TAG, root: '/tmp' },
    { repo: REPO, tag: TAG, path: '/tmp/x' },
    { repo: REPO, tag: TAG, ref: 'main' },
    { repo: REPO, tag: TAG, x: 1 },
  ])('rejects invalid arguments before invoking the reader: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_release_candidate', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool name', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_release_advance', arguments: { repo: REPO, tag: TAG } })).rejects.toMatchObject({ code: -32602 });
  });

  it('reports the master-moved mismatch with candidate identity and the producer artifact intact', async () => {
    const f = fake(routes());
    const client = await connect(realReader({ runner: f.gh }));
    const result = await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } });
    expect(result.isError).not.toBe(true);
    const out = parse(result);
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'remote-api', authority: 'none' });
    expect(out.plan).toMatchObject({
      outcome: 'blocked', repo: REPO, tag: TAG,
      candidate: { sha: CAND, tree: TREE_C },
      master: { branch: 'master', sha: MASTER, tree: TREE_M },
      masterMoved: true, treeMatch: false,
      gateRun: { id: GATE, conclusion: 'success', headSha: CAND },
      producerArtifact: { id: ART, name: `ashlr-build-${GATE}-1`, digest: `sha256:${'f'.repeat(64)}`, expired: false },
      release: { state: 'draft', id: 42 },
    });
    expect(out.plan.blockers.map((b: { id: string }) => b.id)).toContain('master_tree_mismatch');
    // Advisory commands stay text: every spawned call was a read-only `gh api`.
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every(c => c[0] === 'api')).toBe(true);
  });

  it('keeps a ready plan read-only even when nextActions carries a dispatch command', async () => {
    const f = fake(routes(masterAt(CAND, TREE_C)));
    const client = await connect(realReader({ runner: f.gh }));
    const out = parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }));
    expect(out.plan.outcome).toBe('ready');
    const dispatch = out.plan.nextActions.find((a: { kind: string }) => a.kind === 'dispatch');
    expect(dispatch.command).toContain('gh workflow run attest-ci-build.yml');
    expect(f.calls.every(c => c[0] === 'api')).toBe(true); // never executed
  });

  it('keeps ambiguous evidence unknown instead of labeling it ready', async () => {
    const f = fake(routes({
      ...masterAt(CAND, TREE_C),
      [`${base}/releases?per_page=100&page=1`]: busted(),
    }));
    const client = await connect(realReader({ runner: f.gh }));
    const out = parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }));
    expect(out.plan.outcome).toBe('unknown');
    expect(out.plan.release.state).toBe('unknown');
    expect(out.plan.treeMatch).toBe(true);
  });

  it('keeps unavailable evidence unavailable and preserves nulls', async () => {
    const f = fake(routes({ [base]: busted() }));
    const client = await connect(realReader({ runner: f.gh }));
    const out = parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }));
    expect(out.plan.outcome).toBe('unavailable');
    expect(out.plan.master).toEqual({ branch: null, sha: null, tree: null });
    expect(out.plan.masterMoved).toBeNull();
    expect(out.plan.treeMatch).toBeNull();
  });

  it('keeps a published release distinct from installed-app state', async () => {
    const f = fake(routes({
      ...masterAt(CAND, TREE_C),
      [`${base}/releases?per_page=100&page=1`]: releaseRows({ draft: false, assets: [{ id: 1 }] }),
    }));
    const client = await connect(realReader({ runner: f.gh }));
    const result = await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } });
    const out = parse(result);
    expect(out.plan.outcome).toBe('released');
    expect(out.plan.release).toMatchObject({ state: 'published', draft: false, id: 42 });
    expect(JSON.stringify(out.plan)).not.toContain('installed');
  });

  it('sanitizes hostile strings embedded in planner output', async () => {
    const home = process.env.HOME ?? '';
    const token = `cog_${'Ab1'.repeat(8)}`;
    const hostile: ReleaseCandidatePlan = { version: 1, repo: REPO, tag: TAG, outcome: 'blocked',
      candidate: { sha: CAND, tree: TREE_C }, master: { branch: 'master', sha: MASTER, tree: TREE_M },
      masterMoved: true, treeMatch: false, gateRun: null, ciRunsPending: null,
      attestOnCandidate: [], attestRecent: [], producerArtifact: null,
      release: { state: 'unknown', id: null, draft: null, prerelease: null, assets: null, targetCommitish: null },
      blockers: [{ id: 'x', detail: `key ${token} at ${home}/leak for leak@example.test` }],
      nextActions: [{ kind: 'read', summary: `see ${home}/leak`, command: `gh api ${token}` }],
      truncated: false };
    const client = await connect(realReader({ plan: async () => hostile }));
    const result = await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } });
    expect(result.isError).not.toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('leak@example.test');
    if (home.length > 1) expect(serialized).not.toContain(`${home}/leak`);
    const out = parse(result);
    expect(out.plan.outcome).toBe('blocked'); // evidence states survive scrubbing
  });

  it('returns a generic tool error when the reader itself throws', async () => {
    const client = await connect(async () => { throw new Error('private-source-value'); });
    const result = await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it('parseFleetReleaseCandidateArgs accepts only a strict repo/tag pair', () => {
    expect(parseFleetReleaseCandidateArgs({ repo: REPO, tag: TAG })).toEqual({ repo: REPO, tag: TAG });
    for (const args of [
      {}, { repo: REPO }, { tag: TAG }, { repo: REPO, tag: TAG, x: 1 },
      { repo: 'x', tag: TAG }, { repo: REPO, tag: 'v1' }, { repo: REPO, tag: '' },
      { repo: REPO, tag: TAG, sha: CAND }, { repo: REPO, tag: TAG, runner: 'x' },
    ]) expect(parseFleetReleaseCandidateArgs(args)).toBeNull();
  });
});
