/**
 * RQ-PHX-RECONCILECANDIDATEMCP05STH1 — preservation proof for
 * fleet_release_candidate on current master. The tool and its tests were
 * inherited from PR #3636 (head b5655ccb2a5a9053621a4ecbac6ca6e9ad1b4cda);
 * this suite re-proves the capability through the real createFleetServer
 * registration seam after the surgical re-application: discovery alongside
 * every current tool, invocation reaching the shared planReleaseCandidate
 * planner with bounded fake `gh api` evidence, unknown/unavailable evidence
 * preserved, and malformed input rejected before any reader or runner IO.
 *
 * Hermetic: in-memory MCP transports and plainly fake route maps; no live
 * GitHub, no signing, no filesystem state, no production claims.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  FLEET_RELEASE_CANDIDATE_REPO_PATTERN, FLEET_RELEASE_CANDIDATE_TAG_PATTERN,
  parseFleetReleaseCandidateArgs, readFleetReleaseCandidate,
  type FleetReleaseCandidateDeps,
} from '../../src/mcp/fleet-release-candidate.js';
import type { ReleaseCandidatePlan } from '../../src/core/fleet/release-candidate-plan.js';
import type { GitRunner, GitRunResult } from '../../src/core/verse/git-ops.js';

const REPO = 'acme/widgets'; // Plainly fake fixture repository, not production state.
const TAG = 'v2.0.0';
const CAND = '1'.repeat(40);
const TREE_C = '2'.repeat(40);
const MASTER = '3'.repeat(40);
const TREE_M = '4'.repeat(40);
const GATE = 424201;
const ART = 909001;
const base = `repos/${REPO}`;

const res = (code: number, stdout: unknown, stderr = ''): GitRunResult =>
  ({ code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr, timedOut: false, truncated: false, missing: false });
const ok = (body: unknown) => res(0, body);
const busted = () => res(1, '', 'gh: fixture failure');
const run = (id: number, sha: string, patch: Record<string, unknown> = {}) => ({
  id, run_attempt: 1, head_sha: sha, head_branch: 'master', status: 'completed',
  conclusion: 'success', event: 'workflow_dispatch', repository: { full_name: REPO }, ...patch,
});
const runs = (rows: unknown[]) => ({ total_count: rows.length, workflow_runs: rows });
const ciRun = (sha: string) => run(GATE, sha, { path: '.github/workflows/ci.yml' });
const branch = (sha: string, tree: string) => ok({ name: 'master', commit: { sha, commit: { tree: { sha: tree } } } });
const masterAt = (sha: string, tree: string) => ({ [`${base}/branches/master`]: branch(sha, tree) });
const releaseRows = (patch: Record<string, unknown> = {}) =>
  ok([{ id: 9, tag_name: TAG, draft: true, prerelease: false, assets: [], target_commitish: CAND, ...patch }]);

/** Bounded fake GitHub evidence: master moved after a green gate on the tag. */
const routes = (patch: Record<string, GitRunResult> = {}): Record<string, GitRunResult> => ({
  [base]: ok({ full_name: REPO, default_branch: 'master' }),
  [`${base}/git/ref/tags/${TAG}`]: ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: CAND } }),
  [`${base}/git/commits/${CAND}`]: ok({ sha: CAND, tree: { sha: TREE_C } }),
  [`${base}/branches/master`]: branch(MASTER, TREE_M),
  [`${base}/releases?per_page=100&page=1`]: releaseRows(),
  [`${base}/actions/workflows/ci.yml/runs?head_sha=${CAND}&branch=master&per_page=100`]: ok(runs([ciRun(CAND)])),
  [`${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`]:
    ok(runs([run(31337, MASTER, { path: '.github/workflows/attest-ci-build.yml', conclusion: 'failure', event: 'schedule' })])),
  [`${base}/actions/runs/${GATE}/artifacts?per_page=100`]:
    ok({ total_count: 1, artifacts: [{ id: ART, name: `ashlr-build-${GATE}-1`, digest: `sha256:${'e'.repeat(64)}`, expired: false }] }),
  ...patch,
});
function fake(map: Record<string, GitRunResult>) {
  const calls: string[][] = [];
  const gh: GitRunner = async (bin, argv) => {
    calls.push([bin, ...argv]);
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
  const client = new Client({ name: 'release-candidate-preservation-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
const realReader = (deps: FleetReleaseCandidateDeps = {}): FleetReaders['releaseCandidate'] =>
  async (input) => readFleetReleaseCandidate(input, deps);

describe('fleet_release_candidate preservation on current master', () => {
  it('is discovered through the real server alongside every current tool registration', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    const tool = tools.find(t => t.name === 'fleet_release_candidate');
    // Present with the tools that were already registered when it landed.
    // Later read-only tools may be appended around it.
    expect(names).toContain('fleet_release_candidate');
    expect(names.indexOf('fleet_ci_receipt_await_batch')).toBeGreaterThan(-1);
    for (const kept of ['fleet_status', 'fleet_loop', 'fleet_bus_inbox', 'fleet_lanes',
      'fleet_job_history', 'fleet_main_health', 'fleet_email_diagnosis',
      'fleet_imessage_acks', 'fleet_ci_resume_inputs', 'fleet_ci_receipt_await',
      'fleet_ci_receipt_await_batch', 'fleet_staging_inventory_retry', 'fleet_staging_inventory_batch']) {
      expect(names).toContain(kept);
    }
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.description).toMatch(/read-only/i);
    expect(tool?.description).toMatch(/never dispatches, signs, tags, merges or mutates/);
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        repo: { type: 'string', pattern: FLEET_RELEASE_CANDIDATE_REPO_PATTERN, description: expect.any(String) },
        tag: { type: 'string', pattern: FLEET_RELEASE_CANDIDATE_TAG_PATTERN, description: expect.any(String) },
      },
      required: ['repo', 'tag'],
      additionalProperties: false,
    });
    expect(FLEET_RELEASE_CANDIDATE_REPO_PATTERN).toBe(String.raw`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$`);
    expect(FLEET_RELEASE_CANDIDATE_TAG_PATTERN).toBe(String.raw`^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$`);
  });

  it('invokes the shared planner through callTool with injected bounded fake evidence', async () => {
    const plan = vi.fn(async (_repo: string, _tag: string, _opts?: { runner?: GitRunner; candidateSha?: string }) =>
      ({ version: 1, repo: REPO, tag: TAG, outcome: 'unknown' }) as ReleaseCandidatePlan);
    const f = fake(routes());
    const client = await connect(realReader({ plan, runner: f.gh }));
    const result = await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } });
    expect(result.isError).not.toBe(true);
    // The shared planner seam: exact repo/tag, injected runner, no sha override.
    expect(plan).toHaveBeenCalledTimes(1);
    const [repo, tag, opts] = plan.mock.calls[0]!;
    expect(repo).toBe(REPO);
    expect(tag).toBe(TAG);
    expect(opts?.runner).toBe(f.gh);
    expect(opts?.candidateSha).toBeUndefined();
    const out = parse(result);
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'remote-api', authority: 'none',
      plan: { outcome: 'unknown', repo: REPO, tag: TAG } });
  });

  it('preserves the master-moved mismatch and producer artifact from bounded gh api reads only', async () => {
    const f = fake(routes());
    const client = await connect(realReader({ runner: f.gh }));
    const out = parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }));
    expect(out.plan).toMatchObject({
      outcome: 'blocked', repo: REPO, tag: TAG,
      candidate: { sha: CAND, tree: TREE_C },
      master: { branch: 'master', sha: MASTER, tree: TREE_M },
      masterMoved: true, treeMatch: false,
      gateRun: { id: GATE, conclusion: 'success', headSha: CAND },
      producerArtifact: { id: ART, name: `ashlr-build-${GATE}-1`, expired: false },
      release: { state: 'draft', id: 9 },
    });
    expect(out.plan.blockers.map((b: { id: string }) => b.id)).toContain('master_tree_mismatch');
    // Advisory nextActions stay text: every spawned call was a read-only gh api.
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every(c => c[0] === 'gh' && c[1] === 'api')).toBe(true);
  });

  it('keeps ambiguous release evidence unknown and never relabels it ready', async () => {
    const f = fake(routes({
      ...masterAt(CAND, TREE_C),
      [`${base}/releases?per_page=100&page=1`]: busted(),
    }));
    const client = await connect(realReader({ runner: f.gh }));
    const out = parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }));
    expect(out.plan.outcome).toBe('unknown');
    expect(out.plan.release.state).toBe('unknown');
    expect(out.plan.treeMatch).toBe(true);
    expect(out.plan.masterMoved).toBe(false);
  });

  it('keeps unavailable evidence unavailable with nulls preserved', async () => {
    const f = fake(routes({ [base]: busted() }));
    const client = await connect(realReader({ runner: f.gh }));
    const out = parse(await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } }));
    expect(out.plan.outcome).toBe('unavailable');
    expect(out.plan.master).toEqual({ branch: null, sha: null, tree: null });
    expect(out.plan.masterMoved).toBeNull();
    expect(out.plan.treeMatch).toBeNull();
  });

  it.each([
    { repo: REPO }, { tag: TAG }, {},
    { repo: REPO, tag: 'v2' }, { repo: REPO, tag: '2.0.0' }, { repo: REPO, tag: 'v2.0.0-rc1' },
    { repo: 'bad repo', tag: TAG }, { repo: 'a--b/x', tag: TAG }, { repo: 'a-/x', tag: TAG },
    { repo: REPO, tag: TAG, sha: CAND }, { repo: REPO, tag: TAG, candidateSha: CAND },
    { repo: REPO, tag: TAG, runner: 'x' }, { repo: REPO, tag: TAG, cwd: '/tmp' },
    { repo: REPO, tag: TAG, path: '/tmp/x' }, { repo: REPO, tag: TAG, ref: 'main' },
    { repo: REPO, tag: TAG, root: '/tmp' }, { repo: REPO, tag: TAG, x: 1 },
    { repo: 7, tag: TAG }, { repo: REPO, tag: null },
  ])('rejects malformed arguments before the reader is invoked: %j', async (args) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_release_candidate', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects malformed arguments through the real reader with zero gh api calls', async () => {
    const f = fake(routes());
    const client = await connect(realReader({ runner: f.gh }));
    for (const args of [
      { repo: REPO, tag: TAG, sha: CAND },
      { repo: REPO, tag: 'latest' },
      { repo: REPO },
    ]) {
      await expect(client.callTool({ name: 'fleet_release_candidate', arguments: args })).rejects.toMatchObject({ code: -32602 });
    }
    expect(f.calls).toEqual([]);
  });

  it('still rejects unknown fleet tool names after the registration', async () => {
    const client = await connect();
    await expect(client.callTool({ name: 'fleet_release_advance', arguments: { repo: REPO, tag: TAG } }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: 'fleet_release_candidate_plan', arguments: { repo: REPO, tag: TAG } }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it('returns a sanitized generic tool error when the reader throws', async () => {
    const client = await connect(async () => { throw new Error('preservation-private-detail'); });
    const result = await client.callTool({ name: 'fleet_release_candidate', arguments: { repo: REPO, tag: TAG } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('preservation-private-detail');
    expect(JSON.stringify(result)).toContain('Fleet observation unavailable');
  });

  it('parseFleetReleaseCandidateArgs accepts only the strict repo/tag pair', () => {
    expect(parseFleetReleaseCandidateArgs({ repo: REPO, tag: TAG })).toEqual({ repo: REPO, tag: TAG });
    for (const args of [
      {}, { repo: REPO }, { tag: TAG }, { repo: REPO, tag: TAG, extra: true },
      { repo: 'x/y/z', tag: TAG }, { repo: REPO, tag: 'v1.2.3.4' },
      { repo: REPO, tag: TAG, runner: {} }, { repo: REPO, tag: TAG, path: '/x' },
    ]) expect(parseFleetReleaseCandidateArgs(args)).toBeNull();
  });
});
