import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdReflect } from '../src/cli/reflect.js';
import '../src/cli/reflect-attempt-reward.js';
import type { Proposal, ProposalLocalMergeIntent } from '../src/core/types.js';
import { hashDiff, signLocalMergeIntent, signLocalRealizedMergeReceipt } from '../src/core/foundry/provenance.js';

let home: string, repo: string, inbox: string, proposal: Proposal;
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const save = (): void => writeFileSync(join(inbox, 'attempt.json'), JSON.stringify(proposal), { mode: 0o600 });
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'reward-cli-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  inbox = join(home, '.ashlr', 'inbox');
  mkdirSync(inbox, { recursive: true, mode: 0o700 });
  repo = join(home, 'repo');
  mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(repo, 'file'), 'base\n');
  git('add', 'file'); git('commit', '-m', 'base');
  proposal = { id: 'attempt', repo, origin: 'swarm', kind: 'patch', title: 'Private title',
    summary: 'Private summary', status: 'pending', createdAt: new Date().toISOString() } as Proposal;
  save();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
async function run(args = ['--proposal', 'attempt', '--tokens', '200', '--weight', '4', '--json']) {
  let out = '', err = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
  try { return { code: await cmdReflect(['attempt-reward', ...args]), out, err }; }
  finally { stdout.mockRestore(); stderr.mockRestore(); }
}
function authenticateMerge(): string {
  const baseBeforeOid = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'file'), 'changed\n');
  const diff = git('diff');
  git('add', 'file'); git('commit', '-m', 'implement feature');
  const mergeCommitOid = git('rev-parse', 'HEAD');
  const observedAt = new Date().toISOString();
  proposal.diff = diff;
  proposal.diffHash = hashDiff(diff);
  proposal.verifyResult = { passed: true, ran: [], baseBranch: 'main', baseHead: baseBeforeOid,
    diffHash: proposal.diffHash, verifiedAt: observedAt, source: 'auto-merge' };
  proposal.status = 'applied';
  const intent: Omit<ProposalLocalMergeIntent, 'attestation'> = {
    schemaVersion: 1, branch: 'feature', base: 'main', baseBeforeOid, proposalHeadOid: mergeCommitOid,
    diffHash: proposal.diffHash, evidencePackDigest: '4'.repeat(64), authorizationId: '5'.repeat(32), authorizedAt: observedAt,
  };
  const intentAttestation = signLocalMergeIntent(proposal.id, repo, intent);
  proposal.localMergeIntent = { ...intent, attestation: intentAttestation };
  const receipt = { schemaVersion: 1 as const, source: 'local-default-branch' as const, base: 'main',
    baseBeforeOid, proposalHeadOid: mergeCommitOid, mergeCommitOid, observedAt,
    proposalId: proposal.id, diffHash: proposal.diffHash, intentAttestation };
  proposal.realizedMerge = { ...receipt, attestation: signLocalRealizedMergeReceipt(proposal.id, repo, receipt) };
  save();
  return mergeCommitOid;
}
it('keeps unsupported states and unauthenticated receipts unknown without disclosing private fields', async () => {
  for (const status of ['pending', 'approved', 'rejected', 'failed', 'applied'] as const) {
    proposal.status = status;
    save();
    const result = await run();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).result).toEqual({ state: 'unknown', reason: 'no-authenticated-merge' });
    expect(result.out).not.toContain(repo);
    expect(result.out).not.toContain('Private');
  }
  authenticateMerge();
  proposal.realizedMerge!.attestation = '0'.repeat(64);
  save();
  expect(JSON.parse((await run()).out).result.state).toBe('unknown');
});
it('reports publication only with matching stored lifecycle state and marks caller inputs', async () => {
  proposal.status = 'awaiting-host-merge';
  save();
  expect(JSON.parse((await run()).out).result.state).toBe('unknown');
  proposal.remoteHandoff = { provider: 'github', state: 'awaiting-host-merge',
    prUrl: 'https://github.com/fixture/repo/pull/1', createdAt: proposal.createdAt };
  save();
  const result = JSON.parse((await run()).out);
  expect(result.result).toEqual({ state: 'scored', outcome: 'published', rewardPerToken: 0 });
  expect(result.inputs).toEqual({ tokens: 200, weight: 4, tokensSource: 'caller-supplied', weightSource: 'caller-supplied' });
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  expect(result.observationOnly).toBe(true);
});
it('uses real authenticated provenance and git history for pending windows and existing reverts', async () => {
  const commit = authenticateMerge();
  expect(JSON.parse((await run()).out).result).toEqual({ state: 'unknown', reason: 'window-pending' });
  git('revert', '--no-edit', commit);
  expect(JSON.parse((await run()).out).result).toEqual({ state: 'scored', outcome: 'reverted', rewardPerToken: -0.02 });
});
it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '1e2'])('rejects token input %s', async value => {
  expect((await run(['--proposal', 'attempt', '--tokens', value, '--json'])).code).toBe(2);
});
it.each(['0', '-1', 'NaN', 'Infinity', '5e-324', '0x10'])('rejects weight input %s', async value => {
  expect((await run(['--proposal', 'attempt', '--tokens', '200', '--weight', value, '--json'])).code).toBe(2);
});
it('rejects traversal, extra flags and input receipts, with generic unavailable errors', async () => {
  for (const args of [ ['--proposal', '../private', '--tokens', '1', '--json'],
    ['--proposal', 'attempt', '--tokens', '1', '--json', '--receipt', repo],
    ['--proposal', 'attempt', '--tokens', '1', '--json', '--proposal', 'attempt'] ]) {
    const result = await run(args);
    expect(result.code).toBe(2); expect(result.err).not.toContain(repo);
  }
  const missing = await run(['--proposal', 'missing', '--tokens', '1', '--json']);
  expect(missing).toEqual({ code: 1, out: '', err: 'error: proposal unavailable.\n' });
  writeFileSync(join(inbox, 'attempt.json'), '{');
  expect((await run()).code).toBe(1);
});
it('documents limits and defaults weight to one', async () => {
  expect((await run(['--help'])).out).toContain('No routing, score policy changes, credit release');
  const result = JSON.parse((await run(['--proposal', 'attempt', '--tokens', '1', '--json'])).out);
  expect(result.inputs.weight).toBe(1); expect(result.inputs.weightSource).toBe('default');
});
