import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runQueueBlockers } from '../examples/agents/queue-blockers.js';
import { readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const dirs: string[] = [];
const execFileAsync = promisify(execFile);

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'queue-blockers-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  return dir;
}

async function run(dir: string, args: string[] = []) {
  let output = '';
  let error = '';
  const code = await runQueueBlockers(args, {
    readQueue: () => readFleetQueue({ runsDir: dir }),
    stdout: (text) => { output += text; },
    stderr: (text) => { error += text; },
  });
  return { code, output, error };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('queue blockers example', () => {
  it('reports ranked mixed legacy rows and original health, including malformed rows', async () => {
    const dir = await fixture();
    const ready = [
      'READY\tJOB-READY\talpha',
      'PARKED-HOLD.alpha\tJOB-B\talpha',
      'status=PARKED-HOLD.alpha\tid=JOB-A\tpool=alpha',
      'PARKED-OTHER.beta\tJOB-C\tbeta',
      'READY\tbad/id\talpha',
    ].join('\n');
    await writeFile(join(dir, 'queue/ready.tsv'), ready);
    await writeFile(join(dir, 'queue/precheck-skips.tsv'), '');
    const result = await run(dir);
    expect(result.code).toBe(1);
    expect(result.error).toBe('');
    expect(JSON.parse(result.output)).toMatchObject({
      sources: { ready: 'degraded', skips: 'healthy' }, total: 4, ready: 1, parked: 3, malformed: 1,
      groups: [
        { reason: 'HOLD', lane: 'alpha', count: 2, jobs: ['JOB-A', 'JOB-B'] },
        { reason: 'OTHER', lane: 'beta', count: 1, jobs: ['JOB-C'] },
      ],
    });
    expect(await readFile(join(dir, 'queue/ready.tsv'), 'utf8')).toBe(ready);
    const filtered = JSON.parse((await run(dir, ['--lane', 'beta'])).output);
    expect(filtered).toMatchObject({ total: 4, malformed: 1, sources: { ready: 'degraded', skips: 'healthy' }, groups: [{ reason: 'OTHER', lane: 'beta' }] });
    expect(JSON.parse((await run(dir, ['--lane', 'Beta'])).output).groups).toEqual([]);
  });

  it('exposes the reader job ID cap and full group count', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'queue/ready.tsv'), Array.from({ length: 10 }, (_, i) => `PARKED-HOLD.alpha\tJOB-${i}\talpha`).join('\n'));
    await writeFile(join(dir, 'queue/precheck-skips.tsv'), '');
    const result = await run(dir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.output).groups[0]).toEqual({ reason: 'HOLD', lane: 'alpha', count: 10, jobs: Array.from({ length: 8 }, (_, i) => `JOB-${i}`) });
    expect((await run(dir, ['--lane', 'unknown'])).code).toBe(0);
    expect(JSON.parse((await run(dir, ['--lane', 'unknown'])).output).groups).toEqual([]);
  });

  it('distinguishes missing and unsafe sources from an empty healthy queue', async () => {
    const dir = await fixture();
    const missing = await run(dir);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.output)).toMatchObject({ sources: { ready: 'missing', skips: 'missing' }, total: 0, malformed: 0 });
    await writeFile(join(dir, 'outside'), 'READY\tJOB-X\talpha');
    await symlink(join(dir, 'outside'), join(dir, 'queue/ready.tsv'));
    await writeFile(join(dir, 'queue/precheck-skips.tsv'), '');
    const unsafe = await run(dir);
    expect(unsafe.code).toBe(1);
    expect(JSON.parse(unsafe.output)).toMatchObject({ sources: { ready: 'degraded', skips: 'healthy' }, total: 0 });
  });

  it('rejects invalid arguments without reading and handles unexpected reader errors', async () => {
    let reads = 0;
    let errors = '';
    const deps = { readQueue: async () => { reads++; throw new Error('private detail'); }, stderr: (text: string) => { errors += text; } };
    for (const args of [['--lane'], ['--lane', ''], ['--unknown'], ['--lane', '--other'], ['--lane', 'a', 'extra']]) {
      expect(await runQueueBlockers(args, deps)).toBe(2);
    }
    expect(reads).toBe(0);
    expect(errors).toContain('Usage:');
    errors = '';
    expect(await runQueueBlockers([], deps)).toBe(1);
    expect(errors).toBe('Unable to read the fleet queue.\n');
  });

  it('runs directly with an isolated home and prints a healthy empty queue', async () => {
    const home = await mkdtemp(join(tmpdir(), 'queue-blockers-home-'));
    dirs.push(home);
    await mkdir(join(home, '.ashlr-runs/queue'), { recursive: true });
    await writeFile(join(home, '.ashlr-runs/queue/ready.tsv'), '');
    await writeFile(join(home, '.ashlr-runs/queue/precheck-skips.tsv'), '');
    const result = await execFileAsync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'examples/agents/queue-blockers.ts', '--lane', 'unknown'], { env: { HOME: home, PATH: process.env.PATH } });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ sources: { ready: 'healthy', skips: 'healthy' }, total: 0, malformed: 0, groups: [] });
  }, 20_000);
});
