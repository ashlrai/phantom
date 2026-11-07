import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeDir, loadChunks } from '../src/core/knowledge/index.js';

let home: string;
let repo: string;
const chunk = { repo: 'synthetic repo', file: 'src/example.ts', startLine: 2, endLine: 4, text: 'searchable evidence' };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-admission-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  repo = path.join(home, 'synthetic-repo');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function persist(lines: string[]): string {
  const hash = crypto.createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 16);
  const dir = path.join(knowledgeDir(), hash);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'chunks.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('persisted chunk admission', () => {
  it('rejects unusable coordinates and blank labels while retaining valid neighbors', () => {
    const invalid = [
      { startLine: -1 }, { startLine: 0 }, { startLine: 1.5 },
      { endLine: -1 }, { endLine: 0 }, { endLine: 3.5 }, { startLine: 5, endLine: 4 },
      { repo: '' }, { repo: ' \t\n' }, { file: '' }, { file: ' \t\n' },
      { startLine: '2' }, { endLine: null }, { repo: null }, { file: 42 },
    ];
    const legacy = { ...chunk, repo: ' repo ', file: ' file ', startLine: 1, endLine: 1 };
    const withVector = { ...chunk, text: 'semantic evidence', vector: [0.25, -1] };
    const file = persist([
      JSON.stringify(legacy), '{broken json', 'null',
      ...invalid.map((fields) => JSON.stringify({ ...chunk, ...fields })),
      JSON.stringify(withVector),
      JSON.stringify(chunk).replace('"startLine":2', '"startLine":1e999'),
      JSON.stringify(chunk).replace('"endLine":4', '"endLine":1e999'),
    ]);
    const original = fs.readFileSync(file, 'utf8');
    expect(loadChunks(repo)).toEqual([legacy, withVector]);
    expect(loadChunks()).toEqual([legacy, withVector]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('omits malformed vectors but keeps lexical chunks and valid bounded vectors', () => {
    const invalidVectors: unknown[] = [null, [], 'vector', [1, '2'], [1, null], {}, Array(16_385).fill(1)];
    const records = invalidVectors.map((vector, i) => ({ ...chunk, text: `lexical ${i}`, vector }));
    const bounded = { ...chunk, text: 'bounded', vector: Array(16_384).fill(1) };
    const nonfinite = JSON.stringify({ ...chunk, text: 'nonfinite', vector: [1, 99] })
      .replace('"vector":[1,99]', '"vector":[1,1e999]');
    persist([JSON.stringify(chunk), ...records.map((record) => JSON.stringify(record)), nonfinite, JSON.stringify(bounded)]);
    expect(loadChunks(repo)).toEqual([
      chunk,
      ...records.map(({ vector: _vector, ...lexical }) => lexical),
      { ...chunk, text: 'nonfinite' },
      bounded,
    ]);
  });

  it('handles JavaScript-only nonfinite values without mutating parsed objects', () => {
    const inputs = [
      { ...chunk, startLine: NaN }, { ...chunk, endLine: -Infinity },
      { ...chunk, vector: [NaN] }, { ...chunk, vector: [Infinity] },
    ];
    persist(inputs.map((_, index) => JSON.stringify({ fixture: index })));
    const parse = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      const parsed = parse(text, reviver) as unknown;
      if (typeof parsed === 'object' && parsed !== null && 'fixture' in parsed && typeof parsed.fixture === 'number') {
        return inputs[parsed.fixture];
      }
      return parsed;
    });
    expect(loadChunks(repo)).toEqual([chunk, chunk]);
    expect(inputs[2]!.vector).toEqual([NaN]);
    expect(inputs[3]!.vector).toEqual([Infinity]);
  });
});
