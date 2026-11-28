import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTriage, inspectTriageEvidence } from '../src/cli/prs.js';
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
});
