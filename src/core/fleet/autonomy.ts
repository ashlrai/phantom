/** Local observations only: jobs establish the denominator; optional PR metadata explains it. */
import { join } from 'node:path';
import { readGrowthJsonl, readMetricsJson } from '../growth/read.js';
import { runsRoot } from '../metrics/loop-collect.js';
import { readLedgerLines } from './ledger-lines.js';
import { readFleetMainHealth, type FleetMainHealthV1 } from './main-health.js';

export const SELF_IMPROVEMENT_PATH_RULES: readonly { area: string; pattern: string }[] = [
  { area: 'router', pattern: '^(contrib/router/|src/core/(routing/|router(?:[./-])|(?:drive/(?:nodes/)?|run/)(?:router|routing)[./-]|fleet/(?:route|router)[./-]))' },
  { area: 'dispatch', pattern: '^(contrib/mac/dispatchd\\.py$|src/core/(?:fleet/)?dispatch[./-])' },
  { area: 'queue', pattern: '^(contrib/mac/(?:restock\\.py|queue_gate\\.py)$|src/core/(?:fleet/|drive/(?:nodes/)?)?(?:queue|queuegen)[./-])' },
  { area: 'guardian', pattern: '^(src/core/(?:fleet/)?(?:guardian|main-health|main-red)[./-]|scripts/main-guardian[./-])' },
  { area: 'fleet CLI', pattern: '^src/cli/(?:fleet(?:[.-].*)?|autonomy)\\.ts$' },
  { area: 'desktop fleet', pattern: '^src/web-ui/routes/(?:control/fleet/|fleet-dashboard/|verse/fleet(?:/|-[^/]+/)|verse/sections/FleetSection\\.tsx$)' },
];
export const isSelfImprovementPath = (path: string): boolean => !path.split('/').some(p => !p || p === '.' || p === '..')
  && !path.includes('\\') && SELF_IMPROVEMENT_PATH_RULES.some(rule => new RegExp(rule.pattern).test(path));
type Row = Record<string, unknown>;
const record = (v: unknown): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const time = (v: unknown): number => typeof v === 'string' ? Date.parse(v) : NaN;
/**
 * jobs.jsonl field dialects: job|job_id|jobId|id, event|type|kind,
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt,
 * phase|state|outcome|status|result|conclusion and
 * url|prUrl|pr_url|pr|html_url — the aliases dispatchd `_vc_*` and the
 * fleet metrics readers accept.
 */
const pick = (r: Row, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const v = r[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const PHASE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const;
const PR_KEYS = ['url', 'prUrl', 'pr_url', 'pr', 'html_url'] as const;
const repoOf = (r: Row): string => r.repo === 'phantom' ? 'ashlrai/phantom' : typeof r.repo === 'string' ? r.repo.toLowerCase() : '';
function identity(r: Row): string | null {
  const url = pick(r, PR_KEYS);
  const m = typeof url === 'string' ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url) : null;
  if (m) return `${m[1]!.toLowerCase()}/pull/${m[2]}`;
  const repo = repoOf(r); const n = r.number ?? r.pr;
  if (repo && Number.isSafeInteger(n) && Number(n) > 0) return `${repo}/pull/${n}`;
  const job = pick(r, JOB_KEYS);
  return job ? JSON.stringify([repo, job]) : null;
}
function actor(v: unknown): boolean | null {
  const r = record(v); const kinds = [r.__typename, r.type];
  if (kinds.includes('User') || r.is_bot === false || r.isBot === false) return false;
  return kinds.includes('Bot') || r.is_bot === true || r.isBot === true || typeof r.login === 'string' && /\[bot\]$/i.test(r.login) ? true : null;
}
/** A queue bot is a relay, so its enqueuer must also be known. Missing reviews are not no reviews. */
function withoutHuman(r: Row): boolean | null {
  const merger = record(r.mergedBy); const queue = typeof merger.login === 'string' && /^github-merge-queue(?:\[bot\])?$/i.test(merger.login);
  const actions = [actor(r.author ?? r.openedBy), actor(r.mergedBy)];
  if (r.openedBy !== undefined) actions.push(actor(r.openedBy));
  if (queue) actions.push(actor(r.enqueuer));
  const connection = record(r.reviews);
  const reviews = Array.isArray(r.reviews) ? r.reviews : Array.isArray(connection.nodes) ? connection.nodes : null;
  const complete = Array.isArray(r.reviews) || record(connection.pageInfo).hasNextPage === false;
  for (const review of reviews ?? []) {
    const v = record(review);
    if (v.state === 'APPROVED') actions.push(actor(v.author));
    else if (!['COMMENTED', 'CHANGES_REQUESTED', 'PENDING'].includes(String(v.state))) actions.push(null);
  }
  if (actions.includes(false)) return false;
  return reviews !== null && complete && r.reviewsComplete !== false && actions.every(a => a === true) ? true : null;
}
function improved(r: Row, key: string): boolean | null {
  const repo = key.includes('/pull/') ? key.split('/pull/')[0] : repoOf(r);
  if (repo !== 'phantom' && repo !== 'ashlrai/phantom') return repo ? false : null;
  if (!Array.isArray(r.files)) return null;
  const paths = r.files.map(f => typeof f === 'string' ? f : record(f).path);
  if (paths.some(p => typeof p === 'string' && isSelfImprovementPath(p))) return true;
  return r.filesComplete !== false && paths.every(p => typeof p === 'string') ? false : null;
}
export interface AutonomyReport {
  schema: 'fleet.autonomy.v1'; generatedAt: string; windowHours: number;
  merged: number | null; mergedPerHour: number | null; withoutHumanShare: number | null;
  selfImprovementShare: number | null; releases: number | null;
  /** Current repository share from the guardian snapshot, not window uptime. */
  mainGreenShare: number | null; headline: string;
  actorsKnown: number | null; filesKnown: number | null; malformedLines: number;
  pathRules: typeof SELF_IMPROVEMENT_PATH_RULES;
}
export interface AutonomyInput {
  jobs: readonly string[] | null; pulls?: unknown; releases: readonly string[] | null;
  mains: FleetMainHealthV1 | null; now: number; hours?: number;
}
export function autonomyTally(now: number, hours = 24) {
  if (!Number.isSafeInteger(hours) || hours <= 0 || hours > 720) throw new Error('hours must be an integer from 1 to 720');
  const since = now - hours * 3_600_000;
  const merges = new Map<string, { at: number; recordedAt?: number; rows: Row[] }>();
  let malformedLines = 0; let recent = false;
  return {
    add(line: string) {
      if (!line.trim()) return;
      let r: Row;
      try { r = record(JSON.parse(line)); if (!Object.keys(r).length) throw new Error('row'); } catch { malformedLines++; return; }
      const at = time(pick(r, TS_KEYS)); if (at > now) return;
      if (at >= since && ['launch', 'claim', 'finish', 'publish', 'outcome'].includes(pick(r, EVENT_KEYS) ?? '')) recent = true;
      if ((pick(r, EVENT_KEYS) ?? (r.source === 'metrics-outcomes-reconciler' ? 'outcome' : '')) !== 'outcome'
        || (pick(r, PHASE_KEYS) ?? '').toUpperCase() !== 'MERGED') return;
      const key = identity(r); const mergedAt = r.mergedAt === undefined ? at : time(r.mergedAt);
      if (!key || !Number.isFinite(mergedAt)) { malformedLines++; return; }
      if (mergedAt > now) return;
      if (mergedAt >= since) recent = true;
      const prior = merges.get(key);
      merges.set(key, { at: Math.min(prior?.at ?? mergedAt, mergedAt), rows: [...(prior?.rows ?? []), r],
        recordedAt: r.mergedAt === undefined ? prior?.recordedAt : Math.min(prior?.recordedAt ?? mergedAt, mergedAt) });
    },
    report(known: boolean, input: Omit<AutonomyInput, 'jobs' | 'now' | 'hours'>): AutonomyReport {
      const pulls = Array.isArray(input.pulls) ? input.pulls : record(input.pulls).pulls;
      for (const raw of Array.isArray(pulls) ? pulls : []) {
        const r = record(raw); const key = identity(r); const merge = key ? merges.get(key) : undefined;
        if (merge) { merge.rows.push(r); if (Number.isFinite(time(r.mergedAt))) merge.recordedAt = Math.min(merge.recordedAt ?? Infinity, time(r.mergedAt)); }
      }
      // Prefer recorded merge time; legacy rows fall back to their first outcome observation.
      const rows = [...merges.entries()].filter(([, v]) => (v.recordedAt ?? v.at) >= since && (v.recordedAt ?? v.at) <= now);
      const complete = known && recent && malformedLines === 0;
      const merged = complete ? rows.length : null;
      const agents = rows.map(([, v]) => { const values = v.rows.map(withoutHuman); return values.includes(false) ? false : values.includes(true) ? true : null; });
      const improvements = rows.map(([key, v]) => { const values = v.rows.map(r => improved(r, key)); return values.includes(true) ? true : values.includes(false) ? false : null; });
      const share = (values: (boolean | null)[]) => complete && values.length && !values.includes(null) ? values.filter(Boolean).length / values.length : null;
      const withoutHumanShare = share(agents); const selfImprovementShare = share(improvements);
      const releases = new Set<string>(); let releasesKnown = input.releases !== null;
      for (const line of input.releases ?? []) {
        if (!line.trim()) continue;
        try {
          const r = record(JSON.parse(line)); const at = time(r.publishedAt);
          if (!Number.isFinite(at)) throw new Error('time');
          if (at >= since && at <= now) {
            const tag = r.tagName ?? r.tag ?? r.version;
            releases.add(typeof r.repo === 'string' && typeof tag === 'string' ? JSON.stringify([r.repo, tag]) : `row:${releases.size}`);
          }
        } catch { releasesKnown = false; }
      }
      const m = input.mains;
      const mainGreenShare = m?.source === 'ok' && !m.stale && !m.guardianOff && m.repos.length && m.repos.every(r => r.state !== 'unknown')
        ? m.repos.filter(r => r.state === 'green').length / m.repos.length : null;
      const pct = (n: number | null) => n === null ? 'unknown' : `${Math.round(n * 100)}%`;
      return { schema: 'fleet.autonomy.v1', generatedAt: new Date(now).toISOString(), windowHours: hours,
        merged, mergedPerHour: merged === null ? null : merged / hours, withoutHumanShare, selfImprovementShare,
        releases: releasesKnown ? releases.size : null, mainGreenShare,
        headline: `${merged ?? 'unknown'} merged, ${pct(withoutHumanShare)} without a person, ${pct(selfImprovementShare)} improved the fleet itself`,
        actorsKnown: complete ? agents.filter(v => v !== null).length : null, filesKnown: complete ? improvements.filter(v => v !== null).length : null,
        malformedLines, pathRules: SELF_IMPROVEMENT_PATH_RULES };
    },
  };
}
export function buildAutonomy(input: AutonomyInput): AutonomyReport {
  const tally = autonomyTally(input.now, input.hours); input.jobs?.forEach(line => tally.add(line));
  return tally.report(input.jobs !== null, input);
}
export async function readAutonomy(opts: { runsDir?: string; now?: number; hours?: number } = {}): Promise<AutonomyReport> {
  const root = opts.runsDir ?? runsRoot(); const now = opts.now ?? Date.now();
  const tally = autonomyTally(now, opts.hours);
  const [known, pulls, releases, mains] = await Promise.all([
    readLedgerLines(join(root, 'metrics/jobs.jsonl'), line => tally.add(line)),
    readMetricsJson(join(root, 'metrics/growth-pulls-1d.json')),
    readGrowthJsonl(join(root, 'metrics/growth-releases.jsonl')),
    readFleetMainHealth({ runsDir: root, now: () => now }).catch(() => null),
  ]);
  return tally.report(known, { pulls, releases, mains });
}
