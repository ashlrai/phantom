import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { rollupFleetPrChecks } from './fleet-merge-state.js';
import { readSource, type Source } from './runs-parked-queue.js';
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
  /**
   * Also read the branch's PR merge readiness. Only the pre-merge CLI turns this
   * on: worker gates run before a PR exists, so it stays off for them and their
   * verdicts are unchanged.
   */
  mergeReadiness?: boolean;
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

/**
 * Compiler argv for the typecheck step, resolved against the gate's working
 * tree before launch. An already-installed tsgo under cwd's node_modules wins;
 * otherwise the installed tsc entrypoint runs under node. Selection is
 * absence-only: a chosen compiler that errors, exits nonzero or cannot launch
 * is the gate's typecheck failure — never retried against the other compiler,
 * and never resolved through npx, a shell or the network.
 */
function typecheckCommand(cwd: string): readonly [command: string, args: string[]] {
  const tsgo = resolve(cwd, 'node_modules', '.bin', 'tsgo');
  if (existsSync(tsgo)) return [tsgo, ['--noEmit', '-p', 'tsconfig.json']];
  return ['node', [resolve(cwd, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json']];
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
  const [typecheckCmd, typecheckArgs] = typecheckCommand(cwd);
  for (const [name, command, args] of [
    ['typecheck', typecheckCmd, typecheckArgs],
    ['verify-changed', 'node', ['scripts/verify-changed.mjs']],
  ] as const) {
    const stepStart = now();
    const result = await run(command, [...args]);
    steps.push({ name, ok: result.ok, seconds: now() - stepStart });
  }
  if (deps.mergeReadiness) {
    const mergeStart = now();
    const merge = await run('gh', ['pr', 'view', '--json', 'state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup']);
    const blockers = mergeBlockers(merge, headSha);
    steps.push({ name: 'merge readiness', ok: blockers.length === 0, seconds: now() - mergeStart, blockers });
  }
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

/**
 * Read-back for the local-gate ledger `runLocalGate` appends to
 * `<runs>/metrics/local-gate.jsonl`. Every gated worker run records one
 * LocalGateReport — the pre-merge verdict plus per-step outcomes — but until
 * now nothing consumed the ledger, so gate health (which step fails, how
 * often, what the latest verdict was) was write-only evidence. The reader
 * keeps the launch-cost contract: a bounded no-follow tail, malformed lines
 * degrade the source without erasing valid rows, unknown stays unknown.
 */
export interface LocalGateStepTally { name: string; runs: number; failures: number }
export interface LocalGateLastReport { verdict: 'pass' | 'fail'; seconds: number; failedSteps: string[] }
export interface LocalGateEvidence {
  source: Source;
  /** 'known' once at least one structurally valid report was read. */
  state: 'known' | 'unknown';
  /** Valid reports inside the retained tail window. */
  reports: number;
  /** Lines that were not a LocalGateReport; they are ignored, never guessed. */
  invalidRows: number;
  passed: number;
  failed: number;
  /** Per-step run/failure tallies over the same window, worst first. */
  steps: LocalGateStepTally[];
  /** The newest valid report in ledger order; null when none parsed. */
  last: LocalGateLastReport | null;
}

const LOCAL_GATE_LEDGER_RELATIVE = join('metrics', 'local-gate.jsonl');
const LOCAL_GATE_TAIL_BYTES = 256 * 1024;
const LOCAL_GATE_MAX_STEPS = 16;
const LOCAL_GATE_MAX_STEP_NAME = 64;
const LOCAL_GATE_MAX_TALLIES = 12;
const LOCAL_GATE_MAX_FAILED_STEPS = 8;
const GIT_SHA = /^[a-f0-9]{40}$/;

interface ParsedGateStep { name: string; ok: boolean }
interface ParsedGateReport { verdict: 'pass' | 'fail'; seconds: number; steps: ParsedGateStep[] }

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Structural check of one ledger row against the LocalGateReport the writer emits. */
function parseLocalGateReport(value: unknown): ParsedGateReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.verdict !== 'pass' && row.verdict !== 'fail') return null;
  if (typeof row.headSha !== 'string' || (row.headSha !== '' && !GIT_SHA.test(row.headSha))) return null;
  if (typeof row.baseSha !== 'string' || (row.baseSha !== '' && !GIT_SHA.test(row.baseSha))) return null;
  if (!finiteNonNegative(row.seconds)) return null;
  if (!Array.isArray(row.steps) || row.steps.length > LOCAL_GATE_MAX_STEPS) return null;
  const steps: ParsedGateStep[] = [];
  for (const entry of row.steps) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const step = entry as Record<string, unknown>;
    if (typeof step.name !== 'string' || step.name.length === 0 || step.name.length > LOCAL_GATE_MAX_STEP_NAME) return null;
    if (typeof step.ok !== 'boolean' || !finiteNonNegative(step.seconds)) return null;
    steps.push({ name: step.name, ok: step.ok });
  }
  return { verdict: row.verdict, seconds: row.seconds, steps };
}

/** Bounded tail read of the local-gate ledger; aggregates verdicts and per-step failures. */
export async function readLocalGateEvidence(runsDir: string): Promise<LocalGateEvidence> {
  const empty: LocalGateEvidence = { source: 'missing', state: 'unknown', reports: 0, invalidRows: 0, passed: 0, failed: 0, steps: [], last: null };
  const source = await readSource(join(runsDir, LOCAL_GATE_LEDGER_RELATIVE), LOCAL_GATE_TAIL_BYTES, true);
  if (source.state === 'missing') return empty;
  const reports: ParsedGateReport[] = [];
  let invalidRows = 0;
  for (const line of source.text.split(/\r?\n/).filter(Boolean)) {
    let parsed: ParsedGateReport | null = null;
    try { parsed = parseLocalGateReport(JSON.parse(line)); } catch { parsed = null; }
    if (parsed) reports.push(parsed); else invalidRows += 1;
  }
  const tallies = new Map<string, LocalGateStepTally>();
  for (const report of reports) {
    for (const step of report.steps) {
      const tally = tallies.get(step.name) ?? { name: step.name, runs: 0, failures: 0 };
      tally.runs += 1;
      if (!step.ok) tally.failures += 1;
      tallies.set(step.name, tally);
    }
  }
  const steps = [...tallies.values()]
    .sort((a, b) => b.failures - a.failures || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, LOCAL_GATE_MAX_TALLIES);
  const newest = reports.at(-1);
  return {
    source: invalidRows > 0 ? 'degraded' : source.state,
    state: reports.length > 0 ? 'known' : 'unknown',
    reports: reports.length,
    invalidRows,
    passed: reports.filter(report => report.verdict === 'pass').length,
    failed: reports.filter(report => report.verdict === 'fail').length,
    steps,
    last: newest === undefined ? null : {
      verdict: newest.verdict,
      seconds: newest.seconds,
      failedSteps: newest.steps.filter(step => !step.ok).map(step => step.name).slice(0, LOCAL_GATE_MAX_FAILED_STEPS),
    },
  };
}
