import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validateEvalLanes, type EvalLane } from '../src/core/eval/agent-output.js';
import {
  asRecord,
  atomicWriteText,
  formatMinutes,
  formatPct,
  formatUsd,
  parseDatasetLine,
  resolveEvalRoot,
} from '../src/core/eval/dataset-jsonl.js';
import { policyJobView, type RouterEvalJob } from '../src/core/eval/router-eval.js';

const tmpdirs: string[] = [];
const originalAshlrHome = process.env.ASHLR_HOME;

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eval-shared-helpers-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = originalAshlrHome;
  while (tmpdirs.length > 0) {
    rmSync(tmpdirs.pop()!, { recursive: true, force: true });
  }
});

describe('resolveEvalRoot', () => {
  it('prefers an explicit non-blank rootDir over ASHLR_HOME and ~/.ashlr', () => {
    process.env.ASHLR_HOME = '/tmp/from-env';
    expect(resolveEvalRoot('/tmp/explicit-root')).toBe('/tmp/explicit-root');
  });

  it('falls back from blank rootDir to ASHLR_HOME, then ~/.ashlr', () => {
    process.env.ASHLR_HOME = '/tmp/from-env';
    expect(resolveEvalRoot('   ')).toBe('/tmp/from-env');
    expect(resolveEvalRoot(undefined)).toBe('/tmp/from-env');

    process.env.ASHLR_HOME = '   ';
    expect(resolveEvalRoot(undefined)).toBe(join(homedir(), '.ashlr'));

    delete process.env.ASHLR_HOME;
    expect(resolveEvalRoot(undefined)).toBe(join(homedir(), '.ashlr'));
  });
});

describe('atomicWriteText', () => {
  it('creates missing parent directories, writes content, and leaves no temp files behind', () => {
    const base = makeTmpDir();
    const target = join(base, 'nested', 'dir', 'report.json');

    atomicWriteText(target, '{"v":1}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}\n');
    expect(readdirSync(join(base, 'nested', 'dir'))).toEqual(['report.json']);

    atomicWriteText(target, '{"v":2}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"v":2}\n');
    expect(readdirSync(join(base, 'nested', 'dir'))).toEqual(['report.json']);
  });

  it('cleans up its temp file and rethrows when rename fails', () => {
    const base = makeTmpDir();
    const targetDir = join(base, 'existing-dir');
    mkdirSync(targetDir);

    expect(() => atomicWriteText(targetDir, 'cannot-overwrite-dir')).toThrow();
    expect(readdirSync(base)).toEqual(['existing-dir']);
  });
});

describe('eval metric formatters and record helpers', () => {
  it('formats percentages, USD amounts, and wall-time minutes consistently', () => {
    expect(formatPct(0)).toBe('0.0%');
    expect(formatPct(0.875)).toBe('87.5%');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.236)).toBe('$1.24');
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(90_000)).toBe('2m');
    expect(formatMinutes(125_000)).toBe('2m');
  });

  it('narrows plain objects with asRecord and rejects primitives/arrays/null', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord([1, 2])).toBeUndefined();
    expect(asRecord('text')).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
  });

  it('parses JSON object lines and rejects non-JSON or non-object lines with file:line', () => {
    expect(parseDatasetLine('{"v":1}', 'set.jsonl', 3)).toEqual({ v: 1 });
    expect(() => parseDatasetLine('not-json', 'set.jsonl', 4)).toThrow('set.jsonl:4: not JSON');
    expect(() => parseDatasetLine('[1,2]', 'set.jsonl', 5)).toThrow('set.jsonl:5: line must be an object');
  });
});

describe('validateEvalLanes', () => {
  const runner: EvalLane['runner'] = async () => '';

  it('accepts unique lanes with non-empty lane and model names', () => {
    expect(() => validateEvalLanes([
      { lane: 'work', model: 'local-coder', runner },
      { lane: 'work', model: 'frontier-model', runner },
      { lane: 'fast', model: 'local-coder', runner },
    ])).not.toThrow();
  });

  it('rejects missing lane/model names or duplicate (lane, model) pairs', () => {
    expect(() => validateEvalLanes([{ lane: '', model: 'local-coder', runner }])).toThrow('invalid or duplicate lane/model');
    expect(() => validateEvalLanes([{ lane: 'work', model: '', runner }])).toThrow('invalid or duplicate lane/model');
    expect(() => validateEvalLanes([
      { lane: 'work', model: 'local-coder', runner },
      { lane: 'work', model: 'local-coder', runner },
    ])).toThrow('invalid or duplicate lane/model');
  });
});

describe('policyJobView', () => {
  it('retains router-time fields and strips outcome, cost, token, wall-time and counterfactual columns', () => {
    const job: RouterEvalJob = {
      id: 'job-1',
      at: '2026-11-25T00:00:00Z',
      repo: 'ashlrai/phantom',
      pool: 'work',
      tier: 'mid',
      priority: 'P1',
      task: 'fix regression in eval',
      candidates: ['work', 'fast'],
      chosen: 'work',
      outcome: 'merged',
      costUsd: 0.42,
      tokens: 12000,
      wallTimeMs: 45_000,
      arms: { work: { outcome: 'merged', costUsd: 0.42 } },
    };

    const view = policyJobView(job);
    expect(view).toEqual({
      id: 'job-1',
      at: '2026-11-25T00:00:00Z',
      repo: 'ashlrai/phantom',
      pool: 'work',
      tier: 'mid',
      priority: 'P1',
      task: 'fix regression in eval',
      candidates: ['work', 'fast'],
    });
    expect(Object.keys(view).sort()).toEqual(['at', 'candidates', 'id', 'pool', 'priority', 'repo', 'task', 'tier']);
  });
});
