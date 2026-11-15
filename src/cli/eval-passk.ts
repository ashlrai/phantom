/**
 * `phm eval passk` — RQ-SWE5-PASSK-EVAL (research digest item 4): the pass^k
 * offline eval suite.
 *
 * Runs the pinned golden task set N times per lane/model — every trial in a
 * clean materialized or copied worktree — and reports pass@1 (Wilson CI),
 * pass@k and pass^k per task and per lane. Each run publishes the report,
 * the lane-scores projection `ashlr router rank` surfaces, and a bounded
 * regression-alerts journal under ~/.ashlr/eval/passk/.
 *
 *   phm eval passk [--dataset <golden.jsonl>] [--repo-base <dir>]
 *                  [--lane <lane:engine>]... [--trials N] [--k K]
 *                  [--limit N] [--json] [--write <file>] [--baseline <file>]
 *                  [--gate]
 *   phm eval passk scores [--json]
 *   phm eval passk alerts [--json]
 *   phm eval passk schedule [--install] [--hour 0-23]
 *
 * --lane names an api-model engine id (e.g. local-coder); the default lane
 * is the loopback-only local lane, which skips cleanly when no local
 * provider is up. --gate exits 3 on a regression vs the baseline for CI.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import type { EvalLane } from '../core/eval/agent-output.js';
import {
  derivePassKAlerts,
  laneScoresPath,
  loadLastPassKReport,
  loadPassKAlerts,
  parsePassKDataset,
  passkAlertsPath,
  passkDir,
  publishPassKReport,
  readLaneScores,
  runPassKEval,
  PASSK_DEFAULT_K,
  PASSK_DEFAULT_TRIALS,
  PASSK_MAX_TRIALS,
  type LaneScores,
  type PassKDataset,
  type PassKReport,
} from '../core/eval/passk.js';
import { buildDefaultRunner, type EngineRunner } from '../core/eval/swe-bench.js';
import { evalPassKSchedule } from '../core/eval/passk-schedule.js';
import type { ScheduleUnit } from '../core/steward/schedule.js';
import { installScheduleUnits } from './steward.js';
import { makeColors, isTty, pad } from './ui.js';

const { bold, dim, cyan, red, green, yellow } = makeColors(isTty());

const USAGE = `Usage: phm eval passk [--dataset <golden.jsonl>] [--repo-base <dir>] [--lane <lane:engine>]... [--trials N] [--k K] [--limit N] [--json] [--write <file>] [--baseline <file>] [--gate]
       phm eval passk scores [--json]
       phm eval passk alerts [--json]
       phm eval passk schedule [--install] [--hour 0-23]

  Runs the pinned golden task set N times per lane/model in clean worktrees
  and reports pass@1, pass@k and pass^k. Publishes the report, the
  lane-scores projection and regression alerts under ~/.ashlr/eval/passk/.
  Default lane: local:local-coder (loopback-only; skips when no local
  provider is up). --gate exits 3 when the run regressed vs the baseline.`;

const LANE_SPEC = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):([A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/;
const DEFAULT_LANES: ReadonlyArray<{ lane: string; model: string }> = [{ lane: 'local', model: 'local-coder' }];

// M341a (win32): fileURLToPath for portable module-relative paths.
const BUNDLED_DATASET = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../benchmarks/passk/golden-tasks.jsonl',
);

export interface EvalPassKCliDeps {
  readFile?: (path: string) => string;
  writeFile?: (path: string, text: string) => void;
  /** Engine-runner seam (tests): return a runner for a lane/model pair. */
  runnerFor?: (lane: string, model: string) => EngineRunner;
  /** Persistence root override (tests); default ASHLR_HOME or ~/.ashlr. */
  rootDir?: string;
  bundledDatasetPath?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  nowMs?: () => number;
  phmPath?: string;
  platform?: NodeJS.Platform;
  built?: () => boolean;
  installUnits?: (units: ScheduleUnit[], opts: { logName: string }) => number;
  /** Local-provider probe (tests); default mirrors `ashlr eval`'s guard. */
  localProviderUp?: () => Promise<boolean>;
}

interface ParsedRunArgs {
  dataset?: string;
  repoBase?: string;
  lanes: { lane: string; model: string }[];
  trials?: number;
  k?: number;
  limit?: number;
  json: boolean;
  write?: string;
  baseline?: string;
  gate: boolean;
  usageError?: string;
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  const parsed: ParsedRunArgs = { lanes: [], json: false, gate: false };
  const valueFlags = new Set(['--dataset', '--repo-base', '--lane', '--trials', '--k', '--limit', '--write', '--baseline']);
  const seenSingle = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (parsed.json) { parsed.usageError = 'repeated argument: --json'; return parsed; }
      parsed.json = true;
      continue;
    }
    if (arg === '--gate') {
      if (parsed.gate) { parsed.usageError = 'repeated argument: --gate'; return parsed; }
      parsed.gate = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      if (arg !== '--lane' && seenSingle.has(arg)) { parsed.usageError = `repeated argument: ${arg}`; return parsed; }
      seenSingle.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) {
        parsed.usageError = `${arg} requires a value`;
        return parsed;
      }
      if (arg === '--lane') {
        const match = LANE_SPEC.exec(value);
        if (!match) { parsed.usageError = '--lane takes <lane>:<engine> (e.g. local:local-coder)'; return parsed; }
        parsed.lanes.push({ lane: match[1]!, model: match[2]! });
        continue;
      }
      if (arg === '--trials' || arg === '--k' || arg === '--limit') {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 1) { parsed.usageError = `${arg} requires a positive integer`; return parsed; }
        if (arg === '--trials') {
          if (n > PASSK_MAX_TRIALS) { parsed.usageError = `--trials must be <= ${PASSK_MAX_TRIALS}`; return parsed; }
          parsed.trials = n;
        } else if (arg === '--k') parsed.k = n;
        else parsed.limit = n;
        continue;
      }
      const key = { '--dataset': 'dataset', '--repo-base': 'repoBase', '--write': 'write', '--baseline': 'baseline' }[arg] as 'dataset' | 'repoBase' | 'write' | 'baseline';
      parsed[key] = value;
      continue;
    }
    parsed.usageError = `unknown argument: ${arg}`;
    return parsed;
  }
  if (parsed.k !== undefined && parsed.trials !== undefined && parsed.k > parsed.trials) {
    parsed.usageError = '--k must be <= --trials';
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function renderReport(report: PassKReport): void {
  console.log('');
  console.log(bold('  phm eval passk') + dim(` — ${report.generatedAt}`));
  console.log('');
  console.log(`  Dataset : ${cyan(report.dataset.id ?? '(unnamed)')} ${dim(`sha256 ${report.dataset.sha256.slice(0, 12)}, ${report.dataset.tasks} tasks`)}`);
  console.log(`  Trials  : ${report.trials} per task, k=${report.k}`);
  console.log('');
  for (const lane of report.lanes) {
    console.log(`  ${bold(lane.lane)} ${dim(lane.model)} — pass@1 ${pct(lane.meanPass1)}, pass@${report.k} ${pct(lane.meanPassAtK)}, pass^${report.k} ${pct(lane.meanPassPowK)}`);
    const idW = Math.max(8, ...lane.tasks.map((t) => t.taskId.length));
    const header = `${pad('task', idW)}  ${pad('pass1', 8)} ${pad(`pass@${report.k}`, 8)} ${pad(`pass^${report.k}`, 8)} passes`;
    console.log('    ' + dim(header));
    console.log('    ' + dim('-'.repeat(header.length)));
    for (const task of lane.tasks) {
      const mark = task.passes === task.trials ? green('✓') : task.passes === 0 ? red('✗') : yellow('~');
      console.log(`    ${pad(task.taskId, idW)}  ${pct(task.pass1)}   ${pct(task.passAtK)}   ${pct(task.passPowK)}  ${mark} ${task.passes}/${task.trials}`);
    }
    console.log('');
  }
  if (report.alerts.length > 0) {
    console.log(`  ${red('alerts:')} ${report.alerts.length} regression(s)`);
    for (const alert of report.alerts.slice(0, 10)) {
      const where = alert.taskId ? ` ${alert.taskId}` : '';
      const dimension = alert.dimension ? ` ${alert.dimension}` : '';
      console.log(`    ${red('⚠')} ${alert.lane}/${alert.model}:${where}${dimension} ${alert.kind} ${pct(alert.before)} → ${pct(alert.after)}`);
    }
    if (report.alerts.length > 10) console.log(`    ${dim(`… ${report.alerts.length - 10} more`)}`);
    console.log('');
  }
}

function renderScores(scores: LaneScores, state: string): void {
  console.log(`lane-scores ${dim(`(${state}, report ${scores.reportId}, generated ${scores.generatedAt})`)}`);
  for (const lane of scores.lanes) {
    console.log(`  ${lane.lane}/${lane.model}: pass@1 ${pct(lane.pass1)} (${lane.passes}/${lane.trials}), pass@k ${pct(lane.passAtK)}, pass^k ${pct(lane.passPowK)}`);
  }
}

// ---------------------------------------------------------------------------
// schedule subverb
// ---------------------------------------------------------------------------

interface SchedDeps {
  out: (text: string) => void;
  err: (text: string) => void;
  phmPath: string;
  platform: NodeJS.Platform;
  built: () => boolean;
  installUnits: (units: ScheduleUnit[], opts: { logName: string }) => number;
}

function schedule(argv: string[], deps: SchedDeps): number {
  let hour: number | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!['--hour', '--install'].includes(arg) || flags.has(arg)) {
      deps.err(`error: unknown or repeated argument: ${arg}\n${USAGE}`);
      return 2;
    }
    flags.add(arg);
    if (arg === '--hour') {
      const value = argv[++i];
      if (value === undefined || !/^\d{1,2}$/.test(value) || Number(value) > 23) {
        deps.err('error: --hour requires an integer from 0 to 23');
        return 2;
      }
      hour = Number(value);
    }
  }
  try {
    const units = evalPassKSchedule({ phmPath: deps.phmPath, hour, platform: deps.platform });
    if (!flags.has('--install')) {
      for (const unit of units) deps.out(`# ${unit.path}\n${unit.contents}`);
      deps.out('Re-run with --install to enable the nightly pass^k eval.');
      return 0;
    }
    if (process.getuid?.() === 0) throw new Error('Install the pass^k eval schedule as a regular user, not root.');
    if (!deps.built()) throw new Error('Compiled CLI missing; run npm run build before installing the schedule.');
    const code = deps.installUnits(units, { logName: 'eval-passk.jsonl' });
    if (code !== 0) return code;
    deps.out('pass^k eval scheduled nightly (run-only; publishes reports and alerts).');
    return 0;
  } catch (error) {
    deps.err(`error: ${(error as Error).message}`);
    return 1;
  }
}

async function defaultLocalProviderUp(): Promise<boolean> {
  try {
    const { loadConfig } = await import('../core/config.js');
    const { getActiveClient } = await import('../core/run/provider-client.js');
    await getActiveClient(loadConfig(), { allowCloud: false });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function cmdEvalPassK(args: string[], overrides: EvalPassKCliDeps = {}): Promise<number> {
  const out = overrides.out ?? ((t: string) => console.log(t));
  const err = overrides.err ?? ((t: string) => console.error(t));
  const readFile = overrides.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    out(USAGE);
    return 0;
  }

  const schedDeps: SchedDeps = {
    out,
    err,
    phmPath: overrides.phmPath ?? fileURLToPath(new URL('../../bin/ashlr', import.meta.url)),
    platform: overrides.platform ?? process.platform,
    built: overrides.built ?? (() => existsSync(fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)))),
    installUnits: overrides.installUnits ?? ((units, o) => installScheduleUnits(units, o)),
  };

  const [sub, ...rest] = args;
  if (sub === 'schedule') return schedule(rest, schedDeps);

  if (sub === 'scores' || sub === 'alerts') {
    for (const arg of rest) {
      if (arg !== '--json') { err(`error: unknown argument: ${arg}\n${USAGE}`); return 2; }
    }
    const json = rest.includes('--json');
    if (sub === 'scores') {
      const { state, scores } = readLaneScores({ rootDir: overrides.rootDir });
      if (scores === null) {
        if (json) out(JSON.stringify({ state, scores: null }));
        else err(`no lane-scores projection yet (state: ${state}) — run \`phm eval passk\` first`);
        return 1;
      }
      if (json) out(JSON.stringify(scores, null, 2));
      else renderScores(scores, state);
      return 0;
    }
    const journal = loadPassKAlerts({ rootDir: overrides.rootDir });
    if (json) {
      out(JSON.stringify({ state: journal.state, alerts: journal.alerts, dropped: journal.dropped }, null, 2));
      return 0;
    }
    if (journal.alerts.length === 0) {
      out(`no pass^k regression alerts recorded (state: ${journal.state})`);
      return 0;
    }
    for (const line of journal.alerts) {
      const where = line.alert.taskId ? ` ${line.alert.taskId}` : '';
      const dimension = line.alert.dimension ? ` ${line.alert.dimension}` : '';
      out(`${line.ts} ${line.alert.lane}/${line.alert.model}:${where}${dimension} ${line.alert.kind} ${pct(line.alert.before)} → ${pct(line.alert.after)}`);
    }
    return 0;
  }

  // ── run verb ─────────────────────────────────────────────────────────────
  const parsed = parseRunArgs(args);
  if (parsed.usageError) {
    err(`error: ${parsed.usageError}\n${USAGE}`);
    return 2;
  }

  const datasetPath = parsed.dataset ?? overrides.bundledDatasetPath ?? BUNDLED_DATASET;
  let dataset: PassKDataset;
  try {
    dataset = parsePassKDataset(readFile(datasetPath), path.basename(datasetPath));
  } catch {
    // Dataset contents and paths may be private; do not echo them.
    err('error: could not read or parse the pass^k dataset');
    return 1;
  }

  // repoPath snapshots: absolute paths stand alone; relative paths need
  // --repo-base, and a supplied base confines every snapshot beneath it
  // (swe-bench stance).
  const base = parsed.repoBase !== undefined ? path.resolve(parsed.repoBase) : undefined;
  for (const task of dataset.tasks) {
    if (task.repoPath === undefined) continue;
    if (!path.isAbsolute(task.repoPath)) {
      if (base === undefined) {
        err('error: a task repoPath is relative — supply --repo-base to resolve it');
        return 1;
      }
      task.repoPath = path.resolve(base, task.repoPath);
    }
    const resolved = path.resolve(task.repoPath);
    if (base !== undefined && resolved !== base && !resolved.startsWith(base + path.sep)) {
      err('error: a task repoPath escapes --repo-base');
      return 1;
    }
  }

  const laneSpecs = parsed.lanes.length > 0 ? parsed.lanes : [...DEFAULT_LANES];

  // When every lane is the local family, probe once — an all-error run
  // against a dead local provider would publish a false regression baseline.
  if (laneSpecs.every((l) => l.model === 'local-coder')) {
    const probe = overrides.localProviderUp ?? defaultLocalProviderUp;
    if (!(await probe())) {
      const msg = 'eval passk needs a local model — start Ollama or LM Studio, then re-run `phm eval passk`.';
      if (parsed.json) out(JSON.stringify({ skipped: true, reason: msg }));
      else err(`eval passk skipped: ${msg}`);
      return 0;
    }
  }

  const lanes: EvalLane[] = laneSpecs.map((spec) => ({
    lane: spec.lane,
    model: spec.model,
    runner: overrides.runnerFor?.(spec.lane, spec.model) ?? buildDefaultRunner(spec.model),
  }));

  // Baseline resolution — an explicit --baseline file wins over the most
  // recent persisted report (swe-bench stance).
  let prior: PassKReport | undefined = loadLastPassKReport({ rootDir: overrides.rootDir });
  if (parsed.baseline !== undefined) {
    try {
      const raw = JSON.parse(readFile(parsed.baseline)) as PassKReport;
      if (raw?.schema !== 'eval.passk.v1' || !Array.isArray(raw.lanes)) throw new Error('bad shape');
      prior = raw;
    } catch {
      err('error: could not read the baseline report');
      return 1;
    }
  }

  const trials = parsed.trials ?? PASSK_DEFAULT_TRIALS;
  // k can never exceed trials; an explicit --k > --trials is a usage error,
  // but the default simply clamps down so `--trials 1` still runs.
  const k = parsed.k ?? Math.min(PASSK_DEFAULT_K, trials);
  let report: PassKReport;
  try {
    report = await runPassKEval(dataset, lanes, {
      trials,
      k,
      limit: parsed.limit,
      nowMs: overrides.nowMs,
    });
  } catch (error) {
    err(`error: ${(error as Error).message}`);
    return 1;
  }
  report.alerts = prior ? derivePassKAlerts(prior, report) : [];

  // Publish: report, latest pointer, lane-scores projection, alerts journal.
  let published: { reportPath: string; scoresPath: string };
  try {
    published = publishPassKReport(report, { rootDir: overrides.rootDir });
  } catch {
    err('error: could not publish the report');
    return 1;
  }

  if (parsed.write !== undefined) {
    try {
      (overrides.writeFile ?? writeFileSync)(parsed.write, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      err('error: could not write the report file');
      return 1;
    }
  }

  if (parsed.json) {
    out(JSON.stringify({
      report,
      published: {
        report: published.reportPath,
        scores: published.scoresPath,
        alerts: passkAlertsPath({ rootDir: overrides.rootDir }),
        dir: passkDir({ rootDir: overrides.rootDir }),
        laneScores: laneScoresPath({ rootDir: overrides.rootDir }),
      },
    }, null, 2));
  } else {
    renderReport(report);
    console.log(`  ${dim('report saved:')} ${published.reportPath}`);
    console.log(`  ${dim('lane-scores:')} ${published.scoresPath}`);
    console.log('');
  }

  if (parsed.gate) {
    if (!prior) {
      err(yellow('gate: ') + 'no baseline yet — this report seeds it (pass)');
      return 0;
    }
    if (report.alerts.length > 0) {
      err(red('gate: REGRESSED') + ` (${report.alerts.length} alert(s))`);
      return 3;
    }
    err(green('gate: PASS'));
  }
  return 0;
}
