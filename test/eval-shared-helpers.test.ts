import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isEvalHelpArgs,
  parseStrictEvalFlags,
  writeEvalJsonOutput,
} from '../src/cli/eval-cli-helpers.js';
import { assertValidEvalLanes } from '../src/core/eval/agent-output.js';
import {
  asRecord,
  atomicWriteEvalFile,
  atomicWriteEvalJson,
  isPathWithinDir,
  loadEvalJsonReports,
  parseV1DatasetLines,
  resolveEvalRoot,
  sha256Hex,
} from '../src/core/eval/dataset-jsonl.js';
import {
  formatEvalMetric,
  formatEvalMinutes,
  formatEvalPct,
  formatEvalUsd,
  policyJobView,
  type RouterEvalJob,
} from '../src/core/eval/router-eval.js';

const tempDirs: string[] = [];
const savedAshlrHome = process.env.ASHLR_HOME;

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ashlr-eval-helpers-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = savedAshlrHome;
});

describe('src/core/eval shared storage, path, and dataset helpers', () => {
  it('resolves eval root from explicit override, ASHLR_HOME, or ~/.ashlr', () => {
    process.env.ASHLR_HOME = '/tmp/ashlr-env-home';
    expect(resolveEvalRoot('/tmp/explicit-root')).toBe('/tmp/explicit-root');
    expect(resolveEvalRoot('   ')).toBe('/tmp/ashlr-env-home');
    delete process.env.ASHLR_HOME;
    expect(resolveEvalRoot()).toBe(path.join(homedir(), '.ashlr'));
  });

  it('writes atomically without leftover tmp files and loads sorted valid JSON reports', () => {
    const dir = makeTempDir();
    const reportsDir = path.join(dir, 'reports');
    const first = path.join(reportsDir, 'b.json');
    const second = path.join(reportsDir, 'a.json');

    atomicWriteEvalFile(path.join(dir, 'nested', 'note.txt'), 'hello\n');
    expect(readFileSync(path.join(dir, 'nested', 'note.txt'), 'utf8')).toBe('hello\n');

    atomicWriteEvalJson(first, { id: 'r2', at: '2026-11-02T00:00:00Z' });
    atomicWriteEvalJson(second, { id: 'r1', at: '2026-11-01T00:00:00Z' });
    writeFileSync(path.join(reportsDir, 'broken.json'), '{not-json', 'utf8');
    writeFileSync(path.join(reportsDir, 'other.json'), JSON.stringify({ id: 'skip' }), 'utf8');
    writeFileSync(path.join(reportsDir, 'ignore.txt'), 'ignored', 'utf8');

    expect(existsSync(first)).toBe(true);
    expect(readdirSync(reportsDir).some((name) => name.endsWith('.tmp'))).toBe(false);

    type Row = { id: string; at: string };
    const isRow = (v: unknown): v is Row => {
      const rec = asRecord(v);
      return rec !== undefined && typeof rec['id'] === 'string' && typeof rec['at'] === 'string';
    };
    expect(loadEvalJsonReports(reportsDir, isRow, (r) => r.at)).toEqual([
      { id: 'r1', at: '2026-11-01T00:00:00Z' },
      { id: 'r2', at: '2026-11-02T00:00:00Z' },
    ]);
    expect(loadEvalJsonReports(path.join(dir, 'missing'), isRow, (r) => r.at)).toEqual([]);
  });

  it('checks path confinement without sibling-prefix bypasses', () => {
    const base = makeTempDir();
    const child = path.join(base, 'sub', 'file.ts');
    const sibling = `${base}-other`;
    mkdirSync(path.dirname(child), { recursive: true });

    expect(isPathWithinDir(child, base)).toBe(true);
    expect(isPathWithinDir(base, base)).toBe(false);
    expect(isPathWithinDir(base, base, true)).toBe(true);
    expect(isPathWithinDir(path.join(sibling, 'file.ts'), base, true)).toBe(false);
    expect(isPathWithinDir(path.join(base, '..', 'escape.ts'), base, true)).toBe(false);
  });

  it('parses v1 JSONL dataset lines with line numbers and computes sha256Hex', () => {
    const raw = [
      '# comment',
      '',
      JSON.stringify({ v: 1, kind: 'meta', id: 'ds-1' }),
      JSON.stringify({ v: 1, id: 'j1' }),
    ].join('\n');
    expect(parseV1DatasetLines(raw, 'test.jsonl')).toEqual([
      { line: 3, rec: { v: 1, kind: 'meta', id: 'ds-1' } },
      { line: 4, rec: { v: 1, id: 'j1' } },
    ]);
    expect(() => parseV1DatasetLines(JSON.stringify({ v: 2, id: 'j1' }), 'bad.jsonl')).toThrow(/bad\.jsonl:1: unsupported v 2/);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('strips outcome fields in policyJobView, formats eval metrics, and validates lanes', () => {
    const job: RouterEvalJob = {
      id: 'j1',
      at: '2026-11-01T00:00:00Z',
      repo: 'phantom',
      pool: 'work',
      tier: 'mid',
      priority: 'P1',
      task: 'fix docs',
      candidates: ['a', 'b'],
      chosen: 'a',
      outcome: 'merged',
      costUsd: 1.5,
      tokens: 1000,
      wallTimeMs: 120_000,
      arms: { b: { outcome: 'failed' } },
    };
    const view = policyJobView(job);
    expect(view).toEqual({
      id: 'j1',
      at: '2026-11-01T00:00:00Z',
      repo: 'phantom',
      pool: 'work',
      tier: 'mid',
      priority: 'P1',
      task: 'fix docs',
      candidates: ['a', 'b'],
    });
    expect('outcome' in view).toBe(false);

    expect(formatEvalMetric({ value: null, ci95: null, n: 0 }, formatEvalPct)).toBe('unknown');
    expect(formatEvalMetric({ value: 0.5, ci95: [0.25, 0.75], n: 10 }, formatEvalPct)).toBe('50.0% [25.0% – 75.0%]');
    expect(formatEvalMetric({ value: 2.5, ci95: null, n: 4, degenerate: 1 }, formatEvalUsd, true)).toBe('$2.50 [no CI] (n=4, 1 degenerate)');
    expect(formatEvalMinutes(90_000)).toBe('2m');

    const runner = async () => '';
    expect(() => assertValidEvalLanes([{ lane: 'local', model: 'm1', runner }, { lane: 'local', model: 'm2', runner }])).not.toThrow();
    expect(() => assertValidEvalLanes([{ lane: '', model: 'm1', runner }])).toThrow(/invalid or duplicate/);
    expect(() => assertValidEvalLanes([{ lane: 'local', model: 'm1', runner }, { lane: 'local', model: 'm1', runner }])).toThrow(/invalid or duplicate/);
  });
});

describe('src/cli/eval-cli-helpers', () => {
  it('detects help flags and parses strict single-occurrence flags safely', () => {
    expect(isEvalHelpArgs(['--help'])).toBe(true);
    expect(isEvalHelpArgs(['--json', '-h'])).toBe(true);
    expect(isEvalHelpArgs(['help'])).toBe(true);
    expect(isEvalHelpArgs(['--dataset', 'help'])).toBe(false);

    const spec = {
      booleans: { '--json': 'json' } as const,
      values: { '--dataset': 'dataset', '--out': 'out' } as const,
    };
    expect(parseStrictEvalFlags(['--dataset', 'jobs.jsonl', '--json'], spec)).toEqual({
      booleans: { json: true },
      values: { dataset: 'jobs.jsonl' },
    });
    expect(parseStrictEvalFlags(['--json', '--json'], spec).usageError).toBe('repeated argument: --json');
    expect(parseStrictEvalFlags(['--dataset'], spec).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['--dataset', '--json'], spec).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['toString'], spec).usageError).toBe('unknown argument: toString');
  });

  it('writes pretty JSON with trailing newline and reports failures cleanly', () => {
    const written: Array<[string, string]> = [];
    const errs: string[] = [];
    expect(writeEvalJsonOutput((p, t) => written.push([p, t]), 'out.json', { ok: true }, (m) => errs.push(m), 'write failed')).toBe(true);
    expect(written).toEqual([['out.json', '{\n  "ok": true\n}\n']]);
    expect(errs).toEqual([]);

    expect(writeEvalJsonOutput(() => { throw new Error('disk full'); }, 'out.json', { ok: true }, (m) => errs.push(m), 'write failed')).toBe(false);
    expect(errs).toEqual(['write failed']);
  });
});
