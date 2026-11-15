import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMerge,
  parseNumstatLog,
  scanEmptyMerges,
  type MergeCommit,
} from '../src/core/fleet/empty-merge-scan.js';
import { cmdFleetEmptyMerges } from '../src/cli/fleet-empty-merges.js';

afterEach(() => vi.restoreAllMocks());

const sha = (ch: string) => ch.repeat(40);
const NONE = new Map<string, number>();
const commit = (subject: string, files: MergeCommit['files'] = []): MergeCommit => ({ sha: sha('a'), subject, files });
const file = (path: string, added: number, deleted = 0, binary = false) => ({ path, added, deleted, binary });

/** The pinned stream: NUL sha TAB subject NUL LF, then NUL-terminated `a<TAB>d<TAB>path`. */
const record = (shaHex: string, subject: string, files: Array<[string, string, string]>) =>
  `\0${shaHex}\t${subject}\0\n${files.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join('')}`;

describe('parseNumstatLog', () => {
  it('parses commit headers and text/binary entries', () => {
    const text =
      record(sha('b'), 'bridge(RQ-PHX-A1): x (#1)', [['130', '0', 'src/cli/fleet-x.ts'], ['-', '-', 'assets/pic.png']]) +
      record(sha('c'), 'bridge(RQ-PHX-A2): (#2)', []) +
      record(sha('d'), 'docs: no files here', [['1', '1', 'docs/x.md']]);
    const commits = parseNumstatLog(text);
    expect(commits.map(c => c.sha)).toEqual([sha('b'), sha('c'), sha('d')]);
    expect(commits[0]).toMatchObject({ subject: 'bridge(RQ-PHX-A1): x (#1)' });
    expect(commits[0]!.files).toEqual([
      { path: 'src/cli/fleet-x.ts', added: 130, deleted: 0, binary: false },
      { path: 'assets/pic.png', added: 0, deleted: 0, binary: true },
    ]);
    expect(commits[1]!.files).toEqual([]);
    expect(parseNumstatLog('')).toEqual([]);
  });

  it('keeps the destination path of a -z rename entry', () => {
    const commits = parseNumstatLog(`\0${sha('e')}\tbridge(RQ-PHX-A3): (#3)\0\n0\t0\t\0old/name.ts\0new/name.ts\0`);
    expect(commits[0]!.files).toEqual([{ path: 'new/name.ts', added: 0, deleted: 0, binary: false }]);
  });
});

describe('classifyMerge', () => {
  const bridge = 'bridge(RQ-PHX-ORDERMIXEDLANES367S): (#5704)';

  it('marks a 0-byte add or a no-file commit empty', () => {
    expect(classifyMerge(commit(bridge, [file('test/order-state-mixed-lanes-367s.test.ts', 0, 0)]), NONE).verdict).toBe('empty');
    expect(classifyMerge(commit(bridge), NONE).verdict).toBe('empty');
    expect(classifyMerge(commit(bridge, [file('a.ts', 0, 0), file('b.ts', 0, 0)]), NONE).verdict).toBe('empty');
  });

  it('marks commits whose only content is evidence paths evidence-only', () => {
    const files = [file('.bridge-evidence/RQ-PHX-X/a.md', 8, 0), file('BRIDGE_NOTES.md', 4, 0), file('test/x.test.ts', 0, 0)];
    expect(classifyMerge(commit(bridge, files), NONE).verdict).toBe('evidence-only');
  });

  it('marks a commit with real content real', () => {
    const files = [file('.bridge-evidence/RQ-PHX-X/a.md', 8, 0), file('src/core/fleet/x.ts', 10, 2)];
    expect(classifyMerge(commit(bridge, files), NONE).verdict).toBe('real');
  });

  it('counts a binary of unknown size as real but a known 0-byte binary as unchanged', () => {
    const binary = commit(bridge, [file('assets/pic.png', 0, 0, true)]);
    expect(classifyMerge(binary, NONE).verdict).toBe('real');
    expect(classifyMerge(binary, new Map([['assets/pic.png', 0]])).verdict).toBe('empty');
  });

  it('extracts the RQ job id and reports files and subject', () => {
    const row = classifyMerge(commit('bridge(RQ-PHX-EMPTYMERGESVERB371): fleet empty-merges (#99)', [file('x', 1)]), NONE);
    expect(row).toMatchObject({ job: 'RQ-PHX-EMPTYMERGESVERB371', verdict: 'real', files: 1 });
    expect(classifyMerge(commit('bridge(not-a-job): (#1)'), NONE).job).toBeNull();
    expect(classifyMerge(commit('bridge(RQ-A-B9):'), NONE).job).toBe('RQ-A-B9');
  });
});

describe('scanEmptyMerges', () => {
  const captured: string[][] = [];
  const exec = (text: string) => (args: string[]) => { captured.push(args); return text; };

  it('skips non-bridge subjects and excludes real commits from rows', () => {
    const text =
      record(sha('1'), 'fix(thing): real work', [['5', '0', 'src/a.ts']]) +
      record(sha('2'), 'bridge(RQ-PHX-REAL1): (#1)', [['10', '0', 'src/a.ts']]) +
      record(sha('3'), 'bridge(RQ-PHX-EMPTY1): (#2)', [['0', '0', 'test/x.test.ts']]) +
      record(sha('4'), 'bridge(RQ-PHX-EVID1): (#3)', [['8', '0', '.bridge-evidence/RQ-X/a.md']]);
    const report = scanEmptyMerges({ exec: exec(text) });
    expect(report).toMatchObject({ v: 1, ref: 'origin/master', scanned: 3 });
    expect(report.source).toBeUndefined();
    expect(report.rows.map(row => [row.job, row.verdict, row.files])).toEqual([
      ['RQ-PHX-EMPTY1', 'empty', 1],
      ['RQ-PHX-EVID1', 'evidence-only', 1],
    ]);
    expect(captured[0]).toEqual(expect.arrayContaining(['log', '--numstat', '-z', '-n50', 'origin/master']));
  });

  it('honors ref and limit, clamping the limit to 500', () => {
    scanEmptyMerges({ exec: exec(''), ref: 'origin/release', limit: 9999 });
    expect(captured.at(-1)).toContain('-n500');
    expect(captured.at(-1)).toContain('origin/release');
    scanEmptyMerges({ exec: exec(''), limit: 7 });
    expect(captured.at(-1)).toContain('-n7');
  });

  it('reports an unavailable source with no error text or path', () => {
    const report = scanEmptyMerges({ exec: () => { throw new Error('fatal: /private/path bad revision'); } });
    expect(report).toMatchObject({ v: 1, scanned: 0, rows: [], source: 'unavailable' });
    expect(JSON.stringify(report)).not.toContain('fatal');
    expect(JSON.stringify(report)).not.toContain('/private/path');
  });
});

describe('ashlr fleet empty-merges', () => {
  const EMPTY_ROW = record(sha('a'), 'bridge(RQ-PHX-EMPTY1): (#2)', [['0', '0', 'test/x.test.ts']]);

  async function run(args: string[], exec?: (a: string[]) => string) {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await cmdFleetEmptyMerges(args, { exec });
    return { code, out: out.mock.calls.map(c => String(c[0])), err: err.mock.calls.map(c => String(c[0])) };
  }

  it('rejects bad --ref and --limit with exit 2', async () => {
    for (const args of [
      ['--ref', 'has space'], ['--ref', '-x'], ['--ref', ''],
      ['--limit', '0'], ['--limit', '501'], ['--limit', 'abc'], ['--limit'],
      ['--bogus'], ['extra'], ['--ref', 'ok-ref', '--ref', 'twice'],
    ]) {
      const { code, err } = await run(args, () => EMPTY_ROW);
      expect(code, args.join(' ')).toBe(2);
      expect(err[0]).toContain('Usage: ashlr fleet empty-merges');
    }
  });

  it('prints the JSON shape and text rows', async () => {
    const json = await run(['--json', '--ref', 'origin/master', '--limit', '5'], () => EMPTY_ROW);
    expect(json.code).toBe(1);
    const report = JSON.parse(json.out[0]!);
    expect(report).toMatchObject({ v: 1, ref: 'origin/master', scanned: 1 });
    expect(report.rows[0]).toMatchObject({
      sha: sha('a'), subject: 'bridge(RQ-PHX-EMPTY1): (#2)', job: 'RQ-PHX-EMPTY1', verdict: 'empty', files: 1,
    });
    const text = await run([], () => EMPTY_ROW);
    expect(text.code).toBe(1);
    expect(text.out[0]).toBe(`${'a'.repeat(7)} RQ-PHX-EMPTY1 empty files=1`);
    expect(text.out[1]).toContain('1 bridge merge with no real change');
  });

  it('exits 0 with no rows and 1 when the source is unavailable', async () => {
    expect((await run([], () => record(sha('b'), 'bridge(RQ-PHX-REAL1): (#1)', [['3', '0', 'src/a.ts']]))).code).toBe(0);
    const gone = await run([], () => { throw new Error('no git'); });
    expect(gone.code).toBe(1);
    expect(gone.out[0]).toContain('unavailable');
    const goneJson = await run(['--json'], () => { throw new Error('no git'); });
    expect(JSON.parse(goneJson.out[0]!)).toMatchObject({ source: 'unavailable', scanned: 0, rows: [] });
  });

  it('prints usage on --help and never runs the scan', async () => {
    const exec = vi.fn(() => EMPTY_ROW);
    const { code, out } = await run(['--help'], exec);
    expect(code).toBe(0);
    expect(out[0]).toContain('Usage: ashlr fleet empty-merges');
    expect(exec).not.toHaveBeenCalled();
  });
});
