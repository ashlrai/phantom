/** Read-only identity projection. Jobs remain the only outcome ledger. */
import { join } from 'node:path';
import { journalSchema, orchestrationJournalPath, type OrchestrationJournal } from './orchestration-journal.js';
import { findSpecialist, loadSpecialistRoster, readSpecialistFile, type SpecialistRoster } from './roster.js';
import { readSource } from './runs-parked-queue.js';

export interface SpecialistMeasuredOutcomes {
  sourceState: 'healthy' | 'missing' | 'degraded';
  jobs: number;
  finished: number;
  merges: number;
  reverts: number;
  empty: number;
  failed: number;
  emptySamples: number;
  emptyRate: number | null;
  ignoredRows: number;
  ambiguousRows: number;
}

/** Counts distinct job/lane pairs, never receipts or repeated terminal rows.
 * Reused pairs assigned to multiple identities are deliberately unattributed.
 */
export function buildSpecialistIdentity(roster: SpecialistRoster, id: string, journal: OrchestrationJournal,
  events: readonly unknown[] | null, nowMs = Date.now()) {
  const specialist = findSpecialist(roster, id);
  if (!Number.isFinite(nowMs)) throw new Error('Invalid identity clock');
  const assignments = new Map<string, OrchestrationJournal['receipts']>();
  for (const receipt of journalSchema.parse(journal).receipts) {
    if (receipt.status === 'reserved') continue;
    const key = JSON.stringify([receipt.job, receipt.lane]);
    const rows = assignments.get(key) ?? [];
    rows.push(receipt); assignments.set(key, rows);
  }
  const byJob = new Map<string, Array<[string, OrchestrationJournal['receipts']]>>();
  for (const entry of assignments) {
    const job = entry[1][0]!.job;
    const pairs = byJob.get(job) ?? [];
    pairs.push(entry); byJob.set(job, pairs);
  }
  const jobs = new Map<string, { finished: boolean; merged: boolean; reverted: boolean;
    failed: boolean; empty: Set<boolean> }>();
  let ignoredRows = 0, ambiguousRows = 0;
  for (const value of events ?? []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { ignoredRows++; continue; }
    const row = value as Record<string, unknown>;
    const event = row['event'] ?? (row['source'] === 'metrics-outcomes-reconciler' ? 'outcome' : undefined);
    if (!['launch', 'finish', 'outcome', 'merged', 'revert'].includes(event as string)) continue;
    const job = row['job'] ?? row['job_id'] ?? row['jobId'];
    const at = Date.parse(String(row['ts'] ?? row['timestamp'] ?? row['at'] ?? ''));
    if (typeof job !== 'string' || !Number.isFinite(at) || at > nowMs) { ignoredRows++; continue; }
    // Some outcome rows omit lane: use it only if the journal proves one pair.
    const candidates = (byJob.get(job) ?? []).filter(([, receipts]) =>
      row['lane'] === undefined || receipts[0]!.lane === row['lane']);
    if (!candidates.length) continue;
    const [key, receipts] = candidates[0]!;
    if (candidates.length !== 1 || new Set(receipts.map(r => r.specialist)).size !== 1
      || (row['specialist'] !== undefined && row['specialist'] !== receipts[0]!.specialist)) {
      ambiguousRows++; continue;
    }
    if (receipts[0]!.specialist !== id || !receipts.some(r => Date.parse(r.assignedAt) <= at)) continue;
    const observed = jobs.get(key) ?? { finished: false, merged: false, reverted: false, failed: false, empty: new Set<boolean>() };
    const outcome = String(row['state'] ?? row['outcome'] ?? row['status'] ?? '').toUpperCase();
    if (event === 'finish') {
      observed.finished = true;
      if (typeof row['empty'] === 'boolean') observed.empty.add(row['empty']);
      if (outcome === 'FAILED') observed.failed = true;
    }
    if (event === 'merged' || (event === 'outcome' && outcome === 'MERGED')) observed.merged = true;
    if (event === 'revert' || (event === 'outcome' && outcome === 'REVERTED')) observed.reverted = true;
    jobs.set(key, observed);
  }
  const rows = [...jobs.values()];
  const emptySamples = rows.filter(r => r.empty.size === 1).length;
  const empty = rows.filter(r => r.empty.size === 1 && r.empty.has(true)).length;
  const outcomes: SpecialistMeasuredOutcomes = {
    sourceState: events === null ? 'missing' : ignoredRows || ambiguousRows ? 'degraded' : 'healthy',
    jobs: rows.length, finished: rows.filter(r => r.finished).length,
    merges: rows.filter(r => r.merged).length, reverts: rows.filter(r => r.reverted).length,
    failed: rows.filter(r => r.failed).length, empty, emptySamples,
    emptyRate: emptySamples ? empty / emptySamples : null, ignoredRows, ambiguousRows,
  };
  const { stats: _legacyStats, ...identity } = specialist;
  return { schema: 'fleet.specialist-identity.v1' as const, specialist: identity, outcomes,
    authority: { coordinationOnly: true as const, execution: false as const, sends: false as const } };
}

export async function loadSpecialistIdentity(id: string, directory: string, jobsPath: string, nowMs = Date.now()) {
  const [roster, raw, source] = await Promise.all([loadSpecialistRoster(directory),
    readSpecialistFile(orchestrationJournalPath(directory)), readSource(jobsPath, 16 * 1024 * 1024, false)]);
  const journal = journalSchema.parse(raw === null ? { version: 1, receipts: [] } : JSON.parse(raw));
  const events = source.state === 'healthy' ? source.text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  }) : null;
  const result = buildSpecialistIdentity(roster, id, journal, events, nowMs);
  if (raw === null) result.outcomes.sourceState = 'missing';
  if (source.state === 'degraded') result.outcomes.sourceState = 'degraded';
  return { ...result, evidence: { jobs: source.state, assignments: raw === null ? 'missing' : 'healthy',
    scope: 'observed job/lane pairs with unambiguous admitted orchestration assignments' } };
}

export const defaultSpecialistJobsPath = (directory: string): string => join(directory, '../../metrics/jobs.jsonl');
