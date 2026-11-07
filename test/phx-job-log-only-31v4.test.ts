import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';

let home: string;
let runs: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'fleet-job-log-'));
  runs = join(home, '.ashlr-runs');
  await mkdir(runs);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

// Exercise the public source CLI and its actual streams in an isolated home.
function cli(...args: string[]) {
  return spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/cli/index.ts'), 'fleet', 'job', ...args], {
    encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, timeout: 30_000,
  });
}

describe('fleet job log-only executable contract', () => {
  it('prints only the scrubbed bounded live tail on stdout and status on stderr', async () => {
    await writeFile(join(runs, 'JOB1.launch'), 'launched JOB1 worker pid 42 base abc1234\n');
    await writeFile(join(runs, 'JOB1.base.meta'), 'MODEL worker work fake-model\n');
    await writeFile(join(runs, 'JOB1.log'), `${Array.from({ length: 140 }, (_, i) => `line ${i}`).join('\n')}\nAuthorization: Bearer fake-value\n`);
    const result = cli('JOB1', '--log');
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(120);
    expect(lines[0]).toBe('line 21');
    expect(lines.at(-1)).toBe('[redacted line]');
    expect(result.stdout).not.toContain('fake-value');
    expect(result.stdout).not.toContain('fake-model');
    expect(result.stderr).toBe('Log: live; health: healthy; truncated: yes\n');
  }, 30_000);

  it('returns a versioned log-only JSON projection for an archive', async () => {
    await writeFile(join(runs, 'JOB2.log.gz'), gzipSync('archived line\napi_key=fake-value\n'));
    await writeFile(join(runs, 'JOB2.base.meta'), 'MODEL worker work fake-model\n');
    const result = cli('JOB2', '--json', '--log');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      schema: 'fleet.job.log.v1', job: 'JOB2', generatedAt: expect.any(String),
      log: { source: 'archived', bytes: expect.any(Number), tail: ['archived line', '[redacted line]'], truncated: false },
      sources: { log: 'healthy' },
    });
    expect(result.stdout).not.toContain('fake-value');
    expect(result.stdout).not.toContain('fake-model');
  }, 30_000);

  it('distinguishes missing and degraded sources without reading through a symlink', async () => {
    const missing = cli('JOB3', '--log', '--json');
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ log: { source: 'missing', bytes: null, tail: [], truncated: false }, sources: { log: 'missing' } });
    expect(missing.stderr).toBe('');
    const outside = join(home, 'outside');
    await writeFile(outside, 'fake outside content\n');
    await symlink(outside, join(runs, 'JOB4.log'));
    const degraded = cli('JOB4', '--log');
    expect(degraded.status).toBe(0);
    expect(degraded.stdout).toBe('');
    expect(degraded.stderr).toBe('Log: missing; health: degraded; truncated: no\n');
  }, 30_000);

  it('rejects conflicting and duplicate flags even with help', () => {
    for (const args of [['JOB1', '--log', '--changes'], ['--help', '--changes', '--log'], ['JOB1', '--log', '--log']]) {
      const result = cli(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('invalid fleet job arguments');
    }
    const help = cli('--help');
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--log');
  }, 30_000);

  it('calls detail once and never calls the changes reader for log output or invalid combinations', async () => {
    const detail = vi.fn((id: string) => getFleetJobDetail(id, { runsDir: runs, now: () => new Date('2026-10-30T12:00:00.000Z') }));
    const changes = vi.fn<typeof getFleetJobChanges>();
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetJobRead(['JOB1', '--log', '--json'], { detail, changes })).toBe(0);
    expect(detail).toHaveBeenCalledExactlyOnceWith('JOB1');
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      schema: 'fleet.job.log.v1', job: 'JOB1', generatedAt: '2026-10-30T12:00:00.000Z',
      log: { source: 'missing', bytes: null, tail: [], truncated: false }, sources: { log: 'missing' },
    });
    expect(await cmdFleetJobRead(['JOB1', '--log', '--changes'], { detail, changes })).toBe(2);
    expect(detail).toHaveBeenCalledTimes(1);
    expect(changes).not.toHaveBeenCalled();
  });
});
