/**
 * Regression test: resolveRemoteBranchHead uses exact ref path (refs/heads/<name>)
 * so ls-remote never tail-matches a similarly-named branch.
 *
 * GH workflow ecosystem-stats failed when feat/ecosystem-stats existed because
 * bare 'ecosystem-stats' tail-matched refs/heads/feat/ecosystem-stats (run 40355871064).
 * The source-code equivalent in resolveRemoteBranchHead had the same vulnerability.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { resolveRemoteBranchHead } from '../src/core/inbox/merge.js';

function git(cwd: string, args: string[]): string {
  return execSync('git ' + args.join(' '), { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('resolveRemoteBranchHead', () => {
  it('resolves the head of an existing branch', () => {
    const repo = mkdtempSync(join(tmpdir(), 'exact-ref-'));
    try {
      git(repo, ['init', '-b', 'main']);
      writeFileSync(join(repo, 'file'), 'hello');
      git(repo, ['add', 'file']);
      git(repo, ['commit', '-m', 'init']);
      const head = git(repo, ['rev-parse', 'HEAD']).trim();
      expect(resolveRemoteBranchHead(repo, 'main', repo)).toBe(head);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns null for a nonexistent branch', () => {
    const repo = mkdtempSync(join(tmpdir(), 'exact-ref-'));
    try {
      git(repo, ['init', '-b', 'main']);
      writeFileSync(join(repo, 'file'), 'hello');
      git(repo, ['add', 'file']);
      git(repo, ['commit', '-m', 'init']);
      expect(resolveRemoteBranchHead(repo, 'nonexistent', repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not tail-match a similarly-named branch (exact ref)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'exact-ref-'));
    try {
      git(repo, ['init', '-b', 'main']);
      writeFileSync(join(repo, 'file'), 'hello');
      git(repo, ['add', 'file']);
      git(repo, ['commit', '-m', 'init']);
      // Create a branch that would tail-match bare 'main' (feat/main)
      git(repo, ['checkout', '-b', 'feat/main']);
      writeFileSync(join(repo, 'feat'), 'feature');
      git(repo, ['add', 'feat']);
      git(repo, ['commit', '-m', 'feature']);
      const mainHead = git(repo, ['rev-parse', 'refs/heads/main']).trim();
      const featHead = git(repo, ['rev-parse', 'refs/heads/feat/main']).trim();
      // With exact ref (refs/heads/main), we get the main branch head, not feat/main
      expect(resolveRemoteBranchHead(repo, 'main', repo)).toBe(mainHead);
      expect(resolveRemoteBranchHead(repo, 'main', repo)).not.toBe(featHead);
      // The feat/main branch should still be resolvable
      expect(resolveRemoteBranchHead(repo, 'feat/main', repo)).toBe(featHead);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
