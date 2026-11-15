import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { scrubSecrets } from '../util/scrub.js';

export type EvalOutcome = 'merged' | 'aborted' | 'empty';
export interface EvalRecord { job: string; lane: string; model: string; outcome: EvalOutcome }
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v) && scrubSecrets(v) === v;
export const defaultEvalStore = () => join(homedir(), '.ashlr-runs', 'metrics', 'output-eval.json');

// Dispatcher-vocabulary terminal rows use event 'outcome' with state MERGED|
// CLOSED|OPEN; the metrics-outcomes reconciler appends the same evidence
// without an event field, marked only by source + outcome/status.
const OUTCOME_EVENTS = new Set(['outcome', 'result', 'resolved', 'resolution']);
const RECONCILER_SOURCE = 'metrics-outcomes-reconciler';

/** Join only uniquely attributed launches with terminal evidence. Job IDs must identify attempts. */
export function foldOutputEval(text: string): { records: EvalRecord[]; excluded: number } {
  const jobs = new Map<string, { launches: Set<string>; launchCount: number; outcomes: Set<EvalOutcome> }>();
  for (const line of text.split('\n')) {
    let row: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue; row = parsed as Record<string, unknown>; } catch { continue; }
    const id = row.job ?? row.job_id ?? row.jobId;
    if (!token(id)) continue;
    const event = typeof row.event === 'string' ? row.event.toLowerCase() : '';
    const isLaunch = event === 'launch';
    const phase = typeof (row.state ?? row.outcome ?? row.status) === 'string' ? String(row.state ?? row.outcome ?? row.status).toLowerCase() : '';
    const terminalRow = OUTCOME_EVENTS.has(event) || row.source === RECONCILER_SOURCE;
    const outcome: EvalOutcome | null = terminalRow && phase === 'merged' ? 'merged'
      : event === 'finish' && row.empty === true ? 'empty'
      : (terminalRow && ['aborted', 'abort'].includes(phase)) || (typeof row.class === 'string' && /^abort_[a-z0-9_]+$/.test(row.class)) ? 'aborted' : null;
    if (!isLaunch && !outcome) continue;
    const job = jobs.get(id) ?? { launches: new Set<string>(), launchCount: 0, outcomes: new Set<EvalOutcome>() };
    if (isLaunch) {
      job.launchCount++;
      job.launches.add(token(row.lane) && token(row.model) ? JSON.stringify([row.lane, row.model]) : 'invalid');
    }
    if (outcome) job.outcomes.add(outcome);
    jobs.set(id, job);
  }
  const records: EvalRecord[] = [];
  let excluded = 0;
  for (const [job, data] of jobs) {
    // A relaunch reuses the job id for a new attempt: count launch rows, not
    // distinct lane/model pairs, so repeated attempts stay ambiguous.
    if (data.launchCount !== 1 || data.launches.has('invalid') || data.outcomes.size !== 1) { excluded++; continue; }
    const [lane, model] = JSON.parse([...data.launches][0]!) as [string, string];
    records.push({ job, lane, model, outcome: [...data.outcomes][0]! });
  }
  records.sort((a, b) => a.job.localeCompare(b.job));
  return { records, excluded };
}

/** Replace a derived snapshot atomically; source text and unrecognized fields are never stored. */
export async function recordOutputEval(jobsPath: string, storePath = defaultEvalStore()) {
  if (resolve(jobsPath) === resolve(storePath)) throw new Error('source and store must differ');
  const folded = foldOutputEval(await readFile(jobsPath, 'utf8'));
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  const tmp = `${storePath}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ schema: 'fleet.output-eval.store.v1', records: folded.records }) + '\n'); await file.sync(); } finally { await file.close(); }
    await rename(tmp, storePath);
  } finally { await unlink(tmp).catch(() => undefined); }
  return { recorded: folded.records.length, excluded: folded.excluded };
}

export async function reportOutputEval(storePath = defaultEvalStore()) {
  const data: unknown = JSON.parse(await readFile(storePath, 'utf8'));
  if (!data || typeof data !== 'object' || !('schema' in data) || data.schema !== 'fleet.output-eval.store.v1' || !('records' in data) || !Array.isArray(data.records)) throw new Error('invalid store');
  const lanes = new Map<string, { lane: string; model: string; merged: number; aborted: number; empty: number }>();
  const ids = new Set<string>();
  for (const raw of data.records as unknown[]) {
    if (!raw || typeof raw !== 'object') throw new Error('invalid store');
    const r = raw as Record<string, unknown>;
    if (!token(r.job) || !token(r.lane) || !token(r.model) || !['merged', 'aborted', 'empty'].includes(String(r.outcome)) || ids.has(r.job)) throw new Error('invalid store');
    ids.add(r.job);
    const key = JSON.stringify([r.lane, r.model]);
    const group = lanes.get(key) ?? { lane: r.lane, model: r.model, merged: 0, aborted: 0, empty: 0 };
    group[r.outcome as EvalOutcome]++; lanes.set(key, group);
  }
  const models = [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane) || a.model.localeCompare(b.model));
  const totals = new Map<string, { lane: string; merged: number; aborted: number; empty: number }>();
  for (const row of models) {
    const lane = totals.get(row.lane) ?? { lane: row.lane, merged: 0, aborted: 0, empty: 0 };
    lane.merged += row.merged; lane.aborted += row.aborted; lane.empty += row.empty; totals.set(row.lane, lane);
  }
  const rate = <T extends { merged: number; aborted: number; empty: number }>(row: T) => {
    const total = row.merged + row.aborted + row.empty;
    return { ...row, total, mergeRate: row.merged / total };
  };
  return { schema: 'fleet.output-eval.report.v1', lanes: [...totals.values()].map(rate), models: models.map(rate) };
}
