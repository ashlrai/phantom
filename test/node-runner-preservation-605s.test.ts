import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const runner = resolve('contrib/mac/node-runner.mjs');
let home: string;
const resultPath = () => join(home, '.ashlr-runs', 'node-results');
const env = () => ({ HOME: home, ASHLR_HOME: join(home, '.ashlr'), PATH: '/usr/bin:/bin' });
function child(args: string[], input?: string) {
  const result = spawnSync(process.execPath, args, { env: env(), input, encoding: 'utf8', timeout: 8000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return result;
}
function request(id: string, pack = 'shell-check', extra = {}) {
  return JSON.stringify({ protocol: 'phm-node-worker/v1', job: { id, pack, secrets: [], ...extra } });
}
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'node-preservation-'))); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('standalone node runner preservation', () => {
  it('imports without running or creating state', () => {
    const result = child(['--input-type=module', '-e', `await import(${JSON.stringify(runner)})`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(home, '.ashlr-runs'))).toBe(false);
  });
  it('publishes a private exclusive shell-check receipt', () => {
    const first = child([runner, 'run'], request('synthetic-job'));
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ resultRef: 'node-results:synthetic-job' });
    const file = join(resultPath(), 'synthetic-job.json');
    const original = readFileSync(file, 'utf8');
    expect(JSON.parse(original)).toEqual({ schemaVersion: 1, jobId: 'synthetic-job', pack: 'shell-check', completedAt: expect.any(String), result: { 'shell-check': 'ok' } });
    expect(statSync(resultPath()).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const repeat = child([runner, 'run'], request('synthetic-job'));
    expect(repeat.status).toBe(1);
    expect(JSON.parse(repeat.stdout).packError).toBe('result-write-failed');
    expect(readFileSync(file, 'utf8')).toBe(original);
  });
  it('rejects malformed requests without receipts', () => {
    for (const input of ['{', request('job', 'unknown'), request('job', 'shell-check', { secrets: ['synthetic'] }),
      request('../escape'), request('ready:task:1', 'codex-file', { task: { text: 'synthetic', sha256: '0'.repeat(64) } })]) {
      const result = child([runner, 'run'], input);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ codex: 'error', packError: 'invalid-request' });
      expect(existsSync(resultPath())).toBe(false);
    }
  });
  it('keeps long keys and attempts distinct and codex invocation confined', async () => {
    const { deriveJobDirectoryId, codexFileArgv } = await import('../contrib/mac/node-runner.mjs');
    const key = 'k'.repeat(199);
    const ids = [deriveJobDirectoryId(key, '1'), deriveJobDirectoryId(key, '2'), deriveJobDirectoryId(`${key}x`, '1')];
    expect(new Set(ids).size).toBe(3);
    expect(deriveJobDirectoryId(key, '1')).toBe(ids[0]);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/);
    expect(codexFileArgv('/synthetic')).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', '/synthetic', '-']);
    expect(readFileSync(runner, 'utf8')).toMatch(/spawn\(binary, codexFileArgv\(scratch\), \{ cwd: scratch, shell: false/);
  });
});
