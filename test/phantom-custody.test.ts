import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UNWRAPPED_REASONS,
  custodyEngineName,
  decidePhantomCustody,
  formatCustodyLine,
  isLinkedGitWorktree,
  normalizeUnwrappedReason,
} from '../src/core/run/phantom-custody.js';

const base = { enabled: true, installed: true, initialized: true, linkedWorktree: false, engineBin: 'aw' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('phantom custody record', () => {
  it('wraps only when enabled, installed, initialized and not a linked worktree', () => {
    expect(decidePhantomCustody(base)).toEqual({ wrapped: true, engine: 'aw', preflight_schema: 1, preflight_exit: null });
  });

  it.each([
    [{ enabled: false }, 'phantom-disabled'],
    [{ installed: false }, 'phantom-not-installed'],
    [{ initialized: false }, 'not-initialized'],
    [{ initialized: false, engineBin: '/usr/local/bin/claude' }, 'self-authenticating-engine'],
    [{ initialized: false, engineBin: 'codex' }, 'self-authenticating-engine'],
    [{ linkedWorktree: true }, 'worktree-namespace'],
  ] as const)('%o is unwrapped with reason %s', (patch, reason) => {
    const r = decidePhantomCustody({ ...base, ...patch });
    expect(r.wrapped).toBe(false);
    expect(r.wrapped === false && r.reason).toBe(reason);
    expect(UNWRAPPED_REASONS).toContain(reason);
  });

  it('a linked worktree is never wrapped, even when initialized', () => {
    expect(decidePhantomCustody({ ...base, linkedWorktree: true }).wrapped).toBe(false);
  });

  it('unknown reasons normalize to unknown', () => {
    expect(normalizeUnwrappedReason('worktree-namespace')).toBe('worktree-namespace');
    expect(normalizeUnwrappedReason('totally-fine')).toBe('unknown');
    expect(normalizeUnwrappedReason(undefined)).toBe('unknown');
  });

  it('engine names hold no paths or odd characters', () => {
    expect(custodyEngineName('/home/u/secret-dir/claude')).toBe('claude');
    expect(custodyEngineName('C:\\x\\codex.exe'.replace(/\\/g, '/'))).toBe('codex');
    expect(custodyEngineName('bad name;rm')).toBe('unknown');
  });

  it('the formatted line is value-free JSON with a closed key set', () => {
    const fakeKey = `sk-fake-${Date.now().toString(36)}`;
    const line = formatCustodyLine(
      decidePhantomCustody({ ...base, linkedWorktree: true, engineBin: `/tmp/${fakeKey}/aw` }),
    );
    expect(line).not.toContain(fakeKey);
    expect(line).not.toContain('/tmp');
    const json = JSON.parse(line.replace('[ashlr] phantom custody ', ''));
    expect(Object.keys(json).sort()).toEqual(['engine', 'preflight_exit', 'preflight_schema', 'reason', 'wrapped']);
  });

  it('detects linked worktrees by a .git file, not a .git directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'custody-'));
    dirs.push(root);
    const main = join(root, 'main');
    const wt = join(root, 'wt');
    mkdirSync(join(main, '.git'), { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: ../main/.git/worktrees/wt\n');
    expect(isLinkedGitWorktree(main)).toBe(false);
    expect(isLinkedGitWorktree(wt)).toBe(true);
    expect(isLinkedGitWorktree(join(root, 'missing'))).toBe(false);
  });
});
