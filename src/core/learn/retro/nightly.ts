/** Nightly local mining only. No model, provider, queue, git or network calls. */
import { deriveNightlyImprovements } from '../../fleet/self-improve.js';
import { extractNightlyJob, extractNightlyReview } from './extract.js';
import { NIGHTLY_MAX_RECORDS, readNightlyInputs, updateNightlyState } from './store.js';
import type { NightlyJob, NightlyReview } from './nightly-types.js';

export interface NightlyRetroResult {
  status: 'disabled' | 'not-due' | 'busy' | 'completed' | 'unavailable';
  jobs: number;
  reviews: number;
  proposals: number;
}

/** Latest observation per repository + ID, independent of JSONL order or rotation. */
function reconcile<T extends NightlyJob | NightlyReview>(old: T[], incoming: T[], nowMs: number): T[] {
  const records = new Map<string, T>();
  // Detect conflicts even among superseded rows, rather than depend on file order.
  const versions = new Map<string, string>();
  for (const row of [...old, ...incoming]) {
    if (Date.parse(row.updatedAt) > nowMs) throw new Error('Future nightly observation');
    const key = JSON.stringify([row.repo, row.id]);
    const version = JSON.stringify([key, row.updatedAt]);
    const bytes = JSON.stringify(row);
    if (versions.has(version) && versions.get(version) !== bytes) throw new Error('Conflicting nightly observation');
    versions.set(version, bytes);
    const prior = records.get(key);
    if (!prior || row.updatedAt > prior.updatedAt) records.set(key, row);
  }
  if (records.size > NIGHTLY_MAX_RECORDS) throw new Error('Nightly retention bound exceeded');
  return [...records.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

/**
 * Once per UTC day after 02:00. A missed night catches up on the next eligible
 * tick. The completion receipt shares the atomic proposal file, so a retry
 * cannot count a terminal job twice or lose half of a write-back.
 */
export async function runNightlyRetro(cfg: unknown, nowMs = Date.now()): Promise<NightlyRetroResult> {
  const empty = { jobs: 0, reviews: 0, proposals: 0 };
  if (!cfg || typeof cfg !== 'object' || (cfg as { foundry?: { selfImprove?: unknown } }).foundry?.selfImprove !== true) {
    return { status: 'disabled', ...empty };
  }
  if (!Number.isFinite(nowMs)) return { status: 'unavailable', ...empty };
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) return { status: 'unavailable', ...empty };
  if (now.getUTCHours() < 2) return { status: 'not-due', ...empty };
  const night = now.toISOString().slice(0, 10);
  let counts = empty;
  try {
    const status = await updateNightlyState(async (state) => {
      const oldJobs = reconcile([], (state?.jobs ?? []).map(extractNightlyJob), nowMs);
      const oldReviews = reconcile([], (state?.reviews ?? []).map((r) => extractNightlyReview(r, true)), nowMs);
      if (state) {
        const completed = new Date(`${state.completedNight}T00:00:00.000Z`);
        if (!Number.isFinite(completed.getTime()) || completed.toISOString().slice(0, 10) !== state.completedNight || state.completedNight > night) {
          throw new Error('Invalid completed night');
        }
        const expected = deriveNightlyImprovements(oldJobs, oldReviews);
        if (JSON.stringify(expected) !== JSON.stringify({ priors: state.priors, lessons: state.lessons, proposals: state.proposals })) {
          throw new Error('Inconsistent nightly state');
        }
        if (state.completedNight >= night) return null;
      }
      const input = await readNightlyInputs();
      const jobs = reconcile(oldJobs, input.jobs.map(extractNightlyJob), nowMs);
      const reviews = reconcile(oldReviews, input.reviews.map((r) => extractNightlyReview(r)), nowMs);
      const improvements = deriveNightlyImprovements(jobs, reviews);
      counts = { jobs: jobs.length, reviews: reviews.length, proposals: improvements.proposals.length };
      return { v: 1, advisoryOnly: true, completedNight: night, jobs, reviews, ...improvements };
    });
    return { status, ...(status === 'completed' ? counts : empty) };
  } catch {
    // Do not log input text or error messages that could contain private data.
    return { status: 'unavailable', ...empty };
  }
}
