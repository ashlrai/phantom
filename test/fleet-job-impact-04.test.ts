import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetJobImpact } from '../src/cli/fleet-job-impact.js';

const sha = 'a'.repeat(40);

describe('fleet job-impact', () => {
  it('pins the ref, deduplicates paths and unions shared jobs in first-seen order', async () => {
    const calls: string[][] = [], output: string[] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return sha;
      return `${sha}\t2026-01-01\tbridge(RQ-SHARED): shared (#12)\n${sha}\t2026-01-01\tbridge(RQ-${args.at(-1) === 'a' ? 'A' : 'B'}): work\n`;
    };
    expect(await cmdFleetJobImpact(['a', 'b', 'a', '--limit', '2', '--json'], { git, output: s => output.push(s) })).toBe(0);
    const result = JSON.parse(output[0]!);
    expect(result.results.map((r: { rows: unknown[] }) => r.rows.length)).toEqual([2, 2]);
    expect(result.jobIds).toEqual(['RQ-SHARED', 'RQ-A', 'RQ-B']);
    expect(result.resolvedRef).toBe(sha);
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).every(args => args.includes(sha) && args.includes('-n6') && !args.includes('origin/master'))).toBe(true);
  });

  it('warns even when there are no matches', async () => {
    const output: string[] = [];
    expect(await cmdFleetJobImpact(['a', '--json'], { git: async args => args[0] === 'rev-parse' ? sha : '', output: s => output.push(s) })).toBe(0);
    expect(JSON.parse(output[0]!).warning).toMatch(/evidence, not proof/);
    expect(JSON.parse(output[0]!).jobIds).toEqual([]);
  });

  it('rejects invalid input without running git', async () => {
    for (const args of [[], ['../a'], ['/a'], ['a', '--ref', 'bad..ref'], ['a', '--limit', '21'], ['a', '--json', '--json'], ['a', '--oops'], Array.from({ length: 21 }, (_, i) => `f${i}`)]) {
      let called = false;
      expect(await cmdFleetJobImpact(args, { git: async () => { called = true; return ''; }, error: () => {} })).toBe(2);
      expect(called).toBe(false);
    }
  });

  it('fails without reporting an empty result when git fails', async () => {
    const output: string[] = [], errors: string[] = [];
    expect(await cmdFleetJobImpact(['a'], { git: async args => { if (args[0] === 'rev-parse') return sha; throw new Error('failed'); }, output: s => output.push(s), error: s => errors.push(s) })).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('reads bridge identities from a real local git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'impact-'));
    const cwd = process.cwd();
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    try {
      run('init');
      run('config', 'user.name', 'Fixture');
      run('config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(dir, 'a'), 'one');
      run('add', 'a'); run('commit', '-m', 'bridge(RQ-FIRST): first (#1)');
      writeFileSync(join(dir, 'a'), 'two');
      run('add', 'a'); run('commit', '-m', 'bridge(RQ-SECOND): second (#2)');
      process.chdir(dir);
      const output: string[] = [];
      expect(await cmdFleetJobImpact(['a', '--ref', 'HEAD', '--json'], { output: s => output.push(s) })).toBe(0);
      expect(JSON.parse(output[0]!).jobIds).toEqual(['RQ-SECOND', 'RQ-FIRST']);
    } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
  });
});
