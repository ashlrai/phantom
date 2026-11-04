import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetPathBatch } from '../src/cli/fleet-path-batch.js';

async function run(input: string, args = ['--stdin', '--json'], log?: (path: string, limit: number) => Promise<Array<{ sha: string; date: string; subject: string }>>) {
  const lines: string[] = [], errors: string[] = [];
  const code = await cmdFleetPathBatch(args, { input: (async function* () { yield input; })(), log, output: line => lines.push(line), error: line => errors.push(line) });
  return { code, lines, errors };
}

describe('fleet path batch', () => {
  it('preserves order and passes special paths literally to the adapter', async () => {
    const seen: string[] = [];
    const result = await run(JSON.stringify({ paths: ['a space.ts', ':(glob)*.ts'] }), undefined, async (path, limit) => {
      seen.push(`${path}:${limit}`);
      return [{ sha: 'abc', date: 'today', subject: `bridge(RQ-1): ${path} (#12)` }];
    });
    expect(result.code).toBe(0);
    expect(seen).toEqual(['a space.ts:20', ':(glob)*.ts:20']);
    const parsed = JSON.parse(result.lines[0]!);
    expect(parsed.ref).toBe('origin/master');
    expect(parsed.results.map((r: { path: string }) => r.path)).toEqual(['a space.ts', ':(glob)*.ts']);
    expect(parsed.results[0].rows[0].pr).toBe(12);
  });
  it('rejects invalid input and flags before git', async () => {
    let calls = 0;
    const log = async () => { calls++; return []; };
    for (const input of ['{', '{"paths":[],"paths":["a"]}', '{"paths":["a"],"extra":1}', '{"paths":["a","a"]}', '{"paths":["../a"]}', JSON.stringify({ paths: ['é'.repeat(8000)] })]) {
      expect((await run(input, undefined, log)).code).toBe(2);
    }
    expect((await run('{"paths":["a"]}', ['--stdin', '--other'], log)).code).toBe(2);
    expect(calls).toBe(0);
  });
  it('keeps successful siblings when git fails and describes empty bounded results', async () => {
    const result = await run('{"paths":["bad","good"]}', ['--stdin'], async path => {
      if (path === 'bad') throw new Error('private stderr');
      return [];
    });
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('unable to read path history');
    expect(result.lines.join('\n')).toContain('No bridge jobs found in this bounded scan');
    expect(result.lines.join('\n')).not.toContain('private stderr');
  });
  it('reads real bridge commits through the shared parser using literal pathspecs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'path-batch-'));
    const previous = process.cwd();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.test');
      git('config', 'user.name', 'Test');
      writeFileSync(join(dir, 'a [1].ts'), 'x');
      git('add', '--', 'a [1].ts');
      git('commit', '-qm', 'bridge(RQ-EXAMPLE): Example (#42)');
      git('update-ref', 'refs/remotes/origin/master', 'HEAD');
      process.chdir(dir);
      const result = await run(JSON.stringify({ paths: ['a [1].ts', 'a ?.ts'] }));
      expect(result.code).toBe(0);
      const results = JSON.parse(result.lines[0]!).results;
      expect(results[0].rows[0]).toMatchObject({ jobId: 'RQ-EXAMPLE', pr: 42 });
      expect(results[1].rows).toEqual([]);
    } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
  });
});
