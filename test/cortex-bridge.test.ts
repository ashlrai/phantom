import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCortexBridgeConfig, readCortexBridgeConfig, runCortexBridgeOnce, validateCortexProposalDiff, type CortexBridgeConfig } from '../src/core/cortex/bridge.js';
import { engineeringAssignmentDigest, engineeringAssignmentSignature, parseEngineeringAssignmentV1, type EngineeringAssignmentV1 } from '../src/core/cortex/engineering-assignment.js';
import type { AshlrConfig, Proposal, RunState } from '../src/core/types.js';

vi.mock('../src/core/sandbox/policy.js', () => ({ assertMayMutate: vi.fn() }));
const roots: string[] = [];
const diff = 'diff --git a/feature.txt b/feature.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/feature.txt\n@@ -0,0 +1 @@\n+hello\n';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-bridge-'))); roots.push(root); chmodSync(root, 0o700);
  const repo = join(root, 'repo'); mkdirSync(repo); const store = join(root, 'private'); mkdirSync(store, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('-c', 'user.name=Cortex Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  git('remote', 'add', 'origin', 'https://github.com/ashlrai/cortex-fixture.git'); const commit = git('rev-parse', 'HEAD');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const config: CortexBridgeConfig = { schemaVersion: 1, url: 'https://cortex.example.invalid', organizationId: 'company-fixture',
    tokenEnv: 'CORTEX_WORKER_TOKEN', root: store, verifier: { issuer: 'cortex-fixture', audience: 'phantom-fixture',
      publicKeys: { key1: publicKey.export({ type: 'spki', format: 'pem' }).toString() } },
    repositories: [{ repository: 'ashlrai/cortex-fixture', path: repo, workstreams: ['company'] }], runtimes: ['codex'],
    budget: { maxTokens: 1000, maxSteps: 5, allowCloud: true } };
  const now = Date.now(); const unsigned = { protocol: 'ashlr-engineering-assignment/v1', version: 1, issuer: 'cortex-fixture', audience: 'phantom-fixture',
    keyId: 'key1', assignmentId: 'run-fixture', runId: 'run-fixture', issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    organizationRef: 'company-fixture', workstream: 'company', repo: { owner: 'ashlrai', name: 'cortex-fixture', defaultBranch: 'main', sourceCommit: commit },
    mission: { objective: 'Implement one feature', successSignals: ['Tests pass'], guardrails: ['Do not deploy'], allowedFiles: ['feature.txt'] },
    resultContract: { kind: 'verified-proposal', requireDiff: true, requireProposal: true, requireVerification: true, maxChangedFiles: 1, maxChangedLines: 2 },
    authority: { effect: 'proposal-only', requiredTenantRef: 'company-fixture' } } as const;
  const assignmentDigest = engineeringAssignmentDigest(unsigned);
  const assignment = { ...unsigned, assignmentDigest, assignmentSignature: engineeringAssignmentSignature(assignmentDigest, privateKey)! };
  const proposal = { id: 'proposal-fixture', repo, status: 'pending', diff, title: 'Feature proposal', summary: 'One isolated feature', runId: 'local-fixture' } as Proposal;
  const ops: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); ops.push(body);
    const payload = body.op === 'hello' ? { protocolVersion: 2, organizationId: config.organizationId } :
      body.op === 'claim' ? { assignment: { runId: assignment.runId, goal: assignment.mission.objective, scope: ['company'],
        runtimeId: 'codex', maxWallClockMs: 60_000, engineeringAssignment: assignment } } :
        body.op === 'heartbeat' ? { status: 'running', cancelled: false } : { status: 'succeeded', proposalId: 'cortex-proposal-fixture' };
    return Response.json({ ok: true, ...payload });
  });
  vi.stubEnv('CORTEX_WORKER_TOKEN', 'fixture-worker-token-not-a-real-secret');
  const execute = vi.fn(async (_objective: string, _config: AshlrConfig, _options: unknown) => {
    expect(process.env.CORTEX_WORKER_TOKEN).toBeUndefined();
    return { id: 'local-fixture', status: 'done' } as RunState;
  });
  const host = { fetchImpl: fetchImpl as typeof fetch, execute, loadConfig: () => ({}) as AshlrConfig, correlate: () => proposal,
    verify: vi.fn(async () => ({ passed: true, commands: ['npm test'], baseHead: commit })) };
  return { root, repo, store, commit, config, assignment, proposal, ops, fetchImpl, execute, host };
}

describe('Cortex foreground proposal bridge', () => {
  it('accepts the compatibility fixture minted by the Cortex API signing implementation', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/cortex-engineering-assignment-v1.json', import.meta.url), 'utf8'));
    const assignment = parseEngineeringAssignmentV1(fixture.assignment, { verifier: fixture.verifier, now: new Date(fixture.now) });
    expect(assignment?.assignmentId).toBe('contract-fixture');
    expect(assignment?.issuer).toBe('ashlr-cortex'); expect(assignment?.audience).toBe('ashlr-phantom');
    expect(parseEngineeringAssignmentV1({ ...fixture.assignment, mission: { ...fixture.assignment.mission, objective: 'Changed objective' } },
      { verifier: fixture.verifier, now: new Date(fixture.now) })).toBeNull();
  });
  it('verifies a signed assignment, runs only the existing sandbox, returns real artifact hashes, and refuses replay', async () => {
    const f = fixture(); expect(parseEngineeringAssignmentV1(f.assignment, { verifier: f.config.verifier })).not.toBeNull();
    await expect(runCortexBridgeOnce(f.config, f.host)).resolves.toEqual({ state: 'proposed', runId: 'run-fixture', proposalId: 'proposal-fixture' });
    expect(f.execute).toHaveBeenCalledOnce(); expect(f.execute.mock.calls[0]?.[2]).toMatchObject({ sandboxEngine: true, requireSandbox: true,
      noMemory: true, noCapture: true, tools: false, delegationScope: { memoryMode: 'none', allowedFiles: { include: ['feature.txt'], enforceWrites: true } } });
    const finish = f.ops.find(v => v.op === 'finish')!; expect(finish.ok).toBe(true);
    const receipt = JSON.parse(finish.text as string).engineeringReceipt;
    expect(receipt.assignmentDigest).toBe(f.assignment.assignmentDigest); expect(receipt.verification.status).toBe('passed');
    expect(receipt.artifacts.map((v: { kind: string }) => v.kind)).toEqual(['diff', 'proposal', 'verification']);
    const attempt = join(f.store, readdirSync(f.store)[0]!); expect(readFileSync(join(attempt, 'proposal.diff'), 'utf8')).toBe(diff);
    await expect(runCortexBridgeOnce(f.config, f.host)).rejects.toThrow(); expect(f.execute).toHaveBeenCalledOnce();
    expect(f.fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer fixture-worker-token-not-a-real-secret' } });
  });
  it('does not claim when the authenticated tenant differs', async () => {
    const f = fixture(); f.config.organizationId = 'different-company';
    f.fetchImpl.mockImplementationOnce(async () => Response.json({ ok: true, protocolVersion: 2, organizationId: 'company-fixture' }));
    await expect(runCortexBridgeOnce(f.config, f.host)).rejects.toThrow('organization mismatch');
    expect(f.ops).toHaveLength(0); expect(f.execute).not.toHaveBeenCalled();
  });
  it('refuses changed signatures, expired assignments, wrong repository mappings, and cancelled work', async () => {
    const f = fixture();
    expect(parseEngineeringAssignmentV1({ ...f.assignment, organizationRef: 'other' }, { verifier: f.config.verifier })).toBeNull();
    expect(parseEngineeringAssignmentV1(f.assignment, { verifier: f.config.verifier, now: new Date(Date.now() + 90_000) })).toBeNull();
    f.config.repositories[0]!.workstreams = ['commercial'];
    await expect(runCortexBridgeOnce(f.config, f.host)).rejects.toThrow('not admitted'); expect(f.execute).not.toHaveBeenCalled();
  });
  it('fails before dispatch when Cortex cancels the claimed run', async () => {
    const f = fixture(); const original = f.fetchImpl.getMockImplementation()!;
    f.fetchImpl.mockImplementation(async (url, init) => JSON.parse(String(init?.body)).op === 'heartbeat' ?
      Response.json({ ok: true, status: 'cancelled', cancelled: true }) : original(url, init));
    await expect(runCortexBridgeOnce(f.config, f.host)).rejects.toThrow('revoked'); expect(f.execute).not.toHaveBeenCalled();
  });
  it('refuses unverified and wrong-base results and cannot report them as successful receipts', async () => {
    const f = fixture(); f.host.verify.mockResolvedValue({ passed: true, commands: ['npm test'], baseHead: 'f'.repeat(40) });
    await expect(runCortexBridgeOnce(f.config, f.host)).rejects.toThrow('signed source');
    expect(f.ops.filter(v => v.op === 'finish').map(v => v.ok)).toEqual([false]);
  });
  it('checks captured changed paths and line budgets, including whole-segment wildcard handling', () => {
    const f = fixture(); expect(() => validateCortexProposalDiff(diff, f.assignment)).not.toThrow();
    expect(() => validateCortexProposalDiff(diff.replaceAll('feature.txt', 'private.txt'), f.assignment)).toThrow('allowed files');
    const a = { ...f.assignment, mission: { ...f.assignment.mission, allowedFiles: ['src/*'] } } as EngineeringAssignmentV1;
    expect(() => validateCortexProposalDiff(diff.replaceAll('feature.txt', 'src/feature.txt'), a)).not.toThrow();
    expect(() => validateCortexProposalDiff(diff.replaceAll('feature.txt', 'src/nested/feature.txt'), a)).toThrow('allowed files');
    expect(() => validateCortexProposalDiff(diff, { ...f.assignment, resultContract: { ...f.assignment.resultContract, maxChangedLines: 0 } })).toThrow('change budget');
  });
  it('requires private configs, HTTPS origin pins, key pins, and a token env that the sandbox strips', () => {
    const f = fixture(); expect(() => parseCortexBridgeConfig(f.config)).not.toThrow();
    expect(() => parseCortexBridgeConfig({ ...f.config, url: 'https://cortex.example.invalid/redirect' })).toThrow();
    expect(() => parseCortexBridgeConfig({ ...f.config, tokenEnv: 'PATH' })).toThrow();
    const path = join(f.root, 'config.json'); writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 });
    expect(readCortexBridgeConfig(path).organizationId).toBe('company-fixture'); chmodSync(path, 0o644);
    expect(() => readCortexBridgeConfig(path)).toThrow('private');
  });
});
