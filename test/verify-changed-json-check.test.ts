import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runJsonSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles json coverage', () => {
  it('selects existing .json files and skips deleted, non-json and .jsonl paths', () => {
    const selection = selectChangedFiles(
      ['package.json', 'fleet/manifest.json', 'src/core/x.ts', 'gone.json', 'metrics/jobs.jsonl', 'README.md'],
      ['package.json', 'fleet/manifest.json', 'src/core/x.ts', 'metrics/jobs.jsonl', 'README.md'],
    );
    expect(selection.jsonFiles).toEqual(['fleet/manifest.json', 'package.json']);
  });
});

describe('runJsonSyntaxCheck', () => {
  it('parses a real valid document and rejects real syntax errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-json-'));
    try {
      writeFileSync(join(root, 'ok.json'), '{\n  "a": [1, 2, {"b": "c"}],\n  "d": null\n}\n');
      writeFileSync(join(root, 'bad.json'), '{"a": }\n');
      writeFileSync(join(root, 'empty.json'), '');
      expect(runJsonSyntaxCheck(root, ['ok.json'])).toBe(true);
      expect(runJsonSyntaxCheck(root, ['bad.json'])).toBe(false);
      expect(runJsonSyntaxCheck(root, ['empty.json'])).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names every failing file in one pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-json-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      writeFileSync(join(root, 'one.json'), '{bad');
      writeFileSync(join(root, 'two.json'), '[1,');
      writeFileSync(join(root, 'ok.json'), '{}');
      expect(runJsonSyntaxCheck(root, ['one.json', 'ok.json', 'two.json'])).toBe(false);
      const reported = errors.mock.calls.map((call) => String(call[0]));
      expect(reported.some((line) => line.includes('one.json'))).toBe(true);
      expect(reported.some((line) => line.includes('two.json'))).toBe(true);
      expect(reported.every((line) => line.startsWith('FAIL json syntax check: '))).toBe(true);
    } finally {
      errors.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns false when a file cannot be read', () => {
    const read = () => {
      throw new Error('EACCES: permission denied');
    };
    expect(runJsonSyntaxCheck('/repo', ['locked.json'], read as never)).toBe(false);
  });

  it('passes an empty file list without touching the filesystem', () => {
    const read = () => {
      throw new Error('must not be called');
    };
    expect(runJsonSyntaxCheck('/repo', [], read as never)).toBe(true);
  });
});
