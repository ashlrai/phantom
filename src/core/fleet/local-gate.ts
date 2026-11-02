import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { rollupFleetPrChecks } from './fleet-merge-state.js';
import { scrubSecrets } from '../util/scrub.js';

export interface LocalGateExecResult { ok: boolean; stdout: string; stderr: string }
export type LocalGateExec = (command: string, args: string[], cwd: string) => Promise<LocalGateExecResult>;
export interface LocalGateReport {
  verdict: 'pass' | 'fail';
  headSha: string;
  baseSha: string;
  steps: { name: string; ok: boolean; seconds: number; blockers?: LocalGateBlocker[] }[];
  seconds: number;
}
export interface LocalGateBlocker {
  kind: 'branch-behind' | 'pending-check' | 'conflict' | 'failed-check' | 'unknown';
  nextStep: string;
}

/** Only explicit, current-head evidence can establish readiness. Never echo remote output. */
function mergeBlockers(result: LocalGateExecResult, headSha: string): LocalGateBlocker[] {
  const unknown: LocalGateBlocker = { kind: 'unknown', nextStep: 'Inspect gh pr view for this branch and rerun local-gate once current-head merge readiness is available.' };
  let raw: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!result.ok || !value || typeof value !== 'object' || Array.isArray(value)) return [unknown];
    raw = value as Record<string, unknown>;
  } catch { return [unknown]; }
  if (!headSha || raw.headRefOid !== headSha || raw.state !== 'OPEN' || raw.isDraft !== false) return [unknown];
  const blockers: LocalGateBlocker[] = [];
  if (raw.mergeStateStatus === 'BEHIND') blockers.push({ kind: 'branch-behind', nextStep: 'Fetch the base branch, merge or rebase it into this branch, then rerun checks on the updated head.' });
  if (raw.mergeStateStatus === 'DIRTY' || raw.mergeable === 'CONFLICTING') blockers.push({ kind: 'conflict', nextStep: 'Merge or rebase the base branch, resolve conflicts, and rerun checks before requesting merge.' });
  const checks = rollupFleetPrChecks(raw.statusCheckRollup);
  if (checks === 'pending') blockers.push({ kind: 'pending-check', nextStep: 'Run gh pr checks --watch; wait for current-head checks to finish, then rerun local-gate.' });
  if (checks === 'red') blockers.push({ kind: 'failed-check', nextStep: 'Inspect gh pr checks, fix the failing checks, and rerun them on the updated head.' });
  if (!['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BEHIND', 'DIRTY'].includes(String(raw.mergeStateStatus)) ||
      !['MERGEABLE', 'CONFLICTING'].includes(String(raw.mergeable)) || checks === 'none') blockers.push(unknown);
  return blockers;
}

export interface LocalGateDeps {
  exec?: LocalGateExec;
  cwd?: string;
  now?: () => number;
  metricsPath?: string;
  appendMetric?: (path: string, row: string) => Promise<void>;
  warn?: (message: string) => void;
}

/** Capture children privately; only scrubbed output crosses the execution boundary. */
const defaultExec: LocalGateExec = (command, args, cwd) => new Promise(resolve => {
  execFile(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout: scrubSecrets(stdout), stderr: scrubSecrets(stderr) });
  });
});

async function appendMetric(path: string, row: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, row, { encoding: 'utf8', mode: 0o600 });
}

/** Measures the current working tree, including uncommitted edits; SHAs identify its ancestry only. */
export async function runLocalGate(budgetSeconds = 180, deps: LocalGateDeps = {}): Promise<LocalGateReport> {
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error('budget-seconds must be positive and finite');
  const exec = deps.exec ?? defaultExec;
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => performance.now() / 1000);
  const start = now();
  const steps: LocalGateReport['steps'] = [];
  const run = async (command: string, args: string[]): Promise<LocalGateExecResult> => {
    try {
      const result = await exec(command, args, cwd);
      return { ok: result.ok, stdout: scrubSecrets(result.stdout), stderr: scrubSecrets(result.stderr) };
    } catch {
      return { ok: false, stdout: '', stderr: '' };
    }
  };
  const sha = async (args: string[]): Promise<string> => {
    const result = await run('git', args);
    const value = result.stdout.trim();
    return result.ok && /^[a-f0-9]{40}$/.test(value) ? value : '';
  };
  const headSha = await sha(['rev-parse', 'HEAD']);
  const baseSha = await sha(['merge-base', 'HEAD', 'origin/master']);
  if (!headSha || !baseSha) steps.push({ name: 'git identity', ok: false, seconds: now() - start });
  for (const [name, command, args] of [
    ['typecheck', 'npx', ['tsc', '--noEmit', '-p', 'tsconfig.json']],
    ['verify-changed', 'node', ['scripts/verify-changed.mjs']],
  ] as const) {
    const stepStart = now();
    const result = await run(command, [...args]);
    steps.push({ name, ok: result.ok, seconds: now() - stepStart });
  }
  const mergeStart = now();
  const merge = await run('gh', ['pr', 'view', '--json', 'state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup']);
  const blockers = mergeBlockers(merge, headSha);
  steps.push({ name: 'merge readiness', ok: blockers.length === 0, seconds: now() - mergeStart, blockers });
  const seconds = now() - start;
  if (seconds > budgetSeconds) steps.push({ name: 'budget', ok: false, seconds });
  const report: LocalGateReport = { verdict: steps.every(step => step.ok) ? 'pass' : 'fail', headSha, baseSha, steps, seconds };
  try {
    await (deps.appendMetric ?? appendMetric)(deps.metricsPath ?? join(homedir(), '.ashlr-runs', 'metrics', 'local-gate.jsonl'), JSON.stringify(report) + '\n');
  } catch {
    (deps.warn ?? (message => process.stderr.write(message + '\n')))('warning: could not append local-gate metrics');
  }
  return report;
}
