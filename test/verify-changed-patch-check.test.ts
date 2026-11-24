import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runPatchSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

const VALID_PATCH = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 1111111..2222222 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
  '',
].join('\n');

const CORRUPT_PATCH = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 1111111..2222222 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,3 +1,3 @@',
  ' context line',
  'this line has no diff prefix',
  '+added',
  '',
].join('\n');

describe('selectChangedFiles patch coverage', () => {
  it('selects existing .patch and .diff files and skips deleted or near-miss paths', () => {
    const selection = selectChangedFiles(
      [
        'docs/strategy/ci-rightsizing.patch', 'contrib/mac/host-integration/dispatchd.diff',
        'staging/x/precheck.sh.diff', 'src/core/x.ts', 'gone.patch', 'notes.patch.md',
        'data.diffstat', 'fixture.PATCH',
      ],
      [
        'docs/strategy/ci-rightsizing.patch', 'contrib/mac/host-integration/dispatchd.diff',
        'staging/x/precheck.sh.diff', 'src/core/x.ts', 'notes.patch.md', 'data.diffstat', 'fixture.PATCH',
      ],
    );
    expect(selection.patchFiles).toEqual([
      'contrib/mac/host-integration/dispatchd.diff',
      'docs/strategy/ci-rightsizing.patch',
      'fixture.PATCH',
      'staging/x/precheck.sh.diff',
    ]);
  });
});

describe('runPatchSyntaxCheck', () => {
  it('parses real unified diffs and rejects non-patch and corrupt input', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-patch-'));
    try {
      writeFileSync(join(root, 'ok.patch'), VALID_PATCH);
      writeFileSync(join(root, 'ok.diff'), VALID_PATCH);
      writeFileSync(join(root, 'notes.patch'), 'release notes, not a patch\n');
      writeFileSync(join(root, 'empty.patch'), '');
      writeFileSync(join(root, 'corrupt.patch'), CORRUPT_PATCH);
      expect(runPatchSyntaxCheck(root, ['ok.patch', 'ok.diff'])).toBe(true);
      expect(runPatchSyntaxCheck(root, ['notes.patch'])).toBe(false);
      expect(runPatchSyntaxCheck(root, ['empty.patch'])).toBe(false);
      expect(runPatchSyntaxCheck(root, ['corrupt.patch'])).toBe(false);
      expect(runPatchSyntaxCheck(root, ['ok.patch', 'corrupt.patch'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks a dash-leading filename as a path, never an option', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-patch-'));
    try {
      writeFileSync(join(root, '-odd.patch'), VALID_PATCH);
      expect(runPatchSyntaxCheck(root, ['-odd.patch'])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names the failing file when git rejects it', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-patch-'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'one.patch'), VALID_PATCH);
      writeFileSync(join(root, 'two.diff'), 'not a patch\n');
      expect(runPatchSyntaxCheck(root, ['one.patch', 'two.diff'])).toBe(false);
      const reported = logs.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line === 'FAIL patch syntax check: two.diff')).toBe(true);
    } finally {
      logs.mockRestore();
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when git cannot run or reports an error', () => {
    const spawn = () => ({ status: 128, stdout: '', stderr: 'error: No valid patches in input\n' });
    expect(runPatchSyntaxCheck('/repo', ['bad.patch'], spawn as never)).toBe(false);
    const crashed = () => ({ error: new Error('spawn git ENOENT'), status: null, stdout: '', stderr: '' });
    expect(runPatchSyntaxCheck('/repo', ['bad.patch'], crashed as never)).toBe(false);
  });

  it('passes an empty file list without spawning', () => {
    const spawn = () => {
      throw new Error('must not be called');
    };
    expect(runPatchSyntaxCheck('/repo', [], spawn as never)).toBe(true);
  });
});
