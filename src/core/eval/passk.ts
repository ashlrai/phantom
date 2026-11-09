/**
 * passk.ts — RQ-SWE5-PASSK-EVAL (research digest item 4): the pass^k offline
 * eval suite.
 *
 * EVALHARNESS-1 (agent-output.ts) scores ONE attempt per golden task per
 * lane/model. This suite runs the pinned golden set N times per task —
 * each trial in a fresh clean workspace — so per-lane reliability can be
 * measured, not just single-shot skill:
 *
 *   - pass@1   — per-trial pass fraction c/n (Wilson 95% interval).
 *   - pass@k   — probability that at least one of k independent trials
 *                passes; the standard unbiased estimator
 *                1 - C(n-c, k) / C(n, k) evaluated as a stable product.
 *   - pass^k   — probability that ALL k trials pass, (c/n)^k; the
 *                consistency figure Anthropic's eval guidance recommends
 *                for work that must be reproducible, not lucky.
 *
 * A trial passes when the engine's patch resolves the task's gold test
 * command (the `tests` dimension from EVALHARNESS-1); the diffQuality and
 * instructions dimensions are still recorded per trial and drive the
 * regression alerts.
 *
 * Honesty stance (same as router-eval): a trial that never ran, failed to
 * apply, or errored is a failed trial — never estimated or credited. Alerts
 * compare only (lane, model, task) triples present in both reports; a new
 * lane or a dropped task is reported, never silently ignored. Nothing here
 * merges, routes with authority or releases credit — the lane-scores
 * projection is advisory evidence for `ashlr router rank`.
 *
 * Publishing: each run persists the report under
 * `~/.ashlr/eval/passk/reports/`, an atomic `latest.json` pointer, the
 * `lane-scores.json` projection routing reads, and appends any regression
 * alerts to `alerts.jsonl` (bounded). `phm eval passk schedule` installs
 * the nightly per-user timer through the shared dailyUserSchedule machinery
 * (the same one steward and disk-maint use).
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import { scoreGoldenOutput, type EvalLane } from './agent-output.js';
import { wilsonInterval } from './router-eval.js';
import { applyDiff, cleanupDir, isSafeTestCommand, isolateRepo, runTests, type EngineRunner } from './swe-bench.js';

// ---------------------------------------------------------------------------
// Dataset schema (eval.passk.v1)
// ---------------------------------------------------------------------------

export const PASSK_DATASET_SCHEMA = 'eval.passk.v1' as const;
export const PASSK_REPORT_SCHEMA = 'eval.passk.v1' as const;
export const LANE_SCORES_SCHEMA = 'eval.lane-scores.v1' as const;
export const PASSK_ALERT_SCHEMA = 'eval.passk-alert.v1' as const;

/** Bounds on inline `files` snapshots — a dataset is operator-supplied input. */
export const PASSK_MAX_TASK_FILES = 64;
export const PASSK_MAX_FILE_BYTES = 128 * 1024;
const MAX_ID_LEN = 128;

/**
 * A golden task: either a staged repo snapshot (`repoPath`, copied per
 * attempt like swe-bench) or a self-contained inline `files` snapshot
 * materialized fresh per attempt. Both give every trial a clean worktree.
 */
export interface PassKTask {
  id: string;
  problemStatement: string;
  /** Absolute path to a staged repo snapshot; copied per trial. */
  repoPath?: string;
  /** Inline snapshot written fresh per trial (relative path -> contents). */
  files?: Record<string, string>;
  goldTestCommand: string;
  failToPassTests: string[];
  required: string[];
  forbidden: string[];
  maxChangedLines: number;
}

export interface PassKDatasetMeta {
  id?: string;
  note?: string;
}

export interface PassKDataset {
  meta: PassKDatasetMeta;
  tasks: PassKTask[];
  /** sha256 of the exact source text — the baseline's integrity anchor. */
  sha256: string;
}

function fail(file: string, line: number, why: string): never {
  throw new Error(`${file}:${line}: ${why}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function reqString(file: string, line: number, rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== 'string' || v === '') fail(file, line, `${key} must be a non-empty string`);
  return v;
}

function optString(file: string, line: number, rec: Record<string, unknown>, key: string): string | undefined {
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(file, line, `bad ${key}`);
  return v;
}

function stringList(file: string, line: number, rec: Record<string, unknown>, key: string): string[] {
  const v = rec[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    fail(file, line, `${key} must be a string array`);
  }
  return v as string[];
}

/**
 * An inline-snapshot file key must be a relative POSIX-ish path that resolves
 * strictly inside the workspace — no absolute paths, no traversal, no control
 * characters, no backslashes (which split differently per platform).
 */
function validFileKey(key: string): boolean {
  if (key === '' || key.length > 512) return false;
  if ([...key].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
  if (path.isAbsolute(key) || key.includes('\\') || key.startsWith('/')) return false;
  const parts = key.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  return true;
}

function parseTaskFiles(file: string, line: number, value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const rec = asRecord(value);
  if (!rec) fail(file, line, 'files must be an object');
  const entries = Object.entries(rec);
  if (entries.length === 0 || entries.length > PASSK_MAX_TASK_FILES) {
    fail(file, line, `files must carry 1..${PASSK_MAX_TASK_FILES} entries`);
  }
  const files: Record<string, string> = {};
  for (const [key, content] of entries) {
    if (!validFileKey(key)) fail(file, line, `files key ${JSON.stringify(key)} is not a safe relative path`);
    if (typeof content !== 'string') fail(file, line, `files.${key} must be a string`);
    if (Buffer.byteLength(content, 'utf8') > PASSK_MAX_FILE_BYTES) {
      fail(file, line, `files.${key} exceeds ${PASSK_MAX_FILE_BYTES} bytes`);
    }
    files[key] = content;
  }
  return files;
}

/**
 * Parse an eval.passk.v1 dataset. Malformed input throws with file:line —
 * the pinned golden set must be exactly what was checked in, never silently
 * fewer tasks than were written.
 */
export function parsePassKDataset(text: string, file = 'golden-tasks.jsonl'): PassKDataset {
  let meta: PassKDatasetMeta = {};
  let seenMeta = false;
  const tasks: PassKTask[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(raw);
    } catch {
      fail(file, i + 1, 'not JSON');
    }
    if (rec!.v !== 1) fail(file, i + 1, `unsupported v ${JSON.stringify(rec!.v)}`);
    if (rec!.kind === 'meta') {
      if (tasks.length > 0) fail(file, i + 1, 'meta must precede task lines');
      if (seenMeta) fail(file, i + 1, 'duplicate meta line');
      seenMeta = true;
      meta = {
        id: optString(file, i + 1, rec!, 'id'),
        note: optString(file, i + 1, rec!, 'note'),
      };
      continue;
    }
    if (rec!.kind !== undefined && rec!.kind !== 'task') fail(file, i + 1, `unknown kind ${JSON.stringify(rec!.kind)}`);
    const id = reqString(file, i + 1, rec!, 'id');
    if (id.length > MAX_ID_LEN) fail(file, i + 1, 'id too long');
    if (seen.has(id)) fail(file, i + 1, `duplicate id ${id}`);
    seen.add(id);
    const problemStatement = reqString(file, i + 1, rec!, 'problemStatement');
    const goldTestCommand = reqString(file, i + 1, rec!, 'goldTestCommand');
    if (!isSafeTestCommand(goldTestCommand)) {
      fail(file, i + 1, 'goldTestCommand is not a safe test-runner command');
    }
    const files = parseTaskFiles(file, i + 1, rec!.files);
    const repoPath = optString(file, i + 1, rec!, 'repoPath');
    if (files !== undefined && repoPath !== undefined) {
      fail(file, i + 1, 'task carries both files and repoPath — pick one snapshot');
    }
    if (files === undefined && repoPath === undefined) {
      fail(file, i + 1, 'task needs a snapshot: files or repoPath');
    }
    const maxChangedLines = rec!['maxChangedLines'];
    if (typeof maxChangedLines !== 'number' || !Number.isSafeInteger(maxChangedLines) || maxChangedLines < 1) {
      fail(file, i + 1, 'maxChangedLines must be a positive integer');
    }
    tasks.push({
      id,
      problemStatement,
      ...(repoPath !== undefined ? { repoPath } : {}),
      ...(files !== undefined ? { files } : {}),
      goldTestCommand,
      failToPassTests: stringList(file, i + 1, rec!, 'failToPassTests'),
      required: stringList(file, i + 1, rec!, 'required'),
      forbidden: stringList(file, i + 1, rec!, 'forbidden'),
      maxChangedLines,
    });
  }
  if (tasks.length === 0) fail(file, 0, 'dataset carries no tasks');
  return { meta, tasks, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

// ---------------------------------------------------------------------------
// pass@k / pass^k estimators
// ---------------------------------------------------------------------------

/**
 * Unbiased pass@k estimator: the probability that at least one of k draws
 * from n trials passes, 1 - C(n-c, k) / C(n, k), evaluated as the stable
 * product 1 - prod_i (n-c-i)/(n-i). Returns null when k is outside [1, n].
 */
export function passAtK(trials: number, passes: number, k: number): number | null {
  if (!Number.isSafeInteger(trials) || !Number.isSafeInteger(passes) || !Number.isSafeInteger(k)) return null;
  if (trials < 1 || passes < 0 || passes > trials || k < 1 || k > trials) return null;
  if (passes >= trials) return 1;
  let product = 1;
  for (let i = 0; i < k; i++) {
    product *= (trials - passes - i) / (trials - i);
  }
  return 1 - product;
}

/** pass^k — the probability that ALL k independent trials pass: (c/n)^k. */
export function passPowK(trials: number, passes: number, k: number): number | null {
  if (!Number.isSafeInteger(trials) || !Number.isSafeInteger(passes) || !Number.isSafeInteger(k)) return null;
  if (trials < 1 || passes < 0 || passes > trials || k < 1) return null;
  return Math.pow(passes / trials, k);
}

// ---------------------------------------------------------------------------
// Workspace materialization — every trial gets a clean worktree
// ---------------------------------------------------------------------------

/** Materialize a task's snapshot into a fresh temp dir. Caller removes it. */
export function materializeTaskWorkspace(task: PassKTask): string {
  if (task.repoPath !== undefined) return isolateRepo(task.repoPath);
  const dir = mkdtempSync(path.join(tmpdir(), 'ashlr-passk-'));
  try {
    for (const [key, content] of Object.entries(task.files ?? {})) {
      if (!validFileKey(key)) throw new Error(`unsafe files key ${JSON.stringify(key)}`);
      const target = path.resolve(dir, key);
      if (!target.startsWith(dir + path.sep)) throw new Error(`files key escapes workspace: ${key}`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
  } catch (err) {
    cleanupDir(dir);
    throw err;
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Trial runner + report
// ---------------------------------------------------------------------------

export const PASSK_DEFAULT_TRIALS = 8;
export const PASSK_DEFAULT_K = 4;
export const PASSK_MAX_TRIALS = 64;

/** One measured attempt in its own clean workspace. */
export interface PassKTrial {
  trial: number;
  /** Gold test resolved with a non-empty, error-free patch. */
  pass: boolean;
  resolved: boolean;
  diffQuality: boolean;
  instructions: boolean;
  durationMs: number;
  error?: string;
}

export interface PassKTaskReport {
  taskId: string;
  trials: number;
  passes: number;
  pass1: number;
  /** Wilson 95% interval on pass1. */
  ci95: [number, number] | null;
  passAtK: number | null;
  passPowK: number | null;
  /** Fraction of trials scoring each EVALHARNESS-1 dimension. */
  dimensionRates: { tests: number; diffQuality: number; instructions: number };
  trialsDetail: PassKTrial[];
}

export interface PassKLaneReport {
  lane: string;
  model: string;
  tasks: PassKTaskReport[];
  trialsTotal: number;
  passesTotal: number;
  /** Mean per-task pass1 across the lane's tasks. */
  meanPass1: number;
  /** Mean per-task pass@k and pass^k (null when k exceeded every task's n). */
  meanPassAtK: number | null;
  meanPassPowK: number | null;
}

/** A regression alert derived by comparing two reports. */
export type PassKAlertKind = 'task-regressed' | 'passk-drop' | 'dimension-drop';

export interface PassKAlert {
  kind: PassKAlertKind;
  lane: string;
  model: string;
  taskId?: string;
  dimension?: 'tests' | 'diffQuality' | 'instructions';
  before: number;
  after: number;
}

export interface PassKReport {
  schema: typeof PASSK_REPORT_SCHEMA;
  id: string;
  generatedAt: string;
  dataset: { id?: string; sha256: string; tasks: number };
  /** N trials per task. */
  trials: number;
  /** The k used for pass@k / pass^k. */
  k: number;
  lanes: PassKLaneReport[];
  /** Alerts derived against the prior report at publish time. */
  alerts: PassKAlert[];
}

export interface PassKRunOptions {
  /** Trials per task per lane. Default PASSK_DEFAULT_TRIALS. */
  trials?: number;
  /** The k for pass@k / pass^k. Default PASSK_DEFAULT_K. */
  k?: number;
  /** Slice the task set (smoke runs). */
  limit?: number;
  nowMs?: () => number;
}

async function runTaskTrials(
  task: PassKTask,
  model: string,
  runner: EngineRunner,
  trials: number,
  k: number,
): Promise<PassKTaskReport> {
  const detail: PassKTrial[] = [];
  for (let t = 0; t < trials; t++) {
    const started = Date.now();
    const workDir = materializeTaskWorkspace(task);
    let diff = '';
    let resolved = false;
    let error: string | undefined;
    try {
      diff = await runner(task.problemStatement, workDir, model);
      const applied = applyDiff(diff, workDir);
      if (applied === 'traversal-rejected') {
        error = 'patch path traversal rejected';
      } else if (!applied) {
        error = diff.trim() === '' ? 'no patch produced' : 'patch application failed';
      } else {
        resolved = runTests(task.goldTestCommand, workDir).ok;
        if (!resolved && diff.trim() === '') error = 'no patch produced';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      cleanupDir(workDir);
    }
    // scoreGoldenOutput treats an empty diff as invalid; fold the harness's
    // own rejection reasons into the per-trial error field so they surface.
    const scored = scoreGoldenOutput(task, diff, resolved, error);
    detail.push({
      trial: t,
      pass: scored.tests,
      resolved,
      diffQuality: scored.diffQuality,
      instructions: scored.instructions,
      durationMs: Math.max(0, Date.now() - started),
      ...(error ? { error } : {}),
    });
  }
  const passes = detail.filter((d) => d.pass).length;
  const dim = (key: 'tests' | 'diffQuality' | 'instructions'): number =>
    detail.filter((d) => (key === 'tests' ? d.pass : d[key])).length / detail.length;
  return {
    taskId: task.id,
    trials: detail.length,
    passes,
    pass1: passes / detail.length,
    ci95: wilsonInterval(passes, detail.length),
    passAtK: passAtK(detail.length, passes, k),
    passPowK: passPowK(detail.length, passes, k),
    dimensionRates: { tests: dim('tests'), diffQuality: dim('diffQuality'), instructions: dim('instructions') },
    trialsDetail: detail,
  };
}

/**
 * Run the golden set N times per task per lane/model, every trial in a fresh
 * workspace. Sequential — keeps model usage and workspace isolation
 * predictable, exactly like evaluateOutputs.
 */
export async function runPassKEval(
  dataset: PassKDataset,
  lanes: EvalLane[],
  opts: PassKRunOptions = {},
): Promise<PassKReport> {
  const trials = opts.trials ?? PASSK_DEFAULT_TRIALS;
  const k = opts.k ?? PASSK_DEFAULT_K;
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > PASSK_MAX_TRIALS) {
    throw new Error(`trials must be an integer 1..${PASSK_MAX_TRIALS}`);
  }
  if (!Number.isSafeInteger(k) || k < 1 || k > trials) {
    throw new Error('k must be an integer 1..trials');
  }
  if (!lanes.length) throw new Error('at least one lane is required');
  if (lanes.some((l) => !l.lane || !l.model)
    || new Set(lanes.map((l) => JSON.stringify([l.lane, l.model]))).size !== lanes.length) {
    throw new Error('invalid or duplicate lane/model');
  }
  const tasks = opts.limit != null ? dataset.tasks.slice(0, opts.limit) : dataset.tasks;
  const laneReports: PassKLaneReport[] = [];
  for (const lane of lanes) {
    const taskReports: PassKTaskReport[] = [];
    for (const task of tasks) {
      taskReports.push(await runTaskTrials(task, lane.model, lane.runner, trials, k));
    }
    const trialsTotal = taskReports.reduce((s, t) => s + t.trials, 0);
    const passesTotal = taskReports.reduce((s, t) => s + t.passes, 0);
    const meanOf = (key: 'pass1' | 'passAtK' | 'passPowK'): number | null => {
      const values = taskReports.map((t) => t[key]).filter((v): v is number => v !== null);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    laneReports.push({
      lane: lane.lane,
      model: lane.model,
      tasks: taskReports,
      trialsTotal,
      passesTotal,
      meanPass1: meanOf('pass1') ?? 0,
      meanPassAtK: meanOf('passAtK'),
      meanPassPowK: meanOf('passPowK'),
    });
  }
  const nowMs = opts.nowMs?.() ?? Date.now();
  return {
    schema: PASSK_REPORT_SCHEMA,
    id: `passk-${nowMs.toString(36)}`,
    generatedAt: new Date(nowMs).toISOString(),
    dataset: {
      ...(dataset.meta.id !== undefined ? { id: dataset.meta.id } : {}),
      sha256: dataset.sha256,
      tasks: tasks.length,
    },
    trials,
    k,
    lanes: laneReports,
    alerts: [],
  };
}

// ---------------------------------------------------------------------------
// Regression alerts — publish-time comparison against the prior report
// ---------------------------------------------------------------------------

export const PASSK_ALERT_MIN_DROP = 0.10;

/**
 * Compare prior (a) and current (b) reports on their shared (lane, model,
 * task) observations. Three alert kinds:
 *   - task-regressed: a task that previously passed at least once now has
 *     zero passes — the lane lost a capability it had.
 *   - passk-drop: a lane's mean pass^k fell by at least minDrop.
 *   - dimension-drop: a lane/task dimension rate fell by at least minDrop.
 * Missing observations are never counted as failures.
 */
export function derivePassKAlerts(
  previous: PassKReport,
  current: PassKReport,
  opts: { minDrop?: number } = {},
): PassKAlert[] {
  const minDrop = opts.minDrop ?? PASSK_ALERT_MIN_DROP;
  const alerts: PassKAlert[] = [];
  for (const lane of current.lanes) {
    const old = previous.lanes.find((l) => l.lane === lane.lane && l.model === lane.model);
    if (!old) continue;
    if (old.meanPassPowK !== null && lane.meanPassPowK !== null
      && old.meanPassPowK - lane.meanPassPowK >= minDrop) {
      alerts.push({ kind: 'passk-drop', lane: lane.lane, model: lane.model, before: old.meanPassPowK, after: lane.meanPassPowK });
    }
    for (const task of lane.tasks) {
      const before = old.tasks.find((t) => t.taskId === task.taskId);
      if (!before) continue;
      if (before.passes > 0 && task.passes === 0) {
        alerts.push({ kind: 'task-regressed', lane: lane.lane, model: lane.model, taskId: task.taskId, before: before.pass1, after: 0 });
      }
      for (const dimension of ['tests', 'diffQuality', 'instructions'] as const) {
        const drop = before.dimensionRates[dimension] - task.dimensionRates[dimension];
        if (drop >= minDrop) {
          alerts.push({ kind: 'dimension-drop', lane: lane.lane, model: lane.model, taskId: task.taskId, dimension, before: before.dimensionRates[dimension], after: task.dimensionRates[dimension] });
        }
      }
    }
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Persistence — ~/.ashlr/eval/passk/ (ASHLR_HOME honored)
// ---------------------------------------------------------------------------

export interface PassKStoreOptions {
  /** Override the ashlr root (tests); default ASHLR_HOME or ~/.ashlr. */
  rootDir?: string;
}

function ashlrRoot(rootDir: string | undefined): string {
  if (rootDir && rootDir.trim() !== '') return rootDir;
  const configuredHome = process.env.ASHLR_HOME;
  if (typeof configuredHome === 'string' && configuredHome.trim() !== '') return configuredHome;
  return path.join(homedir(), '.ashlr');
}

export function passkDir(opts: PassKStoreOptions = {}): string {
  return path.join(ashlrRoot(opts.rootDir), 'eval', 'passk');
}

export function passkReportsDir(opts: PassKStoreOptions = {}): string {
  return path.join(passkDir(opts), 'reports');
}

export function laneScoresPath(opts: PassKStoreOptions = {}): string {
  return path.join(passkDir(opts), 'lane-scores.json');
}

export function passkAlertsPath(opts: PassKStoreOptions = {}): string {
  return path.join(passkDir(opts), 'alerts.jsonl');
}

function passkLatestPath(opts: PassKStoreOptions = {}): string {
  return path.join(passkDir(opts), 'latest.json');
}

/** Atomic write (tmp + rename), same stance as the prompt-promotions store. */
function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

/**
 * Publish a report: persist reports/<id>.json, the atomic latest.json
 * pointer, the lane-scores projection, and append alerts to alerts.jsonl.
 * Returns the report file path.
 */
export function publishPassKReport(report: PassKReport, opts: PassKStoreOptions = {}): { reportPath: string; scoresPath: string } {
  const reportPath = path.join(passkReportsDir(opts), `${report.id}.json`);
  atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(passkLatestPath(opts), `${JSON.stringify({ schema: PASSK_REPORT_SCHEMA, id: report.id, generatedAt: report.generatedAt }, null, 2)}\n`);
  const scoresPath = laneScoresPath(opts);
  atomicWrite(scoresPath, `${JSON.stringify(laneScoresProjection(report), null, 2)}\n`);
  if (report.alerts.length > 0) {
    appendPassKAlerts(report.alerts, report, opts);
  }
  return { reportPath, scoresPath };
}

function isPassKReport(value: unknown): value is PassKReport {
  const rec = asRecord(value);
  return rec !== undefined && rec['schema'] === PASSK_REPORT_SCHEMA
    && typeof rec['id'] === 'string' && typeof rec['generatedAt'] === 'string'
    && Array.isArray(rec['lanes']) && Number.isSafeInteger(rec['trials'])
    && Number.isSafeInteger(rec['k']);
}

/** Load all persisted reports sorted by generatedAt ascending. */
export function loadPassKReports(opts: PassKStoreOptions = {}): PassKReport[] {
  const dir = passkReportsDir(opts);
  if (!existsSync(dir)) return [];
  const reports: PassKReport[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as unknown;
      if (isPassKReport(parsed)) reports.push(parsed);
    } catch {
      // skip malformed files
    }
  }
  return reports.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
}

/** Load the most recent persisted report (or undefined if none). */
export function loadLastPassKReport(opts: PassKStoreOptions = {}): PassKReport | undefined {
  return loadPassKReports(opts).at(-1);
}

// ---------------------------------------------------------------------------
// Lane-scores projection — the advisory feed lane routing reads
// ---------------------------------------------------------------------------

export interface LaneScoreRow {
  lane: string;
  model: string;
  tasks: number;
  trials: number;
  passes: number;
  pass1: number;
  ci95: [number, number] | null;
  passAtK: number | null;
  passPowK: number | null;
}

export interface LaneScores {
  schema: typeof LANE_SCORES_SCHEMA;
  generatedAt: string;
  reportId: string;
  k: number;
  trials: number;
  lanes: LaneScoreRow[];
}

/** Project a report into the routing-facing lane-scores shape. */
export function laneScoresProjection(report: PassKReport): LaneScores {
  return {
    schema: LANE_SCORES_SCHEMA,
    generatedAt: report.generatedAt,
    reportId: report.id,
    k: report.k,
    trials: report.trials,
    lanes: report.lanes.map((lane) => ({
      lane: lane.lane,
      model: lane.model,
      tasks: lane.tasks.length,
      trials: lane.trialsTotal,
      passes: lane.passesTotal,
      pass1: lane.trialsTotal === 0 ? 0 : lane.passesTotal / lane.trialsTotal,
      ci95: wilsonInterval(lane.passesTotal, lane.trialsTotal),
      passAtK: passAtK(lane.trialsTotal, lane.passesTotal, report.k),
      passPowK: passPowK(lane.trialsTotal, lane.passesTotal, report.k),
    })),
  };
}

export interface LaneScoresRead {
  state: 'healthy' | 'missing' | 'degraded';
  scores: LaneScores | null;
}

const MAX_LANE_SCORES_BYTES = 256 * 1024;

/**
 * Read the published lane-scores projection. Never throws: absent,
 * oversized or malformed input is state, not an exception — routing must
 * keep working when the eval has never run.
 */
export function readLaneScores(opts: PassKStoreOptions & { readFile?: (path: string) => string } = {}): LaneScoresRead {
  const file = laneScoresPath(opts);
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let text: string;
  try {
    text = readFile(file);
  } catch {
    return { state: 'missing', scores: null };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_LANE_SCORES_BYTES) return { state: 'degraded', scores: null };
  try {
    const parsed = asRecord(JSON.parse(text));
    if (!parsed || parsed['schema'] !== LANE_SCORES_SCHEMA || !Array.isArray(parsed['lanes'])
      || typeof parsed['reportId'] !== 'string' || !Number.isSafeInteger(parsed['k'])) {
      return { state: 'degraded', scores: null };
    }
    const k = parsed['k'] as number;
    const lanes = (parsed['lanes'] as unknown[]).map((raw): LaneScoreRow | null => {
      const row = asRecord(raw);
      if (!row || typeof row['lane'] !== 'string' || typeof row['model'] !== 'string'
        || typeof row['pass1'] !== 'number' || !Number.isFinite(row['pass1'])) return null;
      const num = (key: string): number | null => {
        const v = row[key];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
      };
      return {
        lane: row['lane'],
        model: row['model'],
        tasks: Number.isSafeInteger(row['tasks']) ? (row['tasks'] as number) : 0,
        trials: Number.isSafeInteger(row['trials']) ? (row['trials'] as number) : 0,
        passes: Number.isSafeInteger(row['passes']) ? (row['passes'] as number) : 0,
        pass1: row['pass1'],
        ci95: Array.isArray(row['ci95']) && row['ci95'].length === 2
          ? [row['ci95'][0], row['ci95'][1]] as [number, number]
          : null,
        passAtK: num('passAtK'),
        passPowK: num('passPowK'),
      };
    });
    if (lanes.some((l) => l === null)) return { state: 'degraded', scores: null };
    return {
      state: 'healthy',
      scores: {
        schema: LANE_SCORES_SCHEMA,
        generatedAt: typeof parsed['generatedAt'] === 'string' ? parsed['generatedAt'] : '',
        reportId: parsed['reportId'],
        k,
        trials: Number.isSafeInteger(parsed['trials']) ? (parsed['trials'] as number) : 0,
        lanes: lanes as LaneScoreRow[],
      },
    };
  } catch {
    return { state: 'degraded', scores: null };
  }
}

// ---------------------------------------------------------------------------
// Alerts journal — appended on publish, capped at PASSK_MAX_ALERT_LINES
// ---------------------------------------------------------------------------

export const PASSK_MAX_ALERT_LINES = 500;

export interface PassKAlertLine {
  v: 1;
  kind: 'alert';
  ts: string;
  report: string;
  alert: PassKAlert;
}

/** Append alert lines to alerts.jsonl, keeping the newest PASSK_MAX_ALERT_LINES. */
export function appendPassKAlerts(alerts: readonly PassKAlert[], report: PassKReport, opts: PassKStoreOptions = {}): void {
  if (alerts.length === 0) return;
  const file = passkAlertsPath(opts);
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = alerts.map((alert): string =>
    JSON.stringify({ v: 1, kind: 'alert', ts: report.generatedAt, report: report.id, alert } satisfies PassKAlertLine));
  appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  // Bound the journal: keep the newest lines when it exceeds the cap.
  try {
    const all = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    if (all.length > PASSK_MAX_ALERT_LINES) {
      atomicWrite(file, `${all.slice(-PASSK_MAX_ALERT_LINES).join('\n')}\n`);
    }
  } catch {
    // best-effort truncation only
  }
}

/** Read the alerts journal; malformed lines are counted, never thrown. */
export function loadPassKAlerts(opts: PassKStoreOptions = {}): { state: 'healthy' | 'missing' | 'degraded'; alerts: PassKAlertLine[]; dropped: number } {
  const file = passkAlertsPath(opts);
  if (!existsSync(file)) return { state: 'missing', alerts: [], dropped: 0 };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { state: 'missing', alerts: [], dropped: 0 };
  }
  const alerts: PassKAlertLine[] = [];
  let dropped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const rec = asRecord(JSON.parse(line));
      const alert = asRecord(rec?.['alert']);
      if (!rec || rec['v'] !== 1 || rec['kind'] !== 'alert' || typeof rec['ts'] !== 'string'
        || typeof rec['report'] !== 'string' || !alert
        || typeof alert['kind'] !== 'string' || typeof alert['lane'] !== 'string'
        || typeof alert['model'] !== 'string' || typeof alert['before'] !== 'number'
        || typeof alert['after'] !== 'number') {
        dropped++;
        continue;
      }
      alerts.push(rec as unknown as PassKAlertLine);
    } catch {
      dropped++;
    }
  }
  return { state: dropped > 0 ? 'degraded' : 'healthy', alerts, dropped };
}
