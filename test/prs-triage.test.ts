import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectTriage } from '../src/cli/prs.js';
import { withScratchRepo } from '../src/core/fleet/dirty-landed-inspect.js';

describe('PR triage against git fixtures', () => {
  it('classifies landed, clean, conflicting, failing and green changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-fixture-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-q', '-b', 'master');
      git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(dir, 'file'), 'original\n'); git('add', '.'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'change');
      writeFileSync(join(dir, 'file'), 'changed\n'); git('commit', '-qam', 'change');
      const head = git('rev-parse', 'HEAD'); git('update-ref', 'refs/pull/1/head', head);
      git('checkout', '-q', 'master');
      const row = { number: 1, headRefOid: head, baseRefName: 'master', mergeable: 'MERGEABLE' };
      await withScratchRepo(async scratch => {
        expect(await inspectTriage(scratch, dir, row, 'success')).toBe('green');
        expect(await inspectTriage(scratch, dir, row, 'failure')).toBe('failing-checks');
        expect(await inspectTriage(scratch, dir, { ...row, mergeable: 'CONFLICTING' }, 'success')).toBe('rebase-clean');
        writeFileSync(join(dir, 'file'), 'different\n'); git('commit', '-qam', 'conflict');
        expect(await inspectTriage(scratch, dir, { ...row, mergeable: 'CONFLICTING' }, 'success')).toBe('rebase-manual');
        writeFileSync(join(dir, 'file'), 'changed\n'); git('commit', '-qam', 'landed');
        expect(await inspectTriage(scratch, dir, row, 'success')).toBe('superseded');
        expect(await inspectTriage(scratch, dir, { ...row, headRefOid: '0'.repeat(40) }, 'success')).toBe('unknown');
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
