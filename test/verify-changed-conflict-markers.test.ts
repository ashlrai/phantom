import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  conflictMarkers,
  runConflictMarkerCheck,
  selectConflictScanFiles,
} from '../scripts/verify-changed.mjs';

describe('selectConflictScanFiles', () => {
  it('selects every changed existing file except fixture payloads and deletions', () => {
    const selection = selectConflictScanFiles(
      ['docs/guide.md', 'src/core/x.ts', 'test/fixtures/merge/conflicted.txt', 'queue/ready.tsv', 'gone.bin', 'data.jsonl'],
      ['docs/guide.md', 'src/core/x.ts', 'test/fixtures/merge/conflicted.txt', 'queue/ready.tsv', 'data.jsonl'],
    );
    expect(selection).toEqual(['data.jsonl', 'docs/guide.md', 'queue/ready.tsv', 'src/core/x.ts']);
  });

  it('dedupes and sorts the candidate set', () => {
    const selection = selectConflictScanFiles(
      ['b.txt', 'a.txt', 'b.txt', ''],
      ['a.txt', 'b.txt'],
    );
    expect(selection).toEqual(['a.txt', 'b.txt']);
  });
});

describe('conflictMarkers', () => {
  it('reports column-0 git markers with 1-based line numbers and the bare token', () => {
    const text = 'one\n<<<<<<< HEAD\ntwo\n=======\nthree\n>>>>>>> feature/x\nfour\n';
    expect(conflictMarkers(text)).toEqual([
      { line: 2, marker: '<<<<<<<' },
      { line: 6, marker: '>>>>>>>' },
    ]);
  });

  it('catches the diff3 base marker and markers without labels', () => {
    expect(conflictMarkers('||||||| base\n>>>>>>>\n')).toEqual([
      { line: 1, marker: '|||||||' },
      { line: 2, marker: '>>>>>>>' },
    ]);
  });

  it('ignores the ======= separator, indented markers and mid-line markers', () => {
    const text = [
      '=======',
      '  <<<<<<< indented',
      'text >>>>>>> mid-line',
      '======= trailing',
      '',
    ].join('\n');
    expect(conflictMarkers(text)).toEqual([]);
  });

  it('ignores runs shorter than seven characters', () => {
    expect(conflictMarkers('<<<<<< six\n>>>>>> six\n|||||| six\n')).toEqual([]);
  });

  it('matches runs longer than seven characters but reports only seven', () => {
    expect(conflictMarkers('<<<<<<<< eight\n')).toEqual([{ line: 1, marker: '<<<<<<<' }]);
  });

  it('strips a leading BOM so the first line still scans', () => {
    expect(conflictMarkers('\uFEFF<<<<<<< HEAD\n')).toEqual([{ line: 1, marker: '<<<<<<<' }]);
  });

  it('scans CRLF content', () => {
    expect(conflictMarkers('a\r\n>>>>>>> theirs\r\n')).toEqual([{ line: 2, marker: '>>>>>>>' }]);
  });

  it('returns no hits for non-string input', () => {
    expect(conflictMarkers(null as never)).toEqual([]);
    expect(conflictMarkers(undefined as never)).toEqual([]);
  });
});

describe('runConflictMarkerCheck', () => {
  it('fails on a real conflict block and names path, line and marker only', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-conflict-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(
        join(root, 'docs.md'),
        '# Title\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> secret-branch-name\n',
      );
      expect(runConflictMarkerCheck(root, ['docs.md'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line === 'FAIL conflict marker check: docs.md:2: <<<<<<<')).toBe(true);
      expect(reported.some((line) => line === 'FAIL conflict marker check: docs.md:6: >>>>>>>')).toBe(true);
      expect(reported.every((line) => !line.includes('secret-branch-name'))).toBe(true);
      expect(reported.every((line) => line.startsWith('FAIL conflict marker check: '))).toBe(true);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes clean files of every shape, including indented and setext-equals lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-conflict-'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'clean.md'), '# T\n\ntext\n=======\n\n  <<<<<<< quoted in a fence example\n');
      writeFileSync(join(root, 'data.tsv'), 'a\tb\n1\t2\n');
      writeFileSync(join(root, 'empty.txt'), '');
      expect(runConflictMarkerCheck(root, ['clean.md', 'data.tsv', 'empty.txt'])).toBe(true);
      expect(logs.mock.calls.map((call) => String(call[0]))).toContain('PASS conflict marker check');
    } finally {
      logs.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips binary files by NUL sniff and still scans later text files', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-conflict-'));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0a, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c]));
      writeFileSync(join(root, 'ok.txt'), 'clean\n');
      expect(runConflictMarkerCheck(root, ['blob.bin', 'ok.txt'])).toBe(true);
    } finally {
      logs.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps detailed hits at eight per file and counts the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-conflict-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'corrupt.txt'), Array.from({ length: 10 }, () => '<<<<<<< x').join('\n') + '\n');
      expect(runConflictMarkerCheck(root, ['corrupt.txt'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.filter((line) => line.includes('corrupt.txt:'))).toHaveLength(9);
      expect(reported.some((line) => line.includes('corrupt.txt: 2 more marker lines'))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every failing file in one pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-conflict-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'one.txt'), '<<<<<<< a\n');
      writeFileSync(join(root, 'two.md'), 'ok\n>>>>>>> b\n');
      writeFileSync(join(root, 'fine.txt'), 'fine\n');
      expect(runConflictMarkerCheck(root, ['one.txt', 'fine.txt', 'two.md'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('one.txt:1'))).toBe(true);
      expect(reported.some((line) => line.includes('two.md:2'))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a file cannot be read', () => {
    expect(runConflictMarkerCheck('/repo', ['locked.txt'])).toBe(false);
  });

  it('passes an empty file list without touching the filesystem', () => {
    const read = () => {
      throw new Error('must not be called');
    };
    expect(runConflictMarkerCheck('/repo', [], read as never)).toBe(true);
  });
});
