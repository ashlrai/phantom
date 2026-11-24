import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSnapSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles snap coverage', () => {
  it('selects existing .snap files and skips deleted or near-miss paths', () => {
    const selection = selectChangedFiles(
      [
        'test/__snapshots__/cli-status-json.test.ts.snap', 'src/web-ui/design/__snapshots__/high-contrast.test.ts.snap',
        'src/core/x.ts', 'gone.snap', 'notes.snap.md', 'data.snapshot', 'fixture.SNAP',
      ],
      [
        'test/__snapshots__/cli-status-json.test.ts.snap', 'src/web-ui/design/__snapshots__/high-contrast.test.ts.snap',
        'src/core/x.ts', 'notes.snap.md', 'data.snapshot', 'fixture.SNAP',
      ],
    );
    expect(selection.snapFiles).toEqual([
      'fixture.SNAP',
      'src/web-ui/design/__snapshots__/high-contrast.test.ts.snap',
      'test/__snapshots__/cli-status-json.test.ts.snap',
    ]);
  });
});

describe('runSnapSyntaxCheck', () => {
  it('parses real snapshot modules and rejects real syntax errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-snap-'));
    try {
      writeFileSync(join(root, 'ok.snap'), '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html\n\nexports[`a test 1`] = `\n{\n  "a": 1\n}\n`;\n\nexports[`b test 1`] = {\n  "x": [1, 2],\n};\n');
      writeFileSync(join(root, 'empty.snap'), '');
      writeFileSync(join(root, 'unterminated.snap'), 'exports[`a`] = `never closed\n');
      writeFileSync(join(root, 'marker.snap'), 'exports[`a`] = `ok`;\n<<<<<<< HEAD\nexports[`b`] = `conflict`;\n=======\n>>>>>>> other\n');
      expect(runSnapSyntaxCheck(root, ['ok.snap', 'empty.snap'])).toBe(true);
      expect(runSnapSyntaxCheck(root, ['unterminated.snap'])).toBe(false);
      expect(runSnapSyntaxCheck(root, ['marker.snap'])).toBe(false);
      expect(runSnapSyntaxCheck(root, ['ok.snap', 'unterminated.snap'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every failing file with its line in one pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-snap-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'one.snap'), 'exports[`a`] = `ok`;\nexports[`b`] = ;\n');
      writeFileSync(join(root, 'two.snap'), 'exports[`c`] = `fine`;\nexports[`d`] = ;\n');
      writeFileSync(join(root, 'ok.snap'), 'exports[`e`] = `fine`;\n');
      expect(runSnapSyntaxCheck(root, ['one.snap', 'ok.snap', 'two.snap'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('one.snap:2'))).toBe(true);
      expect(reported.some((line) => line.includes('two.snap:2'))).toBe(true);
      expect(reported.every((line) => line.startsWith('FAIL snap syntax check: '))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a file cannot be read', () => {
    const read = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(runSnapSyntaxCheck('/repo', ['locked.snap'], read as never)).toBe(false);
  });

  it('passes an empty file list without touching the filesystem', () => {
    const read = () => {
      throw new Error('must not be called');
    };
    expect(runSnapSyntaxCheck('/repo', [], read as never)).toBe(true);
  });
});
