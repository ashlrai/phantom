import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetQueueParked } from '../src/cli/fleet-queue-parked.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Synthetic runs root in the layout the real reader parses; fake repos and job IDs only. */
function seed(readyRows: ((dir: string) => string[]) | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-queue-parked-627s-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'queue', 'prompts'), { recursive: true });
  mkdirSync(join(dir, 'metrics'), { recursive: true });
  writeFileSync(join(dir, 'queue', 'prompts', 'met.md'), 'DEPENDENCY GATE: RQ-DONE\n');
  writeFileSync(join(dir, 'queue', 'prompts', 'unmet.md'), 'DEPENDENCY GATE: RQ-OPEN\n');
  writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-DONE' })}\n`);
  writeFileSync(join(dir, 'queue', 'precheck-skips.tsv'), '');
  if (readyRows) writeFileSync(join(dir, 'queue', 'ready.tsv'), readyRows(dir).join('\n'));
  return dir;
}

/** One unmet-dependency job and one whose only gate is already MERGED. */
const parkedRows = (dir: string) => [
  `PARKED-DEP.devin\tRQ-UNMET\tdevin\twork\tfake-repo\t${join(dir, 'queue', 'prompts', 'unmet.md')}`,
  `PARKED-DEP.devin\tRQ-MET\tdevin\twork\tfake-repo\t${join(dir, 'queue', 'prompts', 'met.md')}`,
];

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  const code = await cmdFleetQueueParked(args);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Every file's path and bytes under root, for proving reads never write. */
function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[path] = readFileSync(path).toString('base64');
    }
  };
  walk(root);
  return files;
}

describe('phm fleet queue-parked (read-only, --root only)', () => {
  it('JSON keeps unmet and all-met dependencies, source states and groups across the CLI boundary', async () => {
    const dir = seed(parkedRows);
    const { code, out, err } = await run(['--root', dir, '--json']);
    expect({ code, err }).toEqual({ code: 0, err: '' });
    const parsed = JSON.parse(out);
    expect(parsed.v).toBe(1);
    expect(typeof parsed.generatedAt).toBe('string');
    expect(parsed.snapshot).toBe('populated');
    expect(parsed.sources).toEqual({ ready: 'healthy', skips: 'healthy' });
    expect(parsed.unmetDeps).toEqual([{ job: 'RQ-UNMET', lane: 'devin', unmet: ['RQ-OPEN'] }]);
    expect(parsed.metDeps).toEqual([{ job: 'RQ-MET', lane: 'devin', gates: ['RQ-DONE'] }]);
    expect(parsed.groups).toEqual([expect.objectContaining({ reason: 'DEP', lane: 'devin', count: 2 })]);
  });

  it('text names blocked jobs and unmet gates, and labels all-met rows as evidence only', async () => {
    const dir = seed(parkedRows);
    const { code, out } = await run(['--root', dir]);
    expect(code).toBe(0);
    expect(out).toContain('BLOCKED RQ-UNMET (devin): unmet RQ-OPEN');
    expect(out).toContain('EVIDENCE-ONLY RQ-MET (devin): all gates MERGED RQ-DONE; not permission to launch or unpark');
    expect(out).toContain('parked DEP (devin): 2');
    expect(out).toContain('Read-only; no queue state changed.');
  });

  it('a healthy empty queue differs from an absent snapshot', async () => {
    const empty = seed(() => []);
    const absent = seed(null);
    const emptyRun = await run(['--root', empty, '--json']);
    const absentRun = await run(['--root', absent, '--json']);
    expect(emptyRun.code).toBe(0);
    expect(JSON.parse(emptyRun.out)).toMatchObject({ snapshot: 'empty', total: 0, sources: { ready: 'healthy' } });
    expect(absentRun.code).toBe(1);
    expect(JSON.parse(absentRun.out)).toMatchObject({ snapshot: 'absent', total: 0, sources: { ready: 'missing' } });
    expect((await run(['--root', empty])).out).toContain('Queue is empty');
    expect((await run(['--root', absent])).out).toContain('This is not an empty queue');
  });

  it('rejects unknown arguments, relative or missing roots and mutation options with usage failure before reading', async () => {
    const dir = seed(parkedRows);
    const cases = [
      ['--bogus'],
      ['--root', 'relative/runs'],
      ['--root'],
      ['--root', '--json'],
      ['--root', dir, '--json', '--json'],
      ['--root', dir, '--unpark'],
      ['--dispatch'],
      ['--root', dir, 'stray'],
    ];
    for (const args of cases) {
      const result = await run(args);
      expect(result.code, JSON.stringify(args)).toBe(2);
      expect(result.out, JSON.stringify(args)).toBe('');
      expect(result.err, JSON.stringify(args)).toContain('Usage: phm fleet queue-parked');
    }
    expect((await run(['--help'])).code).toBe(0);
  });

  it('never writes: fixture bytes and file set are unchanged after text and JSON reads', async () => {
    const dir = seed(parkedRows);
    const before = snapshotTree(dir);
    await run(['--root', dir]);
    await run(['--root', dir, '--json']);
    expect(snapshotTree(dir)).toEqual(before);
  });

  it('honors ASHLR_RUNS_DIR when --root is absent', async () => {
    const dir = seed(parkedRows);
    const previous = process.env.ASHLR_RUNS_DIR;
    try {
      process.env.ASHLR_RUNS_DIR = dir;
      const { code, out } = await run([]);
      expect(code).toBe(0);
      expect(out).toContain('BLOCKED RQ-UNMET (devin): unmet RQ-OPEN');
      expect(out).toContain('EVIDENCE-ONLY RQ-MET');
    } finally {
      if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
    }
  });
});
