import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { normalizeJsonc, runJsonSyntaxCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

describe('selectChangedFiles json coverage', () => {
  it('selects existing .json, .webmanifest and .tsbuildinfo files and skips deleted, non-json and .jsonl paths', () => {
    const selection = selectChangedFiles(
      ['package.json', 'fleet/manifest.json', 'src/web-ui/public/app/manifest.webmanifest', 'src/core/x.ts', 'gone.json', 'metrics/jobs.jsonl', 'README.md'],
      ['package.json', 'fleet/manifest.json', 'src/web-ui/public/app/manifest.webmanifest', 'src/core/x.ts', 'metrics/jobs.jsonl', 'README.md'],
    );
    expect(selection.jsonFiles).toEqual(['fleet/manifest.json', 'package.json', 'src/web-ui/public/app/manifest.webmanifest']);
  });

  it('selects .tsbuildinfo build-info files for the json check and skips near-miss names', () => {
    const selection = selectChangedFiles(
      [
        'src/web-ui/tsconfig.minimal.tsbuildinfo', 'backend.tsbuildinfo',
        'foo.tsbuildinfo.bak', 'tsbuildinfo', 'gone.tsbuildinfo',
      ],
      [
        'src/web-ui/tsconfig.minimal.tsbuildinfo', 'backend.tsbuildinfo',
        'foo.tsbuildinfo.bak', 'tsbuildinfo',
      ],
    );
    expect(selection.jsonFiles).toEqual(['backend.tsbuildinfo', 'src/web-ui/tsconfig.minimal.tsbuildinfo']);
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

  it('parses the committed TypeScript build-info file', () => {
    const info = join(process.cwd(), 'src/web-ui/tsconfig.minimal.tsbuildinfo');
    expect(runJsonSyntaxCheck(process.cwd(), [info])).toBe(true);
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

  it('accepts comments and trailing commas in files whose tool parses JSONC', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-jsonc-'));
    try {
      mkdirSync(join(root, '.vscode'), { recursive: true });
      mkdirSync(join(root, 'packages/app'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'),
        '{\n  // the backend project\n  "compilerOptions": {\n    "strict": true, /* inline */\n  },\n}\n');
      writeFileSync(join(root, 'packages/app/tsconfig.base.json'), '{\n  // extended\n  "extends": "../tsconfig.json",\n}\n');
      writeFileSync(join(root, 'jsconfig.json'), '{\n  // editor config\n  "compilerOptions": {},\n}\n');
      writeFileSync(join(root, 'deno.json'), '{\n  // tasks\n  "tasks": {},\n}\n');
      writeFileSync(join(root, '.vscode/settings.json'), '{\n  // workspace\n  "editor.tabSize": 2,\n}\n');
      writeFileSync(join(root, 'python.code-snippets'), '{\n  // snippets\n  "scope": "python",\n}\n');
      const files = [
        'tsconfig.json', 'packages/app/tsconfig.base.json', 'jsconfig.json',
        'deno.json', '.vscode/settings.json', 'python.code-snippets',
      ];
      expect(runJsonSyntaxCheck(root, files)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps strict JSON.parse for files whose consumer rejects comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-jsonc-'));
    try {
      writeFileSync(join(root, 'package.json'), '{\n  // not legal here\n  "name": "x",\n}\n');
      writeFileSync(join(root, 'my-tsconfig.json'), '{\n  // looks like tsconfig, is not\n  "a": 1,\n}\n');
      writeFileSync(join(root, 'tsconfigfoo.json'), '{\n  // near miss\n  "a": 1,\n}\n');
      writeFileSync(join(root, 'renovate.json'), '{\n  // renovate stays strict\n  "extends": ["config:recommended"],\n}\n');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(runJsonSyntaxCheck(root, [
          'package.json', 'my-tsconfig.json', 'tsconfigfoo.json', 'renovate.json',
        ])).toBe(false);
      } finally {
        errors.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still fails JSONC files that are broken under the normalized grammar', () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-jsonc-'));
    try {
      mkdirSync(join(root, '.vscode'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), '{\n  // comment\n  "compilerOptions": {\n    "strict": true\n  },\n  trailing\n}\n');
      writeFileSync(join(root, 'deno.json'), '{\n  "tasks": [1,,2],\n}\n');
      writeFileSync(join(root, '.vscode/launch.json'), '{\n  "version": "0.2.0",\n  "configurations": [,]\n}\n');
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(runJsonSyntaxCheck(root, ['tsconfig.json', 'deno.json', '.vscode/launch.json'])).toBe(false);
      } finally {
        errors.mockRestore();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('normalizeJsonc', () => {
  it('strips comments and trailing commas while preserving string contents', () => {
    expect(normalizeJsonc('{\n  // line\n  "url": "http://a/b", /* block */\n  "re": "a,}",\n}\n'))
      .toBe('{\n  \n  "url": "http://a/b", \n  "re": "a,}"\n}\n');
    expect(JSON.parse(normalizeJsonc('{\n  // c\n  "a": [1, 2,],\n}\n'))).toEqual({ a: [1, 2] });
  });

  it('drops a leading BOM and keeps escaped quotes inside strings', () => {
    const source = '\uFEFF{ "a\\"b": "x\\" // not a comment" }';
    expect(JSON.parse(normalizeJsonc(source))).toEqual({ 'a"b': 'x" // not a comment' });
  });

  it('does not repair commas that are not trailing commas', () => {
    for (const bad of ['[,]', '{,}', '[1,,]', '{"a":,}', '[,1]', '{"a":1,,}']) {
      expect(() => JSON.parse(normalizeJsonc(bad))).toThrow();
    }
  });
});
