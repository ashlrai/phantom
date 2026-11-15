/**
 * Process spawn for a coding CLI. Unit tests pass a fake runner instead, or
 * point this helper at a script under a temp directory. It never shells out
 * through a string.
 */

import { spawn } from 'node:child_process';

import type { CliResult } from './probe.js';

export function spawnCli(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
