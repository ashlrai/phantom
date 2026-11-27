import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertValidEvalLanes, type EvalLane } from '../src/core/eval/agent-output.js';
import { asRecord, loadJsonReports, resolveEvalRoot, writeJsonAtomic, writeTextAtomic } from '../src/core/eval/dataset-jsonl.js';
import { parsePassKDataset, runPassKEval } from '../src/core/eval/passk.js';
import { formatEvalMinutes, formatEvalPercent, formatEvalUsd, formatMetricWithCi, policyJobView, type RouterEvalJob } from '../src/core/eval/router-eval.js';
import { isEvalHelpRequest } from '../src/cli/eval-shared.js';

const tmpDirs: string[] = [];
const makeTmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'eval-shared-test-'));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('eval shared helpers', () => {
  it('resolveEvalRoot honors rootDir, then ASHLR_HOME, then ~/.ashlr', () => {
    const prev = process.env.ASHLR_HOME;
    try {
      process.env.ASHLR_HOME = '/custom/ashlr-home';
      expect(resolveEvalRoot('/explicit/root')).toBe('/explicit/root');
      expect(resolveEvalRoot('   ')).toBe('/custom/ashlr-home');
      expect(resolveEvalRoot()).toBe('/custom/ashlr-home');
      delete process.env.ASHLR_HOME;
      expect(resolveEvalRoot()).toBe(path.join(homedir(), '.ashlr'));
    } finally {
      if (prev === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = prev;
    }
  });

  it('writeTextAtomic / writeJsonAtomic / loadJsonReports round-trip cleanly and ignore malformed files', () => {
    const root = makeTmpDir();
    const dir = path.join(root, 'reports');
    writeTextAtomic(path.join(dir, 'note.txt'), 'ok\n');
    writeJsonAtomic(path.join(dir, 'b.json'), { id: 'second', ts: '2026-11-02T00:00:00Z' });
    writeJsonAtomic(path.join(dir, 'a.json'), { id: 'first', ts: '2026-11-01T00:00:00Z' });
    writeFileSync(path.join(dir, 'bad.json'), '{not json');
    writeFileSync(path.join(dir, 'skip.json'), JSON.stringify({ id: 'no-ts' }));

    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toMatch(/\n$/);
    const isItem = (v: unknown): v is { id: string; ts: string } => {
      const rec = asRecord(v);
      return rec !== undefined && typeof rec['id'] === 'string' && typeof rec['ts'] === 'string';
    };
    expect(loadJsonReports(path.join(root, 'missing'), isItem, (a, b) => a.ts.localeCompare(b.ts))).toEqual([]);
    expect(loadJsonReports(dir, isItem, (a, b) => a.ts.localeCompare(b.ts)).map((r) => r.id)).toEqual(['first', 'second']);
    mkdirSync(path.join(root, 'empty'));
    expect(loadJsonReports(path.join(root, 'empty'), isItem, (a, b) => a.ts.localeCompare(b.ts))).toEqual([]);
  });

  it('assertValidEvalLanes, policyJobView, format helpers, and CLI help helper stay consistent', () => {
    const lane = (l: string, m: string): EvalLane => ({ lane: l, model: m, runner: async () => '' });
    expect(() => assertValidEvalLanes([lane('work', 'm1'), lane('work', 'm2')])).not.toThrow();
    expect(() => assertValidEvalLanes([lane('', 'm1')])).toThrow('invalid or duplicate lane/model');
    expect(() => assertValidEvalLanes([lane('work', 'm1'), lane('work', 'm1')])).toThrow('invalid or duplicate lane/model');

    const job: RouterEvalJob = {
      id: 'J-1', repo: 'phantom', pool: 'work', tier: 'mid', priority: 'P1', task: 'fix docs',
      candidates: ['a', 'b'], chosen: 'a', outcome: 'merged', costUsd: 1.5, tokens: 1000, wallTimeMs: 60_000,
    };
    const view = policyJobView(job);
    expect(view).toEqual({ id: 'J-1', at: undefined, repo: 'phantom', pool: 'work', tier: 'mid', priority: 'P1', task: 'fix docs', candidates: ['a', 'b'] });
    expect('outcome' in view || 'chosen' in view).toBe(false);
    expect([formatEvalPercent(0.755), formatEvalUsd(1.2), formatEvalMinutes(150_000)]).toEqual(['75.5%', '$1.20', '3m']);
    expect(formatMetricWithCi({ value: null, ci95: null, n: 0 }, formatEvalPercent)).toBe('unknown');
    expect(formatMetricWithCi({ value: 0.5, ci95: [0.2, 0.8], n: 10, degenerate: 2 }, formatEvalPercent, { includeSampleSize: true })).toBe('50.0% [20.0% – 80.0%] (n=10, 2 degenerate)');
    expect([isEvalHelpRequest(['--help']), isEvalHelpRequest(['help']), isEvalHelpRequest(['--policy', 'help'])]).toEqual([true, true, false]);
  });

  it('runPassKEval distinguishes malformed diffs from empty diffs', async () => {
    const ds = parsePassKDataset(JSON.stringify({
      v: 1, kind: 'task', id: 't1', problemStatement: 'fix', goldTestCommand: 'node t.cjs',
      files: { 'a.js': 'x\n', 't.cjs': 'process.exit(1);\n' }, maxChangedLines: 4,
    }));
    const report = await runPassKEval(ds, [
      { lane: 'empty', model: 'm', runner: async () => '' },
      { lane: 'bad', model: 'm', runner: async () => 'not a valid diff' },
    ], { trials: 1, k: 1 });
    expect(report.lanes[0]!.tasks[0]!.trialsDetail[0]!.error).toBe('no patch produced');
    expect(report.lanes[1]!.tasks[0]!.trialsDetail[0]!.error).toBe('patch application failed');
  });
});
