import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Config, Pool, Verdict, verdictFrom } from './policy.js';

export const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export function cleanEnv(home: string): NodeJS.ProcessEnv {
  return { HOME: home, TMPDIR: home, PATH: SAFE_PATH, LANG: 'en_US.UTF-8', GH_CONFIG_DIR: join(home, '.config/gh'), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
}
export function run(executable: string, args: string[], input: string, home: string, maxBytes = 1048576, timeout = 120000, cwd = home): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: cleanEnv(home), shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; let failed = false;
    const stop = (): void => { failed = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const timer = setTimeout(stop, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > maxBytes) stop(); });
    child.stdin.on('error', () => { /* A closed child pipe is handled by its exit. */ });
    child.on('error', () => { clearTimeout(timer); reject(new Error('process-failed')); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0 || failed) reject(new Error('process-failed')); else resolve(output); });
    child.stdin.end(input);
  });
}
export async function freshReview(config: Config, diff: string, rules: string): Promise<Verdict> {
  const home = await mkdtemp(join(tmpdir(), 'rq-review-'));
  try {
    // No CLI agent, history, scratch files, shell, tools, gh environment or model key.
    const worker = fileURLToPath(new URL('./review-worker.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));
    const result = await run(process.execPath, ['--import', tsx, worker], JSON.stringify({ ...config.reviewer, diff, rules }), home, 2048);
    return verdictFrom(result);
  } finally { await rm(home, { recursive: true, force: true }); }
}
export function sandboxProfile(denied: string[], runtime: string): string {
  return `(version 1) (allow default) (deny process-info*) (deny mach-lookup) (deny ipc-posix*) (deny signal)
    (deny network-outbound (remote ip "localhost:*"))
    (deny file-write* (subpath ${JSON.stringify(realpathSync(runtime))}))\n${denied.map(path => `(deny file* (subpath ${JSON.stringify(realpathSync(path))}))`).join('\n')}`;
}
export async function isolatedRun(config: Config, pool: Pool, input: string, denied: string[], timeout = 3600000): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('mac-sandbox-required');
  const uid = Number((await run('/usr/bin/id', ['-u', config.jobUser], '', '/private/tmp')).trim());
  if (!Number.isSafeInteger(uid) || uid === 0 || uid === process.getuid?.()) throw new Error('separate-job-user-required');
  // sudoers is installed by Mason, scoped to a dedicated non-root account.
  // env -i also removes SUDO_* and prevents the privileged HOME leaking back in.
  const prefix = ['-n', '-u', config.jobUser, '/usr/bin/env', '-i', 'PATH=' + SAFE_PATH];
  const home = (await run('/usr/bin/sudo', [...prefix, '/usr/bin/mktemp', '-d', '/private/tmp/rq-job.XXXXXXXX'], '', '/private/tmp')).trim();
  if (!/^\/private\/tmp\/rq-job\.[A-Za-z0-9]+$/.test(home)) throw new Error('invalid-job-home');
  try {
    const runtime = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    return await run('/usr/bin/sudo', [...prefix, 'HOME=' + home, 'TMPDIR=' + home, 'GH_CONFIG_DIR=' + join(home, '.config/gh'),
      '/usr/bin/sandbox-exec', '-p', sandboxProfile(denied, runtime), pool.executable, ...pool.args], input, '/private/tmp', 1024, timeout);
  } finally { await run('/usr/bin/sudo', [...prefix, '/bin/rm', '-rf', home], '', '/private/tmp'); }
}
export async function dispatch(config: Config, pool: Pool, input: string, denied: string[]): Promise<{ pr?: number; failed?: boolean }> {
    const output = await isolatedRun(config, pool, input, denied);
    const result: unknown = JSON.parse(output);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('invalid-dispatch');
    const r = result as Record<string, unknown>;
    if (Object.keys(r).join() === 'pr' && Number.isSafeInteger(r.pr) && Number(r.pr) > 0) return { pr: Number(r.pr) };
    if (Object.keys(r).join() === 'failed' && r.failed === true) return { failed: true };
    throw new Error('invalid-dispatch');
}
