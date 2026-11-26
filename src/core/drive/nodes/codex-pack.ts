import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateDirectory } from '../../universe/artifacts.js';
import { CODEX_FILE_PACK, isSafeNodeJobId } from '../drive-helpers.js';
import { resolveProviderBinary } from './provider-binary.js';

const MAX_TASK = 64 * 1024;
/** Review output kept in the result artifact: the last 48 KiB of stdout. */
export const CODEX_OUTPUT_LIMIT = 48 * 1024;

export type CodexFileReply = { resultRef: string; codex: 'ok' } | { codex: 'error'; packError: CodexPackError };
export type CodexPackError = 'invalid-request' | 'binary-unavailable' | 'receipt-mismatch' | 'scratch-unavailable' |
  'codex-spawn-failed' | 'codex-timeout' | 'codex-exit-nonzero' | 'result-write-failed';

export interface CodexFileDeps {
  home?: string;
  resolveBinary?: typeof resolveProviderBinary;
  spawn?: typeof spawn;
  timeoutMs?: number;
  now?: () => Date;
}

/** Per-job working root: `~/.ashlr-runs/node-work/<jobId>/`, never the home directory. */
export function nodeWorkDir(jobId: string, home = homedir()): string {
  if (!isSafeNodeJobId(jobId)) throw new Error('Invalid node job id');
  return join(home, '.ashlr-runs', 'node-work', jobId);
}

/** Fixed argv: the task text goes on stdin, so no queue bytes reach argv. */
export function codexFileArgv(scratch: string): string[] {
  return ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', scratch, '-'];
}

/** Runs one `codex-file` job in a fresh empty 0700 scratch directory, removed afterwards.
 * Error replies carry `codex: 'error'` and a fixed `packError` code; callers exit non-zero on them. */
export async function runCodexFilePack(request: { jobId: string; task: string; binary?: string }, deps: CodexFileDeps = {}): Promise<CodexFileReply> {
  const fail = (packError: CodexPackError): CodexFileReply => ({ codex: 'error', packError });
  const { jobId, task } = request;
  if (typeof jobId !== 'string' || !isSafeNodeJobId(jobId) || typeof task !== 'string' || !task.trim() ||
      Buffer.byteLength(task) > MAX_TASK) return fail('invalid-request');
  const binary = (deps.resolveBinary ?? resolveProviderBinary)('codex');
  if (!binary) return fail('binary-unavailable');
  if (request.binary !== undefined && request.binary !== binary) return fail('receipt-mismatch');
  const home = deps.home ?? homedir();
  const scratch = nodeWorkDir(jobId, home);
  let created = false;
  try {
    try {
      privateDirectory(join(home, '.ashlr-runs', 'node-work'));
      mkdirSync(scratch, { mode: 0o700 });
      created = true;
      chmodSync(scratch, 0o700);
      const stat = lstatSync(scratch);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || readdirSync(scratch).length) return fail('scratch-unavailable');
    } catch { return fail('scratch-unavailable'); }
    let tail = Buffer.alloc(0);
    const outcome = await new Promise<'ok' | CodexPackError>(resolve => {
      let child: ReturnType<typeof spawn>;
      try {
        child = (deps.spawn ?? spawn)(binary, codexFileArgv(scratch), { cwd: scratch, shell: false,
          env: { PATH: process.env['PATH'], HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { resolve('codex-spawn-failed'); return; }
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, deps.timeoutMs ?? 25 * 60_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > CODEX_OUTPUT_LIMIT) tail = tail.subarray(tail.length - CODEX_OUTPUT_LIMIT);
      });
      child.on('error', () => { clearTimeout(timer); resolve('codex-spawn-failed'); });
      child.on('close', code => { clearTimeout(timer); resolve(timedOut ? 'codex-timeout' : code === 0 ? 'ok' : 'codex-exit-nonzero'); });
      child.stdin?.on('error', () => { /* close reports the exit */ });
      child.stdin?.end(task);
    });
    if (outcome !== 'ok') return fail(outcome);
    try {
      return { resultRef: writeCodexResult(home, jobId, tail.toString('utf8'), (deps.now ?? (() => new Date()))()), codex: 'ok' };
    } catch { return fail('result-write-failed'); }
  } finally {
    if (created) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Immutable mode-0600 artifact at `~/.ashlr-runs/node-results/<jobId>.json`; never overwrites. */
function writeCodexResult(home: string, jobId: string, output: string, completedAt: Date): string {
  const results = privateDirectory(join(privateDirectory(join(home, '.ashlr-runs')), 'node-results'));
  const body = JSON.stringify({ schemaVersion: 1, jobId, pack: CODEX_FILE_PACK, completedAt: completedAt.toISOString(),
    result: { codex: 'ok', output } }) + '\n';
  const fd = openSync(join(results, `${jobId}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  return `node-results:${jobId}`;
}
