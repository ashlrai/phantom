import {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isKeptWorktree, measureWorktreeBytes, readKeptWorktrees } from '../src/core/worktree-retention.js';

let home: string;
let policyFile: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phm-worktree-retention-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  policyFile = join(home, '.ashlr', 'kept-worktrees.json');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writePolicy(value: unknown): void {
  mkdirSync(join(home, '.ashlr'), { recursive: true });
  writeFileSync(policyFile, JSON.stringify(value));
}

describe('kept worktree allowlist', () => {
  it('allows reclamation when the allowlist is absent or explicitly empty', () => {
    expect(readKeptWorktrees()).toEqual({ paths: [], valid: true });
    writePolicy([]);
    expect(isKeptWorktree(join(home, 'worktree'), readKeptWorktrees())).toBe(false);
  });

  it('pins exact worktrees including existing aliases and an absent leaf', () => {
    const root = join(home, 'jobs');
    const alias = join(home, 'jobs-alias');
    mkdirSync(root);
    symlinkSync(root, alias, 'junction');
    writePolicy([join(alias, 'FIXUP'), join(alias, 'FIXUP')]);
    const policy = readKeptWorktrees();
    expect(policy.valid).toBe(true);
    expect(policy.paths).toHaveLength(1);
    expect(isKeptWorktree(join(root, 'FIXUP'), policy)).toBe(true);
    mkdirSync(join(root, 'FIXUP'));
    expect(isKeptWorktree(join(root, 'FIXUP'), policy)).toBe(true);
    expect(isKeptWorktree(join(root, 'FIXUP-other'), policy)).toBe(false);
    expect(isKeptWorktree(join(root, 'FIXUP', 'child'), policy)).toBe(false);
  });

  it.each([{}, ['relative'], [null], [42], [''], ['\0']])('fails closed on invalid policy %j', value => {
    writePolicy(value);
    const policy = readKeptWorktrees();
    expect(policy.valid).toBe(false);
    expect(isKeptWorktree(join(home, 'any-worktree'), policy)).toBe(true);
  });

  it('fails closed on malformed JSON and oversized policy files', () => {
    writePolicy([]);
    writeFileSync(policyFile, '{');
    expect(readKeptWorktrees().valid).toBe(false);
    writeFileSync(policyFile, ' '.repeat(65 * 1024));
    expect(readKeptWorktrees().valid).toBe(false);
    writeFileSync(policyFile, Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]));
    expect(readKeptWorktrees().valid).toBe(false);
  });

  it('fails closed on policy symlinks, directories and symlinked storage', () => {
    writePolicy([]);
    rmSync(policyFile);
    const outside = join(home, 'external.json');
    writeFileSync(outside, '[]');
    symlinkSync(outside, policyFile);
    expect(readKeptWorktrees().valid).toBe(false);
    rmSync(policyFile);
    mkdirSync(policyFile);
    expect(readKeptWorktrees().valid).toBe(false);
    rmSync(join(home, '.ashlr'), { recursive: true });
    const other = join(home, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'kept-worktrees.json'), '[]');
    symlinkSync(other, join(home, '.ashlr'), 'junction');
    expect(readKeptWorktrees().valid).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('[]');
  });

  it('retains on an unresolvable pin or candidate instead of dropping protection', () => {
    const broken = join(home, 'broken');
    symlinkSync(join(home, 'absent'), broken, 'junction');
    expect(isKeptWorktree(broken, { paths: [], valid: true })).toBe(true);
    expect(isKeptWorktree(join(home, 'candidate'), { paths: [broken], valid: true })).toBe(true);
    writePolicy([broken]);
    expect(readKeptWorktrees().valid).toBe(false);
  });
});

describe('worktree storage measurement', () => {
  it('counts nested build files once, skips shared git metadata, and changes nothing', () => {
    const worktree = join(home, 'worktree');
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    mkdirSync(join(worktree, 'target'));
    const dependency = join(worktree, 'node_modules', 'dependency');
    writeFileSync(dependency, 'dependency');
    linkSync(dependency, join(worktree, 'node_modules', 'alias'));
    writeFileSync(join(worktree, 'target', 'output'), 'output');
    writeFileSync(join(worktree, '.git'), 'gitdir: /some/shared/repository');
    expect(measureWorktreeBytes(worktree)).toEqual({ bytes: 16, complete: true });
    expect(readFileSync(dependency, 'utf8')).toBe('dependency');
    expect(existsSync(join(worktree, 'target', 'output'))).toBe(true);
  });

  it('does not follow nested or root symlinks outside the worktree', () => {
    const outside = join(home, 'outside');
    const worktree = join(home, 'worktree');
    mkdirSync(outside);
    mkdirSync(worktree);
    writeFileSync(join(outside, 'precious'), 'not reclaimable');
    symlinkSync(outside, join(worktree, 'node_modules'), 'junction');
    expect(measureWorktreeBytes(worktree)).toEqual({ bytes: 0, complete: true });
    expect(measureWorktreeBytes(join(worktree, 'node_modules'))).toEqual({ bytes: 0, complete: false });
    expect(readFileSync(join(outside, 'precious'), 'utf8')).toBe('not reclaimable');
  });

  it('marks entry limits and elapsed or invalid budgets incomplete', () => {
    const worktree = join(home, 'worktree');
    mkdirSync(worktree);
    writeFileSync(join(worktree, 'a'), 'a');
    writeFileSync(join(worktree, 'b'), 'b');
    expect(measureWorktreeBytes(worktree, { maxEntries: 1 })).toEqual({ bytes: 1, complete: false });
    expect(measureWorktreeBytes(worktree, { deadlineMs: Date.now() - 1 })).toEqual({ bytes: 0, complete: false });
    expect(measureWorktreeBytes(worktree, { deadlineMs: Date.now() + 5_000 })).toEqual({ bytes: 2, complete: true });
    expect(measureWorktreeBytes(worktree, { maxEntries: Number.NaN }).complete).toBe(false);
  });

  it('reports unknown for absent directories and regular files, and complete for an empty tree', () => {
    expect(measureWorktreeBytes(join(home, 'absent'))).toEqual({ bytes: 0, complete: false });
    writeFileSync(join(home, 'file'), 'file');
    expect(measureWorktreeBytes(join(home, 'file')).complete).toBe(false);
    mkdirSync(join(home, 'empty'));
    expect(measureWorktreeBytes(join(home, 'empty'))).toEqual({ bytes: 0, complete: true });
  });
});
