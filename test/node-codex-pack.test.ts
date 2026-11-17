import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_OUTPUT_LIMIT, codexFileArgv, nodeWorkDir, runCodexFilePack } from '../src/core/drive/nodes/codex-pack.js';

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  kill = vi.fn(() => { this.emit('close', null); return true; });
}
let home: string;
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-pack-'))); });
afterEach(() => { vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });

function fakeSpawn(code: number | null, observe?: (cwd: string) => void, output: string | Buffer = '') {
  const child = new Child();
  let task = '';
  child.stdin.on('data', chunk => { task += String(chunk); });
  const spawn = vi.fn((_binary: string, argv: string[], options: { cwd: string }) => {
    observe?.(options.cwd);
    child.stdin.on('finish', () => { if (output.length) child.stdout.write(output); setImmediate(() => { if (code !== null) child.emit('close', code); }); });
    return child;
  });
  return { spawn, child, task: () => task };
}
const completedAt = new Date('2026-11-17T22:00:00.000Z');
const deps = (spawn: unknown) => ({ home, resolveBinary: () => '/opt/homebrew/bin/codex', spawn: spawn as never, now: () => completedAt });
const resultsDir = () => join(home, '.ashlr-runs', 'node-results');

describe('codex-file pack scratch directory', () => {
  it('runs codex with -C set to an empty 0700 per-job scratch dir, never the home dir, and removes it', async () => {
    let seen: { mode: number; entries: string[] } | undefined;
    writeFileSync(join(home, 'private-note.txt'), 'home content');
    const fake = fakeSpawn(0, cwd => { seen = { mode: statSync(cwd).mode & 0o777, entries: readdirSync(cwd) }; }, 'LGTM: no findings.\n');
    const reply = await runCodexFilePack({ jobId: 'review-1', task: 'Review the attached file.' }, deps(fake.spawn));
    expect(reply).toEqual({ resultRef: 'node-results:review-1', codex: 'ok' });
    const [binary, argv, options] = fake.spawn.mock.calls[0]!;
    const scratch = join(home, '.ashlr-runs', 'node-work', 'review-1');
    expect(binary).toBe('/opt/homebrew/bin/codex');
    expect(argv).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', scratch, '-']);
    expect(argv.slice(argv.indexOf('--sandbox'), argv.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'read-only']);
    const cPath = argv[argv.indexOf('-C') + 1];
    expect(cPath).toBe(nodeWorkDir('review-1', home));
    expect(cPath).not.toBe(home);
    expect([cPath, options.cwd]).not.toContain(home);
    expect(options).toMatchObject({ cwd: scratch, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(seen).toEqual({ mode: 0o700, entries: [] });
    expect(fake.task()).toBe('Review the attached file.');
    expect(argv.join(' ')).not.toContain('Review the attached file.');
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(home).sort()).toEqual(['.ashlr-runs', 'private-note.txt']);
    const artifact = join(resultsDir(), 'review-1.json');
    expect(statSync(artifact).mode & 0o777).toBe(0o600);
    expect(statSync(resultsDir()).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toEqual({ schemaVersion: 1, jobId: 'review-1', pack: 'codex-file',
      completedAt: '2026-11-17T22:00:00.000Z', result: { codex: 'ok', output: 'LGTM: no findings.\n' } });
  });
  it('bounds the stored review output to its last 48 KiB', async () => {
    const big = 'a'.repeat(CODEX_OUTPUT_LIMIT) + 'TAIL-END';
    const fake = fakeSpawn(0, undefined, big);
    expect(await runCodexFilePack({ jobId: 'review-big', task: 'x' }, deps(fake.spawn))).toEqual({ resultRef: 'node-results:review-big', codex: 'ok' });
    const { result } = JSON.parse(readFileSync(join(resultsDir(), 'review-big.json'), 'utf8'));
    expect(CODEX_OUTPUT_LIMIT).toBe(48 * 1024);
    expect(Buffer.byteLength(result.output)).toBe(CODEX_OUTPUT_LIMIT);
    expect(result.output.endsWith('TAIL-END')).toBe(true);
  });
  it('never overwrites an existing result artifact', async () => {
    mkdirSync(resultsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(resultsDir(), 'review-dup.json'), 'prior', { mode: 0o600 });
    const fake = fakeSpawn(0, undefined, 'new');
    expect(await runCodexFilePack({ jobId: 'review-dup', task: 'x' }, deps(fake.spawn))).toEqual({ codex: 'error', packError: 'result-write-failed' });
    expect(readFileSync(join(resultsDir(), 'review-dup.json'), 'utf8')).toBe('prior');
  });
  it('reports a codex failure as a pack error and still removes the scratch dir', async () => {
    const fake = fakeSpawn(1, undefined, 'partial review');
    expect(await runCodexFilePack({ jobId: 'review-2', task: 'x' }, deps(fake.spawn))).toEqual({ codex: 'error', packError: 'codex-exit-nonzero' });
    expect(existsSync(join(resultsDir(), 'review-2.json'))).toBe(false);
    expect(existsSync(nodeWorkDir('review-2', home))).toBe(false);
  });
  it('kills a run past its deadline and removes the scratch dir', async () => {
    const fake = fakeSpawn(null);
    expect(await runCodexFilePack({ jobId: 'review-3', task: 'x' }, { ...deps(fake.spawn), timeoutMs: 10 }))
      .toEqual({ codex: 'error', packError: 'codex-timeout' });
    expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(existsSync(join(resultsDir(), 'review-3.json'))).toBe(false);
    expect(existsSync(nodeWorkDir('review-3', home))).toBe(false);
  });
  it('refuses a missing binary, a mismatched receipt, bad job ids and a pre-existing scratch dir before spawning', async () => {
    const fake = fakeSpawn(0);
    expect(await runCodexFilePack({ jobId: 'j', task: 'x' }, { ...deps(fake.spawn), resolveBinary: () => null }))
      .toEqual({ codex: 'error', packError: 'binary-unavailable' });
    expect(await runCodexFilePack({ jobId: 'j', task: 'x', binary: '/usr/local/bin/codex' }, deps(fake.spawn)))
      .toEqual({ codex: 'error', packError: 'receipt-mismatch' });
    for (const jobId of ['../escape', '', '.hidden', 'a/b'])
      expect(await runCodexFilePack({ jobId, task: 'x' }, deps(fake.spawn))).toEqual({ codex: 'error', packError: 'invalid-request' });
    expect(await runCodexFilePack({ jobId: 'j', task: ' ' }, deps(fake.spawn))).toEqual({ codex: 'error', packError: 'invalid-request' });
    mkdirSync(nodeWorkDir('stale', home), { recursive: true, mode: 0o700 });
    writeFileSync(join(nodeWorkDir('stale', home), 'leftover'), '');
    expect(await runCodexFilePack({ jobId: 'stale', task: 'x' }, deps(fake.spawn))).toEqual({ codex: 'error', packError: 'scratch-unavailable' });
    expect(existsSync(join(nodeWorkDir('stale', home), 'leftover'))).toBe(true);
    expect(fake.spawn).not.toHaveBeenCalled();
    expect(existsSync(resultsDir()) ? readdirSync(resultsDir()) : []).toEqual([]);
    expect(codexFileArgv('/s')).toEqual(['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', '/s', '-']);
  });
});
