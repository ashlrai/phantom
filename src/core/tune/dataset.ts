/** Offline, proposal-only training data. Inputs are untrusted, never commands. */
import { createHash } from 'node:crypto';
import { scrubPrivateText } from '../util/scrub.js';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface TuneSample {
  jobId: string;
  task: string;
  mergedDiff: string;
  mergeSha: string;
  mergedAt: string;
  rejectedLocalDiff?: string;
  review: { model: 'codex' | 'claude'; verdict: 'approve'; critique: string; contentHash: string };
}
export interface TuneDataset {
  v: 1;
  train: unknown[];
  valid: unknown[];
  test: unknown[];
  preferences: unknown[];
  manifest: { accepted: number; dropped: number; trainIds: string[]; validIds: string[]; testIds: string[] };
}
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200_000;
/** Review must bind all training content; a subsequent edit invalidates approval. */
export function sampleHash(s: Pick<TuneSample, 'jobId' | 'task' | 'mergedDiff' | 'mergeSha' | 'mergedAt' | 'rejectedLocalDiff'>): string {
  return digest(JSON.stringify([s.jobId, s.task, s.mergedDiff, s.mergeSha, s.mergedAt, s.rejectedLocalDiff ?? null]));
}
function sample(value: unknown): value is TuneSample {
  if (!record(value) || !['jobId', 'task', 'mergedDiff', 'mergeSha', 'mergedAt'].every(k => text(value[k]))) return false;
  if (!/^[a-f0-9]{40}$/.test(String(value['mergeSha'])) || !Number.isFinite(Date.parse(String(value['mergedAt'])))) return false;
  if (value['rejectedLocalDiff'] !== undefined && !text(value['rejectedLocalDiff'])) return false;
  const r = value['review'];
  return record(r) && ['codex', 'claude'].includes(String(r['model'])) && r['verdict'] === 'approve' && text(r['critique']) &&
    r['contentHash'] === sampleHash(value as unknown as TuneSample);
}
/** check must invoke the operator's scrub.pl --check, returning true only on exit 0. */
export async function prepareDataset(values: unknown[], check: (text: string) => Promise<boolean>): Promise<TuneDataset> {
  if (values.length > 10_000) throw new Error('Tune record bound exceeded');
  const accepted: TuneSample[] = [];
  const seen = new Set<string>();
  const tasks = new Set<string>();
  for (const value of values) {
    if (!sample(value)) continue;
    // Serialize an allowlist: extra metadata can never reach training or scanner logs.
    const candidate: TuneSample = {
      jobId: value.jobId, task: value.task, mergedDiff: value.mergedDiff,
      mergeSha: value.mergeSha, mergedAt: value.mergedAt,
      ...(value.rejectedLocalDiff === undefined ? {} : { rejectedLocalDiff: value.rejectedLocalDiff }),
      review: { model: value.review.model, verdict: 'approve', critique: value.review.critique, contentHash: value.review.contentHash },
    };
    const raw = JSON.stringify([candidate.jobId, candidate.task, candidate.mergedDiff, candidate.rejectedLocalDiff ?? null, candidate.review.critique]);
    if (scrubPrivateText(raw) !== raw || !await check(raw)) continue;
    const taskHash = digest(candidate.task.trim());
    if (seen.has(candidate.jobId) || tasks.has(taskHash)) continue;
    seen.add(candidate.jobId); tasks.add(taskHash); accepted.push(candidate);
  }
  // Recent tasks are held out as entire groups, never random diff fragments.
  accepted.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt) || a.jobId.localeCompare(b.jobId));
  if (accepted.length < 5) throw new Error('Need at least five clean reviewed task groups');
  const holdout = Math.max(1, Math.floor(accepted.length * 0.2));
  const train = accepted.slice(0, -2 * holdout);
  const valid = accepted.slice(-2 * holdout, -holdout);
  const test = accepted.slice(-holdout);
  const messages = (s: TuneSample) => ({ messages: [{ role: 'user', content: s.task }, { role: 'assistant', content: s.mergedDiff }] });
  return {
    v: 1, train: train.map(messages), valid: valid.map(messages), test: test.map(messages),
    preferences: train.filter(s => s.rejectedLocalDiff).map(s => ({ prompt: s.task, chosen: s.mergedDiff, rejected: s.rejectedLocalDiff, critique: s.review.critique })),
    manifest: { accepted: accepted.length, dropped: values.length - accepted.length,
      trainIds: train.map(s => digest(s.jobId)), validIds: valid.map(s => digest(s.jobId)), testIds: test.map(s => digest(s.jobId)) },
  };
}
