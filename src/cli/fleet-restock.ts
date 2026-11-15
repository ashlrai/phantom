import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planRestock, type RestockPrecheck } from '../core/portfolio/restock-plan.js';
import { type RestockLintOptions, restockReposRoot } from '../core/portfolio/restock-lint.js';

const usage = 'Usage: phm fleet restock plan [--json]\nPlan jobs of 6–10 items per repo. Checks candidates before grouping. Does not write the queue.';
export function restockPrecheck(runs: string, repos: string): RestockPrecheck {
  return item => new Promise((resolve, reject) => {
    // Same script, arguments and deadline as dispatchd launch_precheck. Never use a shell command string.
    execFile('/bin/bash', [join(runs, 'bin', 'precheck.sh'), `${item.jobId} (${item.attrs}): ${item.task}`, join(repos, item.repo)],
      { timeout: 20_000, maxBuffer: 64 * 1024, env: {
        PATH: process.env.PATH, HOME: homedir(), GIT_TERMINAL_PROMPT: '0',
      } }, (error, stdout) => {
        const code = error ? (error as unknown as { code?: number | string }).code : 0;
        if (typeof code !== 'number' || ![0, 10, 11, 12, 13].includes(code)) { reject(new Error('Precheck unavailable')); return; }
        resolve({ code, reason: /reason=(\S+)/.exec(stdout)?.[1] ?? (code === 0 ? 'ready' : 'precheck withheld launch') });
      });
  });
}
export async function cmdFleetRestock(args: string[], inputs?: { text: string; check: RestockPrecheck; options: RestockLintOptions }): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args[0] !== 'plan' || args.slice(1).some(arg => arg !== '--json') || args.length > 2) { console.error(usage); return 2; }
  const runs = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  try {
    const report = await planRestock(inputs?.text ?? await readFile(join(runs, 'queue', 'router-queue.md'), 'utf8'), inputs?.check ?? restockPrecheck(runs, restockReposRoot()), inputs?.options);
    console.log(args.includes('--json') ? JSON.stringify(report) : `${report.jobs.length} jobs planned; ${report.excluded.length} excluded; ${report.held.length} waiting for more items; ${report.invalid.length} invalid.`);
    return 0;
  } catch { console.error('Unable to read restock candidates.'); return 1; }
}
