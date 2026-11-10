import { validateQueue, type QueueDocument, type QueueJob } from '../queue/schema.js';

/** A proposal score must come from the metrics producer, never inferred here. */
export interface RestockScore { id: string; impact: number }
export interface RestockPool { pool: string; freeSlots: number }
export interface RestockPlan { promotions: string[]; deficits: Record<string, number> }

const HOLDS = /\b(?:phantom\s*#(?:197|878|743|725|738|744|693|1228)|phantom-secrets\s*#(?:140|197|375|168|418|136)|ashlr-plugin\s*#(?:152|157))\b/i;
const PROTECTED = /(?:\.github(?:\/|\b)|\b(?:ashlr-plugin|ashlr-stack)\/(?:package\.json|bun\.lock\w*)\b|\bashlr-plugin\/server(?:\/|\b))/i;

/** Offline planning only. A host adapter must revalidate under its queue lock. */
export function planDriveRestock(queue: QueueDocument, pools: readonly RestockPool[], scores: readonly RestockScore[]): RestockPlan {
  validateQueue(queue);
  const impact = new Map<string, number>();
  for (const score of scores) {
    if (!Number.isFinite(score.impact) || score.impact < 0 || impact.has(score.id)) throw new Error('Invalid or duplicate impact score');
    impact.set(score.id, score.impact);
  }
  const deficits: Record<string, number> = Object.create(null) as Record<string, number>;
  const promotions: string[] = [];
  const complete = new Set(queue.jobs.filter(job => job.status === 'DONE').map(job => job.id));
  for (const { pool, freeSlots } of pools) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(pool) || !Number.isSafeInteger(freeSlots) || freeSlots < 0 || freeSlots > 1000 || Object.hasOwn(deficits, pool)) throw new Error('Invalid pool capacity');
    const ready = queue.jobs.filter(job => job.pool === pool && job.status === 'READY').length;
    let deficit = Math.max(0, 3 * freeSlots - ready);
    const candidates = queue.jobs.filter(job => eligible(job, pool, impact, complete));
    candidates.sort((a, b) => impact.get(b.id)! - impact.get(a.id)! || a.id.localeCompare(b.id));
    for (const job of candidates) {
      if (!deficit) break;
      promotions.push(job.id);
      deficit--;
    }
    deficits[pool] = deficit;
  }
  return { promotions, deficits };
}

function eligible(job: QueueJob, pool: string, scores: Map<string, number>, complete: Set<string>): boolean {
  const text = `${job.id} ${job.repo} ${job.scope} ${job.acceptance}`;
  const repoProtected = /^(?:ashlr-plugin|ashlr-stack)$/i.test(job.repo) && /(?:^|[^a-z0-9_.-])(?:package\.json|bun\.lock\w*|server(?:\/|\b))/i.test(text);
  return !repoProtected && job.status === 'PROPOSED' && job.pool === pool && scores.has(job.id) &&
    job.deps.every(dep => complete.has(dep)) && !HOLDS.test(text) && !PROTECTED.test(text) &&
    !/[\u2014\r\n]/.test(text) && job.tier !== 'unspecified' && job.repo !== 'unspecified';
}
