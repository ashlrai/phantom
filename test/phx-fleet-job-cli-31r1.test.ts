import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

let home: string;
let runs: string;
let output: string[];
let errors: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-job-cli-'));
  runs = join(home, '.ashlr-runs');
  await mkdir(runs);
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(home, { recursive: true, force: true }); });

async function fixture() {
  await writeFile(join(runs, 'JOB1.launch'), 'launched JOB1 main pid 123 base abcdef0\n');
  await writeFile(join(runs, 'JOB1.base.meta'), 'MODEL main work fake-model\n');
  await writeFile(join(runs, 'JOB1.log'), 'working on fake fixture\n');
}

describe('fleet job CLI', () => {
  it('routes help and actual host artifacts through fleet with no API token', async () => {
    await fixture();
    vi.stubEnv('HOME', home);
    expect(await cmdFleet(['--help'])).toBe(0);
    expect(output.join('\n')).toContain('phm fleet job <id> [--json] [--changes]');
    output = [];
    expect(await cmdFleet(['job', '--help'])).toBe(0);
    expect(output.join('\n')).toContain('Usage: phm fleet job <id>');
    output = [];
    expect(await cmdFleet(['job', 'JOB1', '--json'])).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ schema: 'fleet.job.v1', job: 'JOB1', state: 'running', lane: 'main', tier: 'work', model: 'fake-model', pid: 123, log: { tail: ['working on fake fixture'] }, sources: { launch: 'healthy', log: 'healthy', publish: 'missing' } });
    expect(errors).toBe('');
  });

  it('prints useful detail and makes missing evidence and inferred state explicit', async () => {
    await fixture();
    const deps = { detail: (id: string) => getFleetJobDetail(id, { runsDir: runs }), changes: getFleetJobChanges };
    expect(await cmdFleetJobRead(['JOB1'], deps)).toBe(0);
    expect(output.join('\n')).toContain('artifact evidence; process liveness not checked');
    expect(output.join('\n')).toContain('working on fake fixture');
    output = [];
    expect(await cmdFleetJobRead(['ABSENT', '--json'], deps)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ schema: 'fleet.job.v1', state: 'unknown', sources: { launch: 'missing', log: 'missing' } });
    output = [];
    expect(await cmdFleetJobRead(['ABSENT'], deps)).toBe(0);
    expect(output.join('\n')).toContain('launch=missing');
    expect(output.join('\n')).toContain('Log: missing');
  });

  it('returns the existing changes projection using an injected Git runner', async () => {
    const worktree = join(home, 'worktree');
    await mkdir(worktree);
    await writeFile(join(runs, 'JOB1.base'), `abcdef0 branch ${worktree}\n`);
    const runner = vi.fn<GitRunner>(async (_bin, args) => ({ code: 0, stdout: args[0] === 'diff' ? '3\t1\tfile.ts\0' : '? new.txt\0', stderr: '', timedOut: false, truncated: false, missing: false }));
    const deps = { detail: getFleetJobDetail, changes: (id: string) => getFleetJobChanges(id, { runsDir: runs, homeDir: home, runner }) };
    expect(await cmdFleetJobRead(['JOB1', '--changes', '--json'], deps)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ schema: 'fleet.job.changes.v1', job: 'JOB1', state: 'live', files: [{ path: 'file.ts', status: 'modified', added: 3, removed: 1 }, { path: 'new.txt', status: 'untracked' }], totals: { files: 2, added: 3, removed: 1 } });
    expect(output[0]).not.toContain(home);
    expect(runner).toHaveBeenCalledTimes(2);
    output = [];
    expect(await cmdFleetJobRead(['JOB1', '--changes'], deps)).toBe(0);
    expect(output.join('\n')).toContain('modified file.ts (+3 -1)');
    output = [];
    expect(await cmdFleetJobRead(['ABSENT', '--changes'], deps)).toBe(0);
    expect(output.join('\n')).toContain('Worktree evidence unavailable.');
  });

  it('rejects invalid IDs, options and duplicate flags before reading, including with help', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const changes = vi.fn<typeof getFleetJobChanges>();
    for (const args of [[], ['../bad'], ['JOB1\n'], ['ab'], ['JOB1', 'JOB2'], ['JOB1', '--bad'], ['JOB1', '--json', '--json'], ['JOB1', '--changes', '--changes'], ['--help', '-h'], ['--help', '../bad'], ['JOB1', '--path', '/tmp']]) {
      expect(await cmdFleetJobRead(args, { detail, changes })).toBe(2);
    }
    expect(detail).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(errors).toContain('invalid fleet job arguments');
  });

  it('routes through fleet before generic help and hides reader errors', async () => {
    expect(await cmdFleet(['job', '--help'])).toBe(0);
    expect(output.join('\n')).toContain('Usage: phm fleet job <id>');
    expect(await cmdFleet(['job', '--help', '--bad'])).toBe(2);
    const fail = async () => { throw new Error('/fake/private'); };
    expect(await cmdFleetJobRead(['JOB1', '--json'], { detail: fail, changes: fail })).toBe(1);
    expect(await cmdFleetJobRead(['JOB1', '--changes'], { detail: fail, changes: fail })).toBe(1);
    expect(errors).toContain('error: fleet job unavailable');
    expect(errors).not.toContain('/fake/private');
  });
});
