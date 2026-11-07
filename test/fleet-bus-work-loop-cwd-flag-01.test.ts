import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { cmdFleetBusWorkLoop } from '../src/cli/fleet-bus-work-loop.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';

let base: string, root: string, snapshot: string, prompt: string, cwd: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'bus-cwd-flag-'));
  root = join(base, 'bus'); snapshot = join(base, 'snapshot'); prompt = join(base, 'prompt'); cwd = join(base, 'worktree');
  mkdirSync(cwd); mkdirSync(join(base, 'runs'), { mode: 0o700 });
  writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'CURRENTJOB', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  writeFileSync(prompt, 'prompt');
  vi.stubEnv('HOME', base); vi.stubEnv('ASHLR_HOME', join(base, 'ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(base, 'runs'));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(base, { recursive: true, force: true }); });

function run(directory: string) {
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  return cmdFleetBusWorkLoop(['--to', 'worker', '--owner', 'owner', '--lease-ms', '60000', '--wait-ms', '500',
    '--max-jobs', '1', '--snapshot', snapshot, '--prompt', prompt, '--root', root, '--cwd', directory, '--',
    process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>{require('node:fs').writeFileSync('cwd.txt',process.cwd());console.log('done')})"],
  { stdout: sink, stderr: sink });
}

it('passes --cwd to the worker child process', async () => {
  expect(appendBusInbox({ id: 'request', from: 'leader', to: 'worker', priority: 'P1', ttl: 120000,
    body: { kind: 'work' } }, { root }).status).toBe('posted');
  expect(await run(cwd)).toBe(0);
  expect(readFileSync(join(cwd, 'cwd.txt'), 'utf8')).toBe(realpathSync(cwd));
});

it('rejects a relative --cwd with exit code 2', async () => {
  expect(await run('relative')).toBe(2);
});
