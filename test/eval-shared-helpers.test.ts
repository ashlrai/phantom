import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isEvalHelpRequest, parseStrictEvalFlags } from '../src/cli/eval-cli-shared.js';
import { cmdEval } from '../src/cli/eval.js';
import { assertUniqueEvalLanes, type EvalLane } from '../src/core/eval/agent-output.js';
import {
  asRecord,
  formatEvalMinutes,
  formatEvalPct,
  formatEvalUsd,
  iterVersionedDatasetLines,
  loadJsonReports,
  resolveEvalAshlrRoot,
  sha256Hex,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from '../src/core/eval/dataset-jsonl.js';
import { formatMetricReport, policyJobView } from '../src/core/eval/router-eval.js';

const tmpDirs: string[] = [];
const prevAshlrHome = process.env.ASHLR_HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
});

describe('eval shared dataset and storage helpers', () => {
  it('iterates v=1 dataset lines with 1-based line numbers and validates meta ordering', () => {
    const text = [
      '# header comment',
      '',
      '{"v":1,"kind":"meta","id":"demo"}',
      '{"v":1,"id":"item-1"}',
    ].join('\n');
    const items = [...iterVersionedDatasetLines(text, 'ds.jsonl', 'meta must precede entries')];
    expect(items).toEqual([
      { kind: 'meta', rec: { v: 1, kind: 'meta', id: 'demo' }, line: 3 },
      { kind: 'entry', rec: { v: 1, id: 'item-1' }, line: 4 },
    ]);
    expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => [...iterVersionedDatasetLines('{"v":2,"id":"x"}', 'ds.jsonl', 'late')]).toThrow('ds.jsonl:1: unsupported v 2');
    expect(() => [...iterVersionedDatasetLines('{"v":1,"kind":"meta"}\n{"v":1,"kind":"meta"}', 'ds.jsonl', 'late')]).toThrow('ds.jsonl:2: duplicate meta line');
    expect(() => [...iterVersionedDatasetLines('{"v":1,"id":"a"}\n{"v":1,"kind":"meta"}', 'ds.jsonl', 'meta must precede entries')]).toThrow('ds.jsonl:2: meta must precede entries');
  });

  it('resolves eval ASHLR root with explicit > ASHLR_HOME > ~/.ashlr precedence', () => {
    process.env.ASHLR_HOME = '/tmp/env-ashlr';
    expect(resolveEvalAshlrRoot('/tmp/explicit')).toBe('/tmp/explicit');
    expect(resolveEvalAshlrRoot('   ')).toBe('/tmp/env-ashlr');
    process.env.ASHLR_HOME = '  ';
    expect(resolveEvalAshlrRoot()).toBe(join(homedir(), '.ashlr'));
  });

  it('writes files atomically and loads sorted valid JSON reports', () => {
    const dir = makeTempDir('eval-shared-');
    const nested = join(dir, 'nested', 'note.txt');
    writeTextFileAtomic(nested, 'hello\n');
    expect(readFileSync(nested, 'utf8')).toBe('hello\n');

    const reportsDir = join(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeJsonFileAtomic(join(reportsDir, 'b.json'), { id: 'b', ts: '2026-11-02T00:00:00Z' });
    writeJsonFileAtomic(join(reportsDir, 'a.json'), { id: 'a', ts: '2026-11-01T00:00:00Z' });
    writeFileSync(join(reportsDir, 'broken.json'), '{not-json');
    writeFileSync(join(reportsDir, 'wrong.json'), JSON.stringify({ id: 'skip' }));
    writeFileSync(join(reportsDir, 'ignore.txt'), 'ignored');

    expect(readdirSync(reportsDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(loadJsonReports(join(dir, 'missing'), (v): v is { id: string; ts: string } => asRecord(v) !== undefined, (r) => r.ts)).toEqual([]);

    const loaded = loadJsonReports(
      reportsDir,
      (v): v is { id: string; ts: string } => {
        const rec = asRecord(v);
        return rec !== undefined && typeof rec['id'] === 'string' && typeof rec['ts'] === 'string';
      },
      (r) => r.ts,
    );
    expect(loaded.map((r) => r.id)).toEqual(['a', 'b']);
    expect(existsSync(join(reportsDir, 'a.json'))).toBe(true);
  });

  it('formats eval metrics, strips outcome fields in policyJobView, and validates lanes', () => {
    expect(formatEvalPct(0.6904)).toBe('69.0%');
    expect(formatEvalUsd(2.5)).toBe('$2.50');
    expect(formatEvalMinutes(150_000)).toBe('3m');
    expect(formatMetricReport({ value: null, ci95: null, n: 0 }, formatEvalPct)).toBe('unknown');
    expect(formatMetricReport({ value: 0.5, ci95: null, n: 1 }, formatEvalPct)).toBe('50.0% [no CI]');
    expect(formatMetricReport({ value: 0.5, ci95: [0.2, 0.8], n: 10, degenerate: 2 }, formatEvalPct, true))
      .toBe('50.0% [20.0% – 80.0%] (n=10, 2 degenerate)');

    const view = policyJobView({
      id: 'J1', repo: 'phantom', pool: 'work', tier: 'mid', priority: 'P1', task: 'fix',
      candidates: ['a', 'b'], chosen: 'a', outcome: 'merged', costUsd: 1.5, tokens: 100, wallTimeMs: 5000,
      arms: { b: { outcome: 'closed' } },
    });
    expect(view).toEqual({
      id: 'J1', at: undefined, repo: 'phantom', pool: 'work', tier: 'mid', priority: 'P1', task: 'fix',
      candidates: ['a', 'b'],
    });
    expect('chosen' in view || 'outcome' in view || 'arms' in view).toBe(false);

    const runner: EvalLane['runner'] = async () => '';
    expect(() => assertUniqueEvalLanes([{ lane: 'work', model: 'm1', runner }, { lane: 'work', model: 'm2', runner }])).not.toThrow();
    expect(() => assertUniqueEvalLanes([{ lane: '', model: 'm1', runner }])).toThrow('invalid or duplicate lane/model');
    expect(() => assertUniqueEvalLanes([{ lane: 'work', model: 'm1', runner }, { lane: 'work', model: 'm1', runner }])).toThrow('invalid or duplicate lane/model');
  });
});

describe('eval CLI shared flag helpers', () => {
  it('detects help requests and parses strict boolean, value, and repeatable flags', () => {
    expect(isEvalHelpRequest(['--help'])).toBe(true);
    expect(isEvalHelpRequest(['--json', '-h'])).toBe(true);
    expect(isEvalHelpRequest(['help'])).toBe(true);
    expect(isEvalHelpRequest(['--json'])).toBe(false);

    const ok = parseStrictEvalFlags(
      ['--json', '--dataset', 'jobs.jsonl', '--lane', 'a:m1', '--lane', 'b:m2'],
      { booleans: ['--json'], values: ['--dataset'], repeatable: ['--lane'] },
    );
    expect(ok.usageError).toBeUndefined();
    expect(ok.flags.has('--json')).toBe(true);
    expect(ok.values.get('--dataset')).toBe('jobs.jsonl');
    expect(ok.repeated.get('--lane')).toEqual(['a:m1', 'b:m2']);

    expect(parseStrictEvalFlags(['--json', '--json'], { booleans: ['--json'] }).usageError).toBe('repeated argument: --json');
    expect(parseStrictEvalFlags(['--dataset'], { values: ['--dataset'] }).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['--dataset', '--json'], { booleans: ['--json'], values: ['--dataset'] }).usageError).toBe('--dataset requires a value');
    expect(parseStrictEvalFlags(['--bogus'], { booleans: ['--json'] }).usageError).toBe('unknown argument: --bogus');
  });

  it('does not dispatch Object.prototype properties as eval subcommands', async () => {
    expect(await cmdEval(['toString'])).toBe(2);
    expect(await cmdEval(['constructor'])).toBe(2);
  });
});
