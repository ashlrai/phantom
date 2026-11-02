import { describe, expect, it } from 'vitest';
import { cmdFleetRedBlame, parseTscErrors } from '../src/cli/fleet-red-blame.js';

const OUT = [
  'src/a.ts(12,5): error TS2322: Type string is not assignable to number.',
  'noise line',
  'src/b.ts(3,1): error TS2304: Cannot find name x.',
  'src/a.ts(40,2): error TS2345: Bad arg.',
].join('\n');
const state = (entry: unknown) => JSON.stringify({ 'ashlrai/phantom': entry });

async function run(args: string[], raw: string | null, git = (a: string[]) => `${'a'.repeat(40)}\nfix thing (#12)\n`) {
  const lines: string[] = []; const errs: string[] = []; const calls: string[][] = [];
  const code = await cmdFleetRedBlame(args, {
    output: { log: m => lines.push(m), error: m => errs.push(m) },
    readFile: () => { if (raw === null) throw new Error('ENOENT'); return raw; },
    git: a => { calls.push(a); return git(a); },
  });
  return { code, lines, errs, calls };
}

describe('fleet red-blame', () => {
  it('parses only compiler error lines', () => {
    expect(parseTscErrors(OUT).map(e => [e.file, e.line, e.col, e.code])).toEqual([
      ['src/a.ts', 12, 5, 'TS2322'], ['src/b.ts', 3, 1, 'TS2304'], ['src/a.ts', 40, 2, 'TS2345']]);
  });

  it('prints one plain line per error and asks git once per file', async () => {
    const r = await run([], state({ state: 'red', out: OUT }));
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toBe('src/a.ts(12,5) TS2322: Type string is not assignable to number. — last changed by aaaaaaaa (#12) "fix thing (#12)"');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0]).toEqual(['log', '-1', '--format=%H%n%s', '--', 'src/a.ts']);
  });

  it('emits json with sha, subject and pr', async () => {
    const r = await run(['--repo', 'phantom', '--json'], state({ out: OUT }));
    const rep = JSON.parse(r.lines[0]!);
    expect(rep.repo).toBe('ashlrai/phantom');
    expect(rep.errors[0]).toMatchObject({ file: 'src/a.ts', sha: 'a'.repeat(40), subject: 'fix thing (#12)', pr: 12 });
  });

  it('prints nothing for missing state, a green repo, or an unknown repo', async () => {
    for (const [args, raw] of [[[], null], [['--json'], null], [[], state({ state: 'green', out: '' })],
      [['--json'], state({ out: 'all good' })], [['--repo', 'other'], state({ out: OUT })], [[], 'not json']] as const) {
      const r = await run([...args], raw);
      expect(r.code).toBe(0); expect(r.lines).toEqual([]); expect(r.calls).toEqual([]);
    }
  });

  it('keeps the error when git fails or has no PR number', async () => {
    const bad = await run([], state({ out: OUT }), () => { throw new Error('x'); });
    expect(bad.lines[1]).toContain('no commit found');
    const noPr = await run(['--json'], state({ out: OUT }), () => 'abcdef1234\nplain subject\n');
    expect(JSON.parse(noPr.lines[0]!).errors[0].pr).toBeNull();
  });

  it('rejects bad arguments and answers --help', async () => {
    expect((await run(['--bogus'], null)).code).toBe(2);
    expect((await run(['--repo'], null)).code).toBe(2);
    expect((await run(['--json', '--json'], null)).code).toBe(2);
    expect((await run(['-h'], null)).lines[0]).toContain('usage:');
  });
});
