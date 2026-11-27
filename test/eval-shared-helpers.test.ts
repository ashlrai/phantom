import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isEvalHelpRequest, parseStrictEvalFlags } from '../src/cli/eval.js';
import { assertValidEvalLanes } from '../src/core/eval/agent-output.js';
import {
  asRecord,
  atomicWriteFile,
  atomicWriteJson,
  formatEvalMinutes,
  formatEvalPct,
  formatEvalUsd,
  loadJsonDirReports,
  resolveAshlrRoot,
} from '../src/core/eval/dataset-jsonl.js';
import { formatMetricReport, policyJobView } from '../src/core/eval/router-eval.js';

const tempDirs: string[] = [];
const origAshlrHome = process.env.ASHLR_HOME;

afterEach(() => {
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('eval shared helpers', () => {
  it('resolves ashlr root with explicit override -> ASHLR_HOME -> ~/.ashlr precedence', () => {
    delete process.env.ASHLR_HOME;
    expect(resolveAshlrRoot()).toBe(join(homedir(), '.ashlr'));
    process.env.ASHLR_HOME = '/custom/ashlr-home';
    expect(resolveAshlrRoot()).toBe('/custom/ashlr-home');
    expect(resolveAshlrRoot('   ')).toBe('/custom/ashlr-home');
    expect(resolveAshlrRoot('/explicit/root')).toBe('/explicit/root');
  });

  it('writes files and JSON atomically and cleans up temp siblings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-eval-helpers-'));
    tempDirs.push(dir);
    const target = join(dir, 'nested', 'report.json');
    atomicWriteJson(target, { ok: true, count: 2 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ok: true, count: 2 });
    expect(readFileSync(target, 'utf8').endsWith('\n')).toBe(true);
    expect(readdirSync(join(dir, 'nested')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    atomicWriteFile(target, 'updated\n');
    expect(readFileSync(target, 'utf8')).toBe('updated\n');
  });

  it('loads valid sorted JSON reports from a directory and skips malformed or rejected files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-eval-dir-'));
    tempDirs.push(dir);
    expect(loadJsonDirReports(join(dir, 'missing'), (v): v is { ts: string } => asRecord(v) !== undefined, (r) => r.ts)).toEqual([]);
    const reportsDir = join(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, 'b.json'), JSON.stringify({ id: 'second', ts: '2026-11-02T00:00:00Z' }), 'utf8');
    writeFileSync(join(reportsDir, 'a.json'), JSON.stringify({ id: 'first', ts: '2026-11-01T00:00:00Z' }), 'utf8');
    writeFileSync(join(reportsDir, 'bad.json'), '{not-json', 'utf8');
    writeFileSync(join(reportsDir, 'wrong.json'), JSON.stringify({ id: 'no-ts' }), 'utf8');
    writeFileSync(join(reportsDir, 'ignore.txt'), 'plain text', 'utf8');

    const accept = (v: unknown): v is { id: string; ts: string } => {
      const rec = asRecord(v);
      return rec !== undefined && typeof rec['id'] === 'string' && typeof rec['ts'] === 'string';
    };
    expect(loadJsonDirReports(reportsDir, accept, (r) => r.ts).map((r) => r.id)).toEqual(['first', 'second']);
  });

  it('formats eval percentages, USD, minutes, and metric CIs while preserving unknown', () => {
    expect(formatEvalPct(0.7524)).toBe('75.2%');
    expect(formatEvalUsd(1.5)).toBe('$1.50');
    expect(formatEvalMinutes(90_000)).toBe('2m');
    expect(formatMetricReport({ value: null, ci95: null, n: 0 }, formatEvalPct)).toBe('unknown');
    expect(formatMetricReport({ value: 0.5, ci95: [0.25, 0.75], n: 10 }, formatEvalPct)).toBe('50.0% [25.0% – 75.0%]');
    expect(
      formatMetricReport({ value: 0.5, ci95: null, n: 4, degenerate: 1 }, formatEvalPct, { includeSampleCount: true }),
    ).toBe('50.0% [no CI] (n=4, 1 degenerate)');
  });

  it('strips outcome fields in policyJobView and validates eval lane lists', () => {
    const view = policyJobView({
      id: 'j1',
      repo: 'phantom',
      pool: 'work',
      tier: 'work',
      task: 'fix lint',
      candidates: ['a', 'b'],
      chosen: 'a',
      outcome: 'merged',
      costUsd: 1.25,
      tokens: 1000,
      wallTimeMs: 5000,
    });
    expect(view).toEqual({
      id: 'j1',
      at: undefined,
      repo: 'phantom',
      pool: 'work',
      tier: 'work',
      priority: undefined,
      task: 'fix lint',
      candidates: ['a', 'b'],
    });
    expect('outcome' in view).toBe(false);
    expect('costUsd' in view).toBe(false);

    expect(() => assertValidEvalLanes([{ lane: 'work', model: 'm1' }, { lane: 'fast', model: 'm1' }])).not.toThrow();
    expect(() => assertValidEvalLanes([{ lane: '', model: 'm1' }])).toThrow('invalid or duplicate lane/model');
    expect(() => assertValidEvalLanes([{ lane: 'work', model: 'm1' }, { lane: 'work', model: 'm1' }])).toThrow(
      'invalid or duplicate lane/model',
    );
  });

  it('parses strict eval CLI flags and detects help requests', () => {
    expect(isEvalHelpRequest(['--help'])).toBe(true);
    expect(isEvalHelpRequest(['-h'])).toBe(true);
    expect(isEvalHelpRequest(['help'])).toBe(true);
    expect(isEvalHelpRequest(['--json'])).toBe(false);

    const spec = { boolFlags: ['--json'] as const, valueFlags: ['--dataset', '--out'] as const };
    expect(parseStrictEvalFlags(['--dataset', 'jobs.jsonl', '--json'], spec)).toEqual({
      bools: { '--json': true },
      values: { '--dataset': 'jobs.jsonl' },
    });
    expect(parseStrictEvalFlags(['--json', '--json'], spec).usageError).toBe('repeated argument: --json');
    expect(parseStrictEvalFlags(['--dataset'], spec).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['--dataset', '--json'], spec).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['--bogus'], spec).usageError).toBe('unknown argument: --bogus');
  });
});
