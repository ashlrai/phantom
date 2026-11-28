import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTriage, inspectTriageBatch, inspectTriageEvidence } from '../src/cli/prs.js';
import { defaultGitRunner } from '../src/core/verse/git-ops.js';
import { withScratchRepo } from '../src/core/fleet/dirty-landed-inspect.js';

describe('PR triage against git fixtures', () => {
  it('classifies landed, clean, conflicting, failing and green changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-fixture-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-q', '-b', 'master');
      git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(dir, 'file'), 'original\n'); git('add', '.'); git('commit', '-qm', 'base');
      const mergeBaseSha = git('rev-parse', 'HEAD');
      git('checkout', '-qb', 'change');
      writeFileSync(join(dir, 'file'), 'changed\n'); git('commit', '-qam', 'change');
      const head = git('rev-parse', 'HEAD'); git('update-ref', 'refs/pull/1/head', head);
      git('checkout', '-q', 'master');
      const row = { number: 1, headRefOid: head, baseRefName: 'master', mergeable: 'MERGEABLE' };
      await withScratchRepo(async scratch => {
        expect(await inspectTriage(scratch, dir, row, 'success')).toBe('green');
        expect(await inspectTriage(scratch, dir, row, 'failure')).toBe('failing-checks');
        expect(await inspectTriageEvidence(scratch, dir, row, 'success')).toEqual({
          verdict: 'green', evidence: { headSha: head, baseTipSha: mergeBaseSha, mergeBaseSha, proof: null },
        });
        expect(await inspectTriageEvidence(scratch, dir, row, 'pending')).toEqual({ verdict: 'unknown', evidence: null });
        expect(await inspectTriage(scratch, dir, { ...row, mergeable: 'CONFLICTING' }, 'success')).toBe('rebase-clean');
        writeFileSync(join(dir, 'file'), 'different\n'); git('commit', '-qam', 'conflict');
        expect(await inspectTriage(scratch, dir, { ...row, mergeable: 'CONFLICTING' }, 'success')).toBe('rebase-manual');
        writeFileSync(join(dir, 'file'), 'changed\n'); git('commit', '-qam', 'landed');
        expect(await inspectTriage(scratch, dir, row, 'success')).toBe('superseded');
        const baseTipSha = git('rev-parse', 'HEAD');
        expect(baseTipSha).not.toBe(mergeBaseSha);
        expect(baseTipSha).not.toBe(head);
        expect(await inspectTriageEvidence(scratch, dir, row, 'success')).toEqual({
          verdict: 'superseded',
          evidence: { headSha: head, baseTipSha, mergeBaseSha, proof: 'reverse-patch' },
        });
        git('update-ref', 'refs/pull/1/head', baseTipSha);
        expect(await inspectTriage(scratch, dir, row, 'success')).toBe('unknown');
        expect(await inspectTriageEvidence(scratch, dir, row, 'success')).toEqual({
          verdict: 'unknown',
          evidence: null,
        });
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('batches 26 exact heads into two fetches and pins the base even if it moves', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'triage-batch-fixture-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: remote, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-q', '-b', 'master');
      git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(remote, 'file'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-qb', 'change');
      writeFileSync(join(remote, 'file'), 'patch\n'); git('commit', '-qam', 'change');
      const head = git('rev-parse', 'HEAD');
      const input = Array.from({ length: 26 }, (_, i) => {
        const number = i + 1;
        git('update-ref', `refs/pull/${number}/head`, head);
        return { row: { number, headRefOid: head, baseRefName: 'master', mergeable: 'MERGEABLE' }, checks: 'success' };
      });
      const fetchSizes: number[] = [];
      await withScratchRepo(async scratch => {
        const result = await inspectTriageBatch(scratch, remote, input, async (dir, binary, args) => {
          const receipt = await defaultGitRunner(binary, args, { cwd: dir, timeoutMs: 30_000 });
          if (args.includes('fetch')) {
            fetchSizes.push(args.filter(arg => arg.startsWith('+refs/')).length);
            if (fetchSizes.length === 2) git('update-ref', 'refs/heads/master', head);
          }
          return receipt;
        });
        expect(fetchSizes).toEqual([1, 25, 1]);
        expect(result).toHaveLength(26);
        expect(result.every(item => item.verdict === 'green' && item.evidence.baseTipSha === base)).toBe(true);
      });
      git('update-ref', 'refs/heads/master', base);
      git('update-ref', '-d', 'refs/pull/2/head');
      git('update-ref', 'refs/pull/3/head', base);
      await withScratchRepo(async scratch => {
        const batch = [input[0]!, input[1]!, input[2]!];
        const result = await inspectTriageBatch(scratch, remote, batch);
        expect(result).toEqual([
          await inspectTriageEvidence(scratch, remote, batch[0]!.row, 'success'),
          { verdict: 'unknown', evidence: null },
          { verdict: 'unknown', evidence: null },
        ]);
        expect(result[0]?.verdict).toBe('green');
      });
    } finally { rmSync(remote, { recursive: true, force: true }); }
  }, 30_000);
});
