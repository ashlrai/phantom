import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { scrubSecrets } from '../util/scrub.js';

const HOUR = 3_600_000;
export interface MetricsHour {
  start: string; end: string; merged: number | null; byRepo: Record<string, number>;
  launches: number | null; mergesPerLaunch: number | null;
}
export interface FleetMetricsSeries {
  schema: 'fleet.metrics-series.v1'; known: boolean; observedAt: string; since: string;
  mergesLastHour: number | null; mergesLast24h: number | null; malformedLines: number; hours: MetricsHour[];
}
const word = (v: unknown): string | null => typeof v === 'string' && /^[\w][\w./:-]{0,159}$/.test(v) ? v : null;

/** Rolling one-hour buckets. Outcomes use their recorded ts, as fleet yield does.
 * No human-action attribution is recorded: the ratio is throughput, not autonomy
 * or launch-cohort success. Re-emitted PR outcomes count once, at their first ts.
 */
export function metricsSeriesTally(now = Date.now()) {
  const since = now - 24 * HOUR;
  const merges = new Map<string, { at: number; repo: string }>();
  const launches = new Map<string, number>();
  let malformedLines = 0;
  return {
    add(line: string) {
      if (!line.trim()) return;
      let r: Record<string, unknown>;
      try {
        const v: unknown = JSON.parse(line);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid row');
        r = v as Record<string, unknown>;
      } catch { malformedLines++; return; }
      const kind = r.event ?? (r.source === 'metrics-outcomes-reconciler' ? 'outcome' : null);
      if (kind !== 'launch' && !(kind === 'outcome' && (r.state ?? r.outcome ?? r.status) === 'MERGED')) return;
      const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (!Number.isFinite(at)) { malformedLines++; return; }
      if (at > now) return;
      const job = word(r.job ?? r.jobId ?? r.job_id ?? r.id);
      if (kind === 'launch') {
        if (!job) { malformedLines++; return; }
        if (at >= since) launches.set(JSON.stringify([job, word(r.repo), at]), at);
        return;
      }
      const rawUrl = r.url ?? r.prUrl ?? r.pr_url ?? r.pr;
      const match = typeof rawUrl === 'string' ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(rawUrl) : null;
      const repo = match?.[1]?.toLowerCase() ?? word(r.repo) ?? 'unknown';
      const key = match ? `${repo}/pull/${match[2]}` : job ? JSON.stringify([repo, job]) : null;
      if (!key) { malformedLines++; return; }
      const prior = merges.get(key);
      if (!prior || at < prior.at) merges.set(key, { at, repo: scrubSecrets(repo) === repo ? repo : 'unknown' });
    },
    report(known = true): FleetMetricsSeries {
      const hours: MetricsHour[] = Array.from({ length: 24 }, (_, i) => ({
        start: new Date(since + i * HOUR).toISOString(), end: new Date(since + (i + 1) * HOUR).toISOString(),
        merged: known ? 0 : null, byRepo: Object.create(null) as Record<string, number>, launches: known ? 0 : null, mergesPerLaunch: null,
      }));
      const bucket = (at: number) => hours[Math.min(23, Math.floor((at - since) / HOUR))]!;
      if (known) {
        for (const { at, repo } of merges.values()) if (at >= since) {
          const hour = bucket(at);
          hour.merged!++; hour.byRepo[repo] = (hour.byRepo[repo] ?? 0) + 1;
        }
        for (const at of launches.values()) bucket(at).launches!++;
        for (const hour of hours) hour.mergesPerLaunch = hour.launches ? hour.merged! / hour.launches : null;
      }
      return { schema: 'fleet.metrics-series.v1', known, observedAt: new Date(now).toISOString(), since: new Date(since).toISOString(),
        mergesLastHour: hours[23]!.merged, mergesLast24h: known ? hours.reduce((n, h) => n + h.merged!, 0) : null,
        malformedLines: known ? malformedLines : 0, hours };
    },
  };
}
export async function readMetricsSeries(path: string, now = Date.now(), read: YieldLineReader = readLedgerLines): Promise<FleetMetricsSeries> {
  const tally = metricsSeriesTally(now);
  try { return tally.report(await read(path, line => tally.add(line))); }
  catch { return tally.report(false); }
}
