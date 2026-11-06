import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { runJobSnapshot } from '../examples/agents/job-snapshot.js';

let scratch: string;
let runs: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'job-snapshot-'));
  runs = join(scratch, '.ashlr-runs');
  await mkdir(runs);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function run(args: string[]) {
  let output = '';
  const code = await runJobSnapshot(args, {
    read: job => getFleetJobDetail(job, { runsDir: runs }),
    write: text => { output += text; },
  });
  return { code, output };
}

describe('job snapshot', () => {
  it('returns the desktop projection with provenance and a bounded, scrubbed tail', async () => {
    await writeFile(join(runs, 'JOB1.launch'), 'launched JOB1 worker pid 42 base abc1234\n');
    await writeFile(join(runs, 'JOB1.base'), 'abc1234 branch-name /fake/private/worktree\n');
    await writeFile(join(runs, 'JOB1.base.meta'), 'MODEL worker work fake-model\n');
    await writeFile(join(runs, 'JOB1.prompt'), 'PRIVATE-PROMPT-CONTENTS');
    await writeFile(join(runs, 'JOB1.log'), `${Array.from({ length: 140 }, (_, i) => `line ${i}`).join('\n')}\nAuthorization: Bearer fake-value\n`);
    const { code, output } = await run(['--job', 'JOB1']);
    const detail = JSON.parse(output);
    expect(code).toBe(0);
    expect(detail).toMatchObject({ schema: 'fleet.job.v1', job: 'JOB1', lane: 'worker', tier: 'work', model: 'fake-model', branch: 'branch-name', sources: { publish: 'missing', log: 'healthy' } });
    expect(detail.log.tail).toHaveLength(120);
    expect(detail.log.truncated).toBe(true);
    expect(detail.log.tail.at(-1)).toBe('[redacted line]');
    expect(output).not.toContain('fake-value');
    expect(output).not.toContain('PRIVATE-PROMPT-CONTENTS');
    expect(output).not.toContain('/fake/private/worktree');
  });

  it('reports absent evidence while retaining the projection', async () => {
    const { code, output } = await run(['--job', 'JOB2']);
    expect(code).toBe(3);
    expect(JSON.parse(output)).toMatchObject({ schema: 'fleet.job.v1', job: 'JOB2', state: 'unknown', sources: { log: 'missing' } });
  });

  it('recognizes prompt and notes as evidence even without tracked sources', async () => {
    await writeFile(join(runs, 'JOB3.prompt'), 'fake prompt');
    await writeFile(join(runs, 'JOB4.notes.md'), 'fake notes');
    expect((await run(['--job', 'JOB3'])).code).toBe(0);
    expect((await run(['--job', 'JOB4'])).code).toBe(0);
  });

  it('reports degraded sources and never follows a log symlink', async () => {
    const outside = join(scratch, 'outside');
    await writeFile(outside, 'PRIVATE-OUTSIDE-CONTENT');
    await symlink(outside, join(runs, 'JOB5.log'));
    const { code, output } = await run(['--job', 'JOB5']);
    expect(code).toBe(4);
    expect(JSON.parse(output)).toMatchObject({ sources: { log: 'degraded' }, log: { tail: [] } });
    expect(output).not.toContain('PRIVATE-OUTSIDE-CONTENT');
  });

  it('rejects malformed or extra arguments without calling the reader', async () => {
    const read = vi.fn();
    for (const args of [[], ['--job'], ['--job', '../bad'], ['--job', 'JOB1', '--runs-dir', '/tmp'], ['--help', '--job', 'JOB1'], ['--job', 'JOB1\n']]) {
      let output = '';
      expect(await runJobSnapshot(args, { read, write: text => { output += text; } })).toBe(2);
      expect(JSON.parse(output)).toHaveProperty('error');
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('returns a generic error if the reader throws', async () => {
    let output = '';
    const code = await runJobSnapshot(['--job', 'JOB1'], {
      read: async () => { throw new Error('PRIVATE-ERROR-DETAIL'); },
      write: text => { output += text; },
    });
    expect(code).toBe(1);
    expect(JSON.parse(output)).toHaveProperty('error');
    expect(output).not.toContain('PRIVATE-ERROR-DETAIL');
  });

  it('runs directly with the default home and exposes help without running on import', async () => {
    await writeFile(join(runs, 'JOB6.log'), 'hello from worker\n');
    const tsx = resolve('node_modules/tsx/dist/cli.mjs');
    const script = resolve('examples/agents/job-snapshot.ts');
    const env = { HOME: scratch, PATH: process.env.PATH };
    const result = spawnSync(process.execPath, [tsx, script, '--job', 'JOB6'], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ job: 'JOB6', log: { tail: ['hello from worker'] } });
    expect(execFileSync(process.execPath, [tsx, script, '--help'], { encoding: 'utf8', env })).toContain('--job ID');
    const imported = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import ${JSON.stringify(script)}`], { encoding: 'utf8', env });
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('');
  }, 30_000);
});
