import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runJsonlSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles jsonl coverage', () => {
  it('selects existing .jsonl files and skips deleted, non-jsonl and .json paths', () => {
    const selection = selectChangedFiles(
      ['metrics/jobs.jsonl', 'benchmarks/router-eval/jobs.jsonl', 'package.json', 'src/core/x.ts', 'gone.jsonl', 'data.json'],
      ['metrics/jobs.jsonl', 'benchmarks/router-eval/jobs.jsonl', 'package.json', 'src/core/x.ts', 'data.json'],
    );
    expect(selection.jsonlFiles).toEqual(['benchmarks/router-eval/jobs.jsonl', 'metrics/jobs.jsonl']);
    expect(selection.jsonFiles).toEqual(['data.json', 'package.json']);
  });
});

describe('runJsonlSyntaxCheck', () => {
  it('parses a real ledger and rejects real syntax errors with 1-based line numbers', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-jsonl-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'ok.jsonl'), '{"a":1}\n{"b":[2,3]}\n\n{"c":"d"}\n');
      writeFileSync(join(root, 'bad.jsonl'), '{"a":1}\n{bad\n{"c": }\n');
      writeFileSync(join(root, 'empty.jsonl'), '');
      writeFileSync(join(root, 'blank.jsonl'), '\n  \n\t\n');
      expect(runJsonlSyntaxCheck(root, ['ok.jsonl'])).toBe(true);
      expect(runJsonlSyntaxCheck(root, ['empty.jsonl'])).toBe(true);
      expect(runJsonlSyntaxCheck(root, ['blank.jsonl'])).toBe(true);
      expect(runJsonlSyntaxCheck(root, ['bad.jsonl'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('bad.jsonl:2'))).toBe(true);
      expect(reported.some((line) => line.includes('bad.jsonl:3'))).toBe(true);
      expect(reported.every((line) => line.startsWith('FAIL jsonl syntax check: '))).toBe(true);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts any JSON value per line, not only objects', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-jsonl-'));
    try {
      writeFileSync(join(root, 'values.jsonl'), '42\n"text"\n[1,2]\n{"o":null}\ntrue\n');
      expect(runJsonlSyntaxCheck(root, ['values.jsonl'])).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps detailed errors at eight per file and counts the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-jsonl-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'corrupt.jsonl'), Array.from({ length: 10 }, () => '{bad').join('\n') + '\n');
      expect(runJsonlSyntaxCheck(root, ['corrupt.jsonl'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.filter((line) => line.includes('corrupt.jsonl:'))).toHaveLength(9);
      expect(reported.some((line) => line.includes('corrupt.jsonl: 2 more malformed lines'))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every failing file in one pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-jsonl-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'one.jsonl'), '{bad\n');
      writeFileSync(join(root, 'two.jsonl'), '[1,\n');
      writeFileSync(join(root, 'ok.jsonl'), '{}\n');
      expect(runJsonlSyntaxCheck(root, ['one.jsonl', 'ok.jsonl', 'two.jsonl'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('one.jsonl:1'))).toBe(true);
      expect(reported.some((line) => line.includes('two.jsonl:1'))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a file cannot be read', () => {
    const read = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(runJsonlSyntaxCheck('/repo', ['locked.jsonl'], read as never)).toBe(false);
  });

  it('passes an empty file list without touching the filesystem', () => {
    const read = () => {
      throw new Error('must not be called');
    };
    expect(runJsonlSyntaxCheck('/repo', [], read as never)).toBe(true);
  });
});
