import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isEvalHelpArgs, parseStrictEvalFlags } from '../src/cli/eval-args.js';
import {
  asRecord,
  evalAshlrRoot,
  loadEvalJsonReports,
  parseVersionedJsonlDataset,
  writeEvalFileAtomic,
} from '../src/core/eval/dataset-jsonl.js';
import {
  formatEvalMetricInterval,
  formatEvalMinutes,
  formatEvalPercent,
  formatEvalUsd,
  policyJobView,
  type RouterEvalJob,
} from '../src/core/eval/router-eval.js';
import { loadLastReport, saveReport, type BenchReport } from '../src/core/eval/swe-bench.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('eval shared store and JSONL helpers', () => {
  it('resolves evalAshlrRoot from explicit rootDir, then ASHLR_HOME, else ~/.ashlr', () => {
    const prev = process.env.ASHLR_HOME;
    try {
      process.env.ASHLR_HOME = '/tmp/custom-ashlr-home';
      expect(evalAshlrRoot('/tmp/explicit-root')).toBe('/tmp/explicit-root');
      expect(evalAshlrRoot('   ')).toBe('/tmp/custom-ashlr-home');
      expect(evalAshlrRoot()).toBe('/tmp/custom-ashlr-home');

      process.env.ASHLR_HOME = '   ';
      expect(evalAshlrRoot()).toBe(path.join(homedir(), '.ashlr'));
    } finally {
      if (prev === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prev;
    }
  });

  it('writes files atomically and leaves no temp artifacts behind', () => {
    const dir = makeTempDir('eval-atomic-');
    const target = path.join(dir, 'nested', 'state.json');
    writeEvalFileAtomic(target, '{"v":1}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}\n');

    writeEvalFileAtomic(target, '{"v":2}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}\n');
    expect(readdirSync(path.dirname(target))).toEqual(['state.json']);
  });

  it('loads valid JSON reports sorted by timestamp and skips malformed or non-matching files', () => {
    const dir = makeTempDir('eval-reports-');
    expect(loadEvalJsonReports(path.join(dir, 'missing'), (v): v is { ts: string } => asRecord(v) !== undefined, (r) => r.ts)).toEqual([]);

    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ id: 'later', ts: '2026-11-26T10:00:00.000Z' }), 'utf8');
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'earlier', ts: '2026-11-25T10:00:00.000Z' }), 'utf8');
    writeFileSync(path.join(dir, 'bad.json'), '{not-json', 'utf8');
    writeFileSync(path.join(dir, 'wrong-shape.json'), JSON.stringify({ id: 'missing-ts' }), 'utf8');
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored', 'utf8');

    const loaded = loadEvalJsonReports<{ id: string; ts: string }>(
      dir,
      (v): v is { id: string; ts: string } => {
        const rec = asRecord(v);
        return rec !== undefined && typeof rec['id'] === 'string' && typeof rec['ts'] === 'string';
      },
      (r) => r.ts,
    );
    expect(loaded.map((r) => r.id)).toEqual(['earlier', 'later']);
  });

  it('parses v=1 JSONL datasets with meta validation and deterministic sha256', () => {
    const text = [
      '# comment line',
      '',
      '{"v":1,"kind":"meta","id":"ds-1"}',
      '{"v":1,"kind":"item","id":"a"}',
      '{"v":1,"id":"b"}',
    ].join('\n');

    const parsed = parseVersionedJsonlDataset<{ id?: string }>(text, 'test.jsonl', {
      itemKind: 'item',
      initialMeta: {},
      parseMeta: (rec) => ({ id: typeof rec['id'] === 'string' ? rec['id'] : undefined }),
    });
    expect(parsed.meta).toEqual({ id: 'ds-1' });
    expect(parsed.rows.map((r) => r.rec['id'])).toEqual(['a', 'b']);
    expect(parsed.sha256).toMatch(/^[a-f0-9]{64}$/);

    expect(() => parseVersionedJsonlDataset('{"v":2,"id":"a"}', 'test.jsonl', {
      itemKind: 'item',
      initialMeta: {},
      parseMeta: () => ({}),
    })).toThrow('test.jsonl:1: unsupported v 2');

    expect(() => parseVersionedJsonlDataset('{"v":1,"id":"a"}\n{"v":1,"kind":"meta"}', 'test.jsonl', {
      itemKind: 'item',
      initialMeta: {},
      parseMeta: () => ({}),
    })).toThrow('test.jsonl:2: meta must precede item lines');

    expect(() => parseVersionedJsonlDataset('{"v":1,"kind":"meta"}\n{"v":1,"kind":"meta"}', 'test.jsonl', {
      itemKind: 'item',
      initialMeta: {},
      parseMeta: () => ({}),
    })).toThrow('test.jsonl:2: duplicate meta line');

    expect(() => parseVersionedJsonlDataset('{"v":1,"kind":"other"}', 'test.jsonl', {
      itemKind: 'item',
      initialMeta: {},
      parseMeta: () => ({}),
    })).toThrow('test.jsonl:1: unknown kind "other"');
  });

  it('skips non-report JSON files when loading the latest SWE-bench report', () => {
    const report: BenchReport = {
      id: 'bench-clean',
      ts: '2026-11-26T12:00:00.000Z',
      engine: 'local-coder',
      total: 1,
      resolved: 1,
      resolveRate: 1,
      perTask: [],
      byEngine: { 'local-coder': { total: 1, resolved: 1, resolveRate: 1 } },
    };
    const saved = saveReport(report);
    const evalDir = path.dirname(saved);
    const corrupt = path.join(evalDir, 'not-a-report.json');
    writeFileSync(corrupt, JSON.stringify({ unrelated: true }), 'utf8');
    try {
      expect(loadLastReport()?.id).toBe('bench-clean');
    } finally {
      rmSync(saved, { force: true });
      rmSync(corrupt, { force: true });
    }
  });
});

describe('eval shared view and metric formatters', () => {
  it('strips outcome, cost and counterfactual fields from PolicyJobView', () => {
    const job: RouterEvalJob = {
      id: 'job-1',
      at: '2026-11-26T00:00:00Z',
      repo: 'ashlrai/phantom',
      pool: 'work',
      tier: 'work',
      priority: 'P1',
      task: 'clean up eval helpers',
      candidates: ['work', 'mid'],
      chosen: 'work',
      outcome: 'merged',
      costUsd: 1.25,
      tokens: 4200,
      wallTimeMs: 90_000,
      arms: { mid: { outcome: 'failed' } },
    };
    const view = policyJobView(job);
    expect(view).toEqual({
      id: 'job-1',
      at: '2026-11-26T00:00:00Z',
      repo: 'ashlrai/phantom',
      pool: 'work',
      tier: 'work',
      priority: 'P1',
      task: 'clean up eval helpers',
      candidates: ['work', 'mid'],
    });
    expect('outcome' in view).toBe(false);
    expect('arms' in view).toBe(false);
  });

  it('formats metric intervals consistently across router-eval and prompt-ab', () => {
    expect(formatEvalMetricInterval({ value: null, ci95: null, n: 0 }, formatEvalPercent)).toBe('unknown');
    expect(formatEvalMetricInterval({ value: 0.5, ci95: null, n: 1 }, formatEvalPercent)).toBe('50.0% [no CI]');
    expect(formatEvalMetricInterval({ value: 1.5, ci95: [1.0, 2.0], n: 4 }, formatEvalUsd)).toBe('$1.50 [$1.00 – $2.00]');
    expect(formatEvalMinutes(120_000)).toBe('2m');
  });
});

describe('eval CLI strict flag helper', () => {
  it('detects help invocations across flags and subcommand forms', () => {
    expect(isEvalHelpArgs(['--help'])).toBe(true);
    expect(isEvalHelpArgs(['-h'])).toBe(true);
    expect(isEvalHelpArgs(['help'])).toBe(true);
    expect(isEvalHelpArgs(['--dataset', 'help'])).toBe(false);
  });

  it('parses unique boolean and value flags and rejects malformed usage', () => {
    const spec = { booleans: ['--json', '--promote'] as const, values: ['--dataset', '--out'] as const };
    expect(parseStrictEvalFlags(['--dataset', 'a.jsonl', '--json'], spec)).toEqual({
      booleans: { '--json': true, '--promote': false },
      values: { '--dataset': 'a.jsonl' },
    });
    expect(parseStrictEvalFlags(['--json', '--json'], spec).usageError).toBe('repeated argument: --json');
    expect(parseStrictEvalFlags(['--dataset', 'a', '--dataset', 'b'], spec).usageError).toBe('repeated argument: --dataset');
    expect(parseStrictEvalFlags(['--dataset'], spec).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['--dataset', '--json'], spec).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['--bogus'], spec).usageError).toBe('unknown argument: --bogus');
  });
});
