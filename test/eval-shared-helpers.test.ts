import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertValidEvalLanes } from '../src/core/eval/agent-output.js';
import {
  asRecord,
  evalAshlrRoot,
  loadSortedEvalJsonFiles,
  optString,
  parseVersionedJsonlDataset,
  writeEvalFileAtomically,
} from '../src/core/eval/dataset-jsonl.js';
import {
  formatEvalMinutes,
  formatEvalPct,
  formatEvalUsd,
  policyJobView,
  type RouterEvalJob,
} from '../src/core/eval/router-eval.js';
import { isEvalHelpRequest, parseEvalCliFlags } from '../src/cli/eval-args.js';

const tempDirs: string[] = [];
const originalAshlrHome = process.env.ASHLR_HOME;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = originalAshlrHome;
});

describe('parseVersionedJsonlDataset', () => {
  const spec = {
    itemKind: 'entry',
    initialMeta: { id: undefined as string | undefined },
    parseMeta: (rec: Record<string, unknown>, file: string, line: number) => ({
      id: optString(file, line, rec, 'id'),
    }),
    parseItem: (rec: Record<string, unknown>, file: string, line: number, seen: Set<string>) => {
      const id = optString(file, line, rec, 'id') ?? '';
      seen.add(id);
      return id;
    },
  };

  it('skips blank lines and comments, parses meta and items, and hashes raw text', () => {
    const text = [
      '# header comment',
      '',
      '{"v":1,"kind":"meta","id":"bench-1"}',
      '{"v":1,"kind":"entry","id":"a"}',
      '{"v":1,"id":"b"}',
    ].join('\n');
    const parsed = parseVersionedJsonlDataset(text, 'fixture.jsonl', spec);
    expect(parsed.meta).toEqual({ id: 'bench-1' });
    expect(parsed.items).toEqual(['a', 'b']);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects bad version, late meta, duplicate meta, unknown kind, and empty required datasets', () => {
    expect(() => parseVersionedJsonlDataset('{"v":2,"id":"a"}', 'f.jsonl', spec))
      .toThrow('f.jsonl:1: unsupported v 2');
    expect(() => parseVersionedJsonlDataset('{"v":1,"id":"a"}\n{"v":1,"kind":"meta"}', 'f.jsonl', spec))
      .toThrow('f.jsonl:2: meta must precede entry lines');
    expect(() => parseVersionedJsonlDataset('{"v":1,"kind":"meta"}\n{"v":1,"kind":"meta"}', 'f.jsonl', spec))
      .toThrow('f.jsonl:2: duplicate meta line');
    expect(() => parseVersionedJsonlDataset('{"v":1,"kind":"other","id":"a"}', 'f.jsonl', spec))
      .toThrow('f.jsonl:1: unknown kind "other"');
    expect(() => parseVersionedJsonlDataset('# empty\n', 'f.jsonl', { ...spec, emptyMessage: 'no entries' }))
      .toThrow('f.jsonl:0: no entries');
    expect(parseVersionedJsonlDataset('# empty\n', 'f.jsonl', spec).items).toEqual([]);
  });
});

describe('evalAshlrRoot, writeEvalFileAtomically, and loadSortedEvalJsonFiles', () => {
  it('resolves rootDir over ASHLR_HOME over ~/.ashlr while ignoring blank values', () => {
    process.env.ASHLR_HOME = '/custom/ashlr-env';
    expect(evalAshlrRoot('/explicit/root')).toBe('/explicit/root');
    expect(evalAshlrRoot('   ')).toBe('/custom/ashlr-env');
    expect(evalAshlrRoot(undefined)).toBe('/custom/ashlr-env');

    process.env.ASHLR_HOME = '   ';
    expect(evalAshlrRoot()).toBe(path.join(homedir(), '.ashlr'));
    delete process.env.ASHLR_HOME;
    expect(evalAshlrRoot()).toBe(path.join(homedir(), '.ashlr'));
  });

  it('writes atomically without leaving .tmp files and cleans up on rename failure', () => {
    const dir = makeTempDir('eval-atomic-');
    const target = path.join(dir, 'nested', 'report.json');
    writeEvalFileAtomically(target, '{"ok":true}\n');
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
    expect(readdirSync(path.dirname(target))).toEqual(['report.json']);

    // Overwriting a directory with renameSync throws; the temporary file must be removed.
    const blockingDir = path.join(dir, 'occupied');
    mkdirSync(blockingDir, { recursive: true });
    expect(() => writeEvalFileAtomically(blockingDir, 'nope')).toThrow();
    expect(readdirSync(dir).some((entry) => entry.endsWith('.tmp'))).toBe(false);
    expect(existsSync(blockingDir)).toBe(true);
  });

  it('loads valid JSON files sorted by timestamp and skips malformed or non-matching entries', () => {
    const dir = makeTempDir('eval-load-');
    expect(loadSortedEvalJsonFiles(path.join(dir, 'missing'), (_v): _v is { ts: string } => true, (x) => x.ts)).toEqual([]);

    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ id: 'b', ts: '2026-11-02T00:00:00Z' }));
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', ts: '2026-11-01T00:00:00Z' }));
    writeFileSync(path.join(dir, 'bad.json'), '{not-json');
    writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ id: 123 }));
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const isEntry = (v: unknown): v is { id: string; ts: string } => {
      const rec = asRecord(v);
      return rec !== undefined && typeof rec['id'] === 'string' && typeof rec['ts'] === 'string';
    };
    expect(loadSortedEvalJsonFiles(dir, isEntry, (x) => x.ts).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('assertValidEvalLanes, policyJobView, and formatting helpers', () => {
  const runner = async () => '';

  it('accepts distinct lane/model pairs and rejects blank or duplicate pairs', () => {
    expect(() => assertValidEvalLanes([
      { lane: 'work', model: 'a', runner },
      { lane: 'work', model: 'b', runner },
      { lane: 'fast', model: 'a', runner },
    ])).not.toThrow();
    expect(() => assertValidEvalLanes([{ lane: '', model: 'a', runner }])).toThrow('invalid or duplicate lane/model');
    expect(() => assertValidEvalLanes([{ lane: 'work', model: '', runner }])).toThrow('invalid or duplicate lane/model');
    expect(() => assertValidEvalLanes([
      { lane: 'work', model: 'a', runner },
      { lane: 'work', model: 'a', runner },
    ])).toThrow('invalid or duplicate lane/model');
  });

  it('strips recorded outcome columns in policyJobView and formats eval metrics consistently', () => {
    const job: RouterEvalJob = {
      id: 'J1',
      at: '2026-11-26T00:00:00Z',
      repo: 'phantom',
      pool: 'work',
      tier: 'mid',
      priority: 'P1',
      task: 'tighten eval',
      candidates: ['work', 'fast'],
      chosen: 'work',
      outcome: 'merged',
      costUsd: 1.5,
      tokens: 1200,
      wallTimeMs: 90_000,
      arms: { fast: { outcome: 'closed' } },
    };
    const view = policyJobView(job);
    expect(view).toEqual({
      id: 'J1',
      at: '2026-11-26T00:00:00Z',
      repo: 'phantom',
      pool: 'work',
      tier: 'mid',
      priority: 'P1',
      task: 'tighten eval',
      candidates: ['work', 'fast'],
    });
    expect('chosen' in view).toBe(false);
    expect('outcome' in view).toBe(false);
    expect('arms' in view).toBe(false);

    expect(formatEvalPct(0.6904)).toBe('69.0%');
    expect(formatEvalUsd(2.5)).toBe('$2.50');
    expect(formatEvalMinutes(180_000)).toBe('3m');
  });
});

describe('eval-args CLI helpers', () => {
  it('recognizes --help, -h, and leading help only', () => {
    expect(isEvalHelpRequest(['--help'])).toBe(true);
    expect(isEvalHelpRequest(['--json', '-h'])).toBe(true);
    expect(isEvalHelpRequest(['help'])).toBe(true);
    expect(isEvalHelpRequest(['--lane', 'help'])).toBe(false);
    expect(isEvalHelpRequest([])).toBe(false);
  });

  it('parses single-occurrence boolean/value flags and rejects bad usage safely', () => {
    const spec = {
      booleans: { '--json': 'json' as const },
      values: { '--dataset': 'dataset' as const, '--out': 'out' as const },
    };
    expect(parseEvalCliFlags(['--dataset', 'a.jsonl', '--json'], spec)).toEqual({
      booleans: { json: true },
      values: { dataset: 'a.jsonl' },
    });
    expect(parseEvalCliFlags(['--json', '--json'], spec).usageError).toBe('repeated argument: --json');
    expect(parseEvalCliFlags(['--dataset'], spec).usageError).toBe('--dataset requires a value');
    expect(parseEvalCliFlags(['--dataset', '--json'], spec).usageError).toBe('--dataset requires a value');
    expect(parseEvalCliFlags(['--bogus'], spec).usageError).toBe('unknown argument: --bogus');
    expect(parseEvalCliFlags(['toString'], spec).usageError).toBe('unknown argument: toString');
  });
});
