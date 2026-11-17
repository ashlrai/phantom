import { spawnSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexFileArgv, nodeWorkDir } from '../src/core/drive/nodes/codex-pack.js';
import { providerBinaryCandidates, resolveProviderBinary } from '../src/core/drive/nodes/provider-binary.js';

const runner = resolve('contrib/mac/node-runner.mjs');
let home: string;
const path = (...parts: string[]) => join(home, '.ashlr-runs', ...parts);
function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [runner, ...args], { env: { HOME: home, PATH: '/usr/bin:/bin' }, input, encoding: 'utf8', timeout: 8000 });
}
function task(id = 'job', text = 'private task\n') { writeFileSync(path('node-tasks', `${id}.txt`), text); }
function fake(mode = 'ok') {
  writeFileSync(join(home, '.local/bin/codex'), `#!/bin/sh\npwd > "$HOME/cwd"\nprintf '%s\\n' "$@" > "$HOME/args"\ncat > "$HOME/input"\n${mode === 'fail' ? 'exit 7' : "printf 'review output'"}\n`, { mode: 0o755 });
}
function reply(args: string[], input?: string) {
  const result = run(args, input);
  expect(result.stderr).toBe('');
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(4096);
  return { ...result, value: JSON.parse(result.stdout) };
}
function request(id: string, pack = 'codex-file', extra = {}) {
  return JSON.stringify({ protocol: 'phm-node-worker/v1', job: { id, pack, secrets: [] }, ...extra });
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'standalone-runner-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  mkdirSync(path(), { mode: 0o700 });
  mkdirSync(path('node-tasks'), { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('standalone node runner', () => {
  it('probes allowlisted codex, never PATH, and advertises shell-check', () => {
    const outsideHome = providerBinaryCandidates('codex', { home }).filter(p => !p.startsWith(home + '/'));
    const real = resolveProviderBinary('codex', { home, executable: p => outsideHome.includes(p) && existsSync(p) });
    if (!real) expect(reply(['packs']).value.packs).not.toContain('codex-file');
    fake();
    expect(resolveProviderBinary('codex', { home })).toBeTruthy();
    expect(reply(['packs']).value).toMatchObject({ protocol: 'phm-node-worker/v1', packs: expect.arrayContaining(['shell-check', 'codex-file']) });
    const source = readFileSync(runner, 'utf8');
    const parity = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { providerBinaryCandidates, codexFileArgv } from ${JSON.stringify(runner)}; console.log(JSON.stringify({ candidates: providerBinaryCandidates(), argv: codexFileArgv('/scratch') }));`],
    { env: { HOME: home }, encoding: 'utf8' });
    expect(JSON.parse(parity.stdout)).toEqual({ candidates: providerBinaryCandidates('codex', { home }), argv: codexFileArgv('/scratch') });
    expect(source).not.toContain('process.env.PATH.split');
  });
  it('runs codex with TS-parity argv, stdin and cwd; publishes private immutable output', () => {
    fake(); task();
    const result = reply(['codex-file', 'job']);
    expect(result.status).toBe(0);
    expect(result.value).toEqual({ resultRef: 'node-results:job', codex: 'ok' });
    const scratch = nodeWorkDir('job', home);
    expect(readFileSync(join(home, 'cwd'), 'utf8').trim()).toBe(scratch);
    expect(readFileSync(join(home, 'args'), 'utf8').trim().split('\n')).toEqual(codexFileArgv(scratch));
    expect(readFileSync(join(home, 'input'), 'utf8')).toBe('private task\n');
    expect(existsSync(scratch)).toBe(false);
    expect(statSync(path('node-work')).mode & 0o777).toBe(0o700);
    expect(statSync(path('node-results/job.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path('node-results/job.json'), 'utf8'))).toEqual({ schemaVersion: 1, jobId: 'job', pack: 'codex-file', completedAt: expect.any(String), result: { codex: 'ok', output: 'review output' } });
    expect(reply(['codex-file', 'job']).value.packError).toBe('result-write-failed');
  });
  it('fails closed on codex failure and removes scratch without publishing', () => {
    fake('fail'); task();
    const result = reply(['codex-file', 'job']);
    expect(result.status).toBe(1);
    expect(result.value).toEqual({ codex: 'error', packError: 'codex-exit-nonzero' });
    expect(existsSync(path('node-results/job.json'))).toBe(false);
    expect(existsSync(path('node-work/job'))).toBe(false);
  });
  it.each(['../x', 'a/b', '', 'x'.repeat(121)])('rejects invalid ids with TS JOB_DIR parity: %s', id => {
    expect(() => nodeWorkDir(id, home)).toThrow();
    expect(reply(['codex-file', id]).value.packError).toBe('invalid-request');
  });
  it.each([undefined, '', ' '.repeat(12), 'x'.repeat(16385)])('rejects unavailable, empty and oversized tasks', text => {
    if (text !== undefined) task('job', text);
    expect(reply(['codex-file', 'job']).value.packError).toBe('task-unavailable');
  });
  it('refuses task symlinks and non-executable codex', () => {
    fake(); task('other'); symlinkSync(path('node-tasks/other.txt'), path('node-tasks/job.txt'));
    expect(reply(['codex-file', 'job']).value.packError).toBe('task-unavailable');
    chmodSync(join(home, '.local/bin/codex'), 0o600);
    expect(resolveProviderBinary('codex', { home })).not.toBe(join(home, '.local/bin/codex'));
  });
  it('maps bridged ids to task key and distinct scratch/result key', () => {
    fake();
    const text = 'embedded review task\n';
    const result = reply(['run'], JSON.stringify({ protocol: 'phm-node-worker/v1',
      job: { id: 'ready:job:2', pack: 'codex-file', secrets: [], task: { text, sha256: createHash('sha256').update(text).digest('hex') } },
      claim: { jobId: 'ready:job:2' } }));
    expect(result.status).toBe(0);
    expect(result.value.resultRef).toBe('node-results:job.2');
    expect(readFileSync(join(home, 'cwd'), 'utf8').trim()).toBe(nodeWorkDir('job.2', home));
    expect(existsSync(path('node-work/job.2'))).toBe(false);
    expect(existsSync(path('node-tasks/job.txt'))).toBe(false);
    expect(readFileSync(join(home, 'input'), 'utf8')).toBe(text);
    expect(existsSync(path('node-results/job.2.json'))).toBe(true);
  });
  it('rejects missing, oversized, malformed and stale embedded tasks before codex', () => {
    fake(); task();
    const make = (text: string) => ({ text, sha256: createHash('sha256').update(text).digest('hex') });
    for (const [task, claim] of [[undefined, undefined], [make('x'.repeat(16385)), undefined],
      [make('\ud800'), undefined], [{ ...make('review'), sha256: '0'.repeat(64) }, undefined],
      [make('review'), { jobId: 'ready:job:1' }]] as const) {
      const result = reply(['run'], JSON.stringify({ protocol: 'phm-node-worker/v1',
        job: { id: 'ready:job:2', pack: 'codex-file', secrets: [], task }, claim }));
      expect(result.status).toBe(1);
      expect(result.value).toEqual({ codex: 'error', packError: 'invalid-request' });
      expect(existsSync(join(home, 'input'))).toBe(false);
    }
  });
  it('rejects mismatched receipts, malformed/oversized requests and unknown packs', () => {
    fake(); task();
    expect(reply(['run'], request('job', 'codex-file', { providerBinaries: { codex: '/tmp/codex' } })).value.packError).toBe('receipt-mismatch');
    for (const input of ['{}', '', 'x'.repeat(16385), request('../x'), request('job', 'unknown'), request('ready:job:../../x'), JSON.stringify({ protocol: 'phm-node-worker/v1', job: { id: 'job', pack: 'shell-check', secrets: ['secret'] } })]) {
      expect(reply(['run'], input).value.packError).toBe('invalid-request');
    }
  });
  it('runs shell-check directly and via worker and rejects usage', () => {
    expect(reply(['shell-check', 'one']).status).toBe(0);
    expect(reply(['run'], request('two', 'shell-check')).value).toEqual({ resultRef: 'node-results:two' });
    expect(statSync(path('node-results/two.json')).mode & 0o777).toBe(0o600);
    expect(run(['unknown']).status).toBe(2);
    expect(run(['omlx-ping', 'job', 'http://example.com']).status).toBe(2);
  });
  it('uses only loopback models endpoint and bounds/errors on responses', async () => {
    let body = '{"data":[]}';
    let status = 200;
    const server = createServer((req, res) => { expect(req.url).toBe('/v1/models'); res.writeHead(status); res.end(body); });
    await new Promise<void>((ok, no) => { server.once('error', no); server.listen(8000, '127.0.0.1', ok); });
    try {
      const asyncRun = (id: string) => new Promise<{ code: number | null; value: { packError?: string; resultRef?: string } }>(ok => {
        const child = spawn(process.execPath, [runner, 'omlx-ping', id], { env: { HOME: home } });
        let stdout = ''; child.stdout.on('data', c => { stdout += c; });
        child.on('close', code => ok({ code, value: JSON.parse(stdout) }));
      });
      expect(await asyncRun('models')).toEqual({ code: 0, value: { resultRef: 'node-results:models' } });
      for (const [s, b] of [[500, '{}'], [200, 'not-json'], [200, 'x'.repeat(16385)]] as const) {
        status = s; body = b;
        expect((await asyncRun('bad')).code).toBe(1);
      }
    } finally { await new Promise<void>(ok => server.close(() => ok())); }
  });
});
