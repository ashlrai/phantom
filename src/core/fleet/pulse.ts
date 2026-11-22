/** `phm fleet pulse`: is the fleet doing well right now, as five numbers with a 24 hour trend each.
 * Built only from readers other commands already use: the job metrics ledger (`phm throughput`), the main guardian status
 * (`phm home`), the latest GitHub release per guarded repo (`phm fleet release-live`) and the spend snapshot (`phm spend`).
 * `buildPulse` is pure; the CLI and the desktop and phone Pulse card all call it. Unknown stays null and says why, never 0. */
import { join } from 'node:path';
import { defaultRunsDir } from './landed-closes-read.js';
import { readFleetMainHealth, type FleetMainHealthV1 } from './main-health.js';
import { fetchLatestRelease, validReleaseRepo, type ReleaseRunner } from './release-live-notice.js';
import { durationText, readThroughput, type ThroughputReport } from './throughput.js';
import { readBlockedHourLine } from './load-history.js';
import { readUsageSpend, type SpendSnapshot } from '../usage/spend.js';

export const PULSE_SCHEMA = 'fleet.pulse.v1' as const;
/** Direction against the 24 hours before; `better` says whether that direction is good, null when unknown or flat. */
export type PulseTrend = 'up' | 'down' | 'flat' | 'unknown';
export interface PulseNumber { value: number | null; trend: PulseTrend; better: boolean | null; line: string }
export interface PulseV1 {
  schema: typeof PULSE_SCHEMA; v: 1; asOf: string;
  /** bad: a main is red or nothing merged in 24 hours. watch: a pool will go unused or a main is not known. */
  verdict: 'good' | 'watch' | 'bad' | 'unknown';
  headline: string;
  /** Average over the last 24 hours; the trend compares the two days' merge counts. `sparkline` is the 24 hourly merge counts, oldest first; empty when unknown. */
  mergesPerHour: PulseNumber & { sparkline: number[] };
  medianMergeSeconds: PulseNumber;
  mainsGreen: PulseNumber & { total: number | null; red: string[] };
  /** The worst (largest) count; `repos` lists every guarded repo, `days` null when its release could not be read. */
  daysSinceRelease: PulseNumber & { worstRepo: string | null; repos: { repo: string; tag: string | null; days: number | null }[] };
  poolsOnPace: PulseNumber & { measured: number | null };
  /** What blocked launches, in one line; null unless launches were blocked for over 10 minutes in the last hour. */
  loadLine?: string | null;
}
export type PulseRelease = { repo: string; tag: string | null; publishedAt: string | null };
/** Every reader's output as it returned it; null when that reader failed. */
export interface PulseInputs {
  /** `day` is the 24 hours ending now, `dayBefore` the 24 hours before that. */
  jobs: { day: ThroughputReport; dayBefore: ThroughputReport } | null;
  main: FleetMainHealthV1 | null;
  releases: PulseRelease[] | null;
  spend: SpendSnapshot | null;
  /** The blocked-by-load line from the load history; absent or null when there is nothing to say. */
  loadLine?: string | null;
}

const DAY = 86_400_000;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
function trend(now: number | null, before: number | null, higherIsBetter: boolean): Pick<PulseNumber, 'trend' | 'better'> {
  if (now === null || before === null) return { trend: 'unknown', better: null };
  if (now === before) return { trend: 'flat', better: null };
  return { trend: now > before ? 'up' : 'down', better: (now > before) === higherIsBetter };
}
const unknown = (line: string): PulseNumber => ({ value: null, trend: 'unknown', better: null, line });

/** Pure: the pulse for these inputs at `now`. */
export function buildPulse(inputs: PulseInputs, now: number): PulseV1 {
  const day = inputs.jobs?.day.metrics === 'ok' ? inputs.jobs.day : null, before = inputs.jobs?.dayBefore.metrics === 'ok' ? inputs.jobs.dayBefore : null;
  const noJobs = 'Unknown: the job metrics file could not be read.';
  const merged = day?.totals.merged ?? null, mergedBefore = before?.totals.merged ?? null;
  const rate = merged === null ? null : round1(merged / day!.hours);
  const mergesPerHour = rate === null ? { ...unknown(noJobs), sparkline: [] }
    : { value: rate, ...trend(merged, mergedBefore, true), sparkline: day!.buckets.map(hour => hour.merged ?? 0),
      line: `${plural(merged!, 'PR')} merged in the last 24 hours${mergedBefore === null ? '' : `, ${mergedBefore} the day before`}.` };
  const median = day?.totals.median_publish_to_merge_s ?? null;
  const medianMergeSeconds: PulseNumber = !day ? unknown(noJobs) : median === null ? unknown('Unknown: no merged PR with a known publish time in the last 24 hours.')
    : { value: median, ...trend(median, before?.totals.median_publish_to_merge_s ?? null, false),
      line: `Half of PRs merge within ${durationText(median)} of publishing.` };

  const main = inputs.main;
  const red = main?.source === 'ok' && !main.stale ? main.repos.filter(repo => repo.state === 'red').map(repo => repo.repo) : [];
  const mainsGreen: PulseV1['mainsGreen'] = !main || main.source !== 'ok' ? { ...unknown('Unknown: the main guardian status could not be read.'), total: null, red }
    : main.stale ? { ...unknown('Unknown: the main guardian status is more than 30 minutes old.'), total: null, red }
    : !main.repos.length ? { ...unknown('Unknown: the main guardian status lists no repos.'), total: null, red }
    // No history of main status is kept, so the trend stays unknown.
    : { value: main.repos.filter(repo => repo.state === 'green').length, total: main.repos.length, red, trend: 'unknown', better: null,
      line: red.length ? `Red: ${red.join(', ')}.` : main.repos.every(repo => repo.state === 'green') ? 'Every main branch is green.'
        : `Not known: ${main.repos.filter(repo => repo.state === 'unknown').map(repo => repo.repo).join(', ')}.` };

  const releases = (inputs.releases ?? []).map(({ repo, tag, publishedAt }) => {
    const at = publishedAt === null ? NaN : Date.parse(publishedAt);
    return { repo, tag, days: Number.isFinite(at) && at <= now ? Math.floor((now - at) / DAY) : null };
  });
  const known = releases.filter(row => row.days !== null).sort((a, b) => b.days! - a.days!), worst = known[0];
  const missing = releases.length - known.length;
  // Each repo ages a day unless it released; a release in the last day hides the repo's previous age, so the trend is unknown.
  const daysSinceRelease: PulseV1['daysSinceRelease'] = !worst
    ? { ...unknown(inputs.releases === null || !releases.length ? 'Unknown: no guarded repo is known to read releases for.' : 'Unknown: no release could be read.'), worstRepo: null, repos: releases }
    : { value: worst.days, ...(known.some(row => row.days === 0) ? { trend: 'unknown' as const, better: null } : { trend: 'up' as const, better: false }), worstRepo: worst.repo, repos: releases,
      line: `${worst.repo} last released ${worst.days === 0 ? 'today' : `${plural(worst.days!, 'day')} ago`}${worst.tag ? ` (${worst.tag})` : ''}.${missing ? ` ${missing} not known.` : ''}` };

  const pools = inputs.spend?.pools.filter(row => row.status !== 'unknown') ?? [];
  const behind = pools.filter(row => row.status === 'behind'), top = behind[0];
  const waste = !top ? '' : top.unit === 'usd' ? `${Math.round(top.projectedUnusedUsd ?? 0)} USD` : `${Math.round(top.projectedUnusedPercent ?? 0)}%`;
  // The spend snapshot keeps no history, so the trend stays unknown.
  const poolsOnPace: PulseV1['poolsOnPace'] = !pools.length ? { ...unknown(`Unknown: ${inputs.spend ? inputs.spend.headline.replace(/^Unknown: /, '') : 'the spend snapshot could not be read.'}`), measured: null }
    : { value: pools.length - behind.length, measured: pools.length, trend: 'unknown', better: null,
      line: `${pools.length - behind.length} of ${plural(pools.length, 'pool')} on pace${top ? `; ${top.pool} will leave ${waste} unused` : ''}.` };

  const fields = [mergesPerHour, medianMergeSeconds, mainsGreen, daysSinceRelease, poolsOnPace];
  const stalled = merged === 0;
  const notGreen = mainsGreen.value !== null && mainsGreen.value < mainsGreen.total!;
  const verdict: PulseV1['verdict'] = red.length || stalled ? 'bad' : behind.length || notGreen ? 'watch' : fields.some(field => field.value === null) ? 'unknown' : 'good';
  const headline = red.length ? `Not well: main is red on ${red.join(', ')}.` : stalled ? 'Not well: no PR merged in the last 24 hours.'
    : behind.length ? `Watch: ${plural(behind.length, 'pool')} will leave allowance unused.` : notGreen ? 'Watch: some main branches are not known to be green.'
    : verdict === 'unknown' ? `Partly unknown: ${plural(fields.filter(field => field.value === null).length, 'number')} could not be read.`
    : `Doing well: ${rate} PRs merged per hour and every main is green.`;
  return { schema: PULSE_SCHEMA, v: 1, asOf: new Date(now).toISOString(), verdict, headline, mergesPerHour, medianMergeSeconds, mainsGreen, daysSinceRelease, poolsOnPace, ...(inputs.loadLine ? { loadLine: inputs.loadLine } : {}) };
}

/** Guardian rows name repos as `owner/name` or bare `name`; bare names are the ashlrai org's. */
const releaseRepo = (repo: string): string => repo.includes('/') ? repo : `ashlrai/${repo}`;
const RELEASE_TTL_MS = 15 * 60_000;
let releaseCache: { key: string; at: number; read: Promise<PulseRelease[]> } | null = null;
/** Latest published release per repo, reused for 15 minutes: Home polls, GitHub should not be asked every minute. */
export function readReleases(repos: string[], now: number, run?: ReleaseRunner): Promise<PulseRelease[]> {
  const key = repos.join(',');
  if (!run && releaseCache?.key === key && now - releaseCache.at < RELEASE_TTL_MS) return releaseCache.read;
  const read = Promise.all(repos.map(async repo => {
    const fact = validReleaseRepo(releaseRepo(repo)) ? await fetchLatestRelease(releaseRepo(repo), run) : null;
    return { repo, tag: fact?.tag ?? null, publishedAt: fact?.publishedAt ?? null };
  }));
  if (!run) releaseCache = { key, at: now, read };
  return read;
}

/** Read every input once. Read-only; a reader that fails leaves its numbers unknown. */
export async function readPulseInputs(runsDir: string, now: number, run?: ReleaseRunner): Promise<PulseInputs> {
  const quiet = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const metricsPath = join(runsDir, 'metrics', 'jobs.jsonl');
  // One window at a time keeps at most one ledger tail in memory.
  const day = await quiet(readThroughput({ runsDir, now, hours: 24, by: 'repo', metricsPath }));
  const dayBefore = await quiet(readThroughput({ runsDir, now: now - DAY, hours: 24, by: 'repo', metricsPath }));
  const [main, spend] = await Promise.all([quiet(readFleetMainHealth({ runsDir, now: () => now })), quiet(readUsageSpend(join(runsDir, 'queue', 'status.json'), now))]);
  const repos = main?.source === 'ok' ? main.repos.map(repo => repo.repo) : null;
  const releases = repos ? await quiet(readReleases(repos, now, run)) : null;
  return { jobs: day && dayBefore ? { day, dayBefore } : null, main, releases, spend, loadLine: readBlockedHourLine(runsDir, now) };
}

export async function readPulse(opts: { runsDir?: string; now?: number; run?: ReleaseRunner; read?: typeof readPulseInputs } = {}): Promise<PulseV1> {
  const now = opts.now ?? Date.now();
  return buildPulse(await (opts.read ?? readPulseInputs)(opts.runsDir ?? defaultRunsDir(), now, opts.run), now);
}

const ARROW: Record<PulseTrend, string> = { up: '↑', down: '↓', flat: '→', unknown: '?' };
const BARS = '▁▂▃▄▅▆▇█';
/** Eight-level text sparkline, as drawn in the terminal. */
export function sparkText(values: readonly number[]): string {
  const max = Math.max(1, ...values);
  return values.map(value => BARS[Math.min(7, Math.round((value / max) * 7))]).join('');
}
/** Plain lines for a terminal: the headline, then one line per number with its arrow. */
export function pulseText(pulse: PulseV1): string[] {
  const show = (title: string, field: PulseNumber, value: string) => `${ARROW[field.trend]} ${title}: ${field.value === null
    ? `unknown (${field.line.replace(/^Unknown: /, '').replace(/\.$/, '')})` : `${value}. ${field.line}`}`;
  const { mergesPerHour: m, medianMergeSeconds: t, mainsGreen: g, daysSinceRelease: r, poolsOnPace: p } = pulse;
  return [pulse.headline, ...(pulse.loadLine ? [pulse.loadLine] : []),
    `${show('PRs merged per hour', m, String(m.value))}${m.sparkline.length ? ` ${sparkText(m.sparkline)}` : ''}`,
    show('Median publish to merge', t, durationText(t.value)),
    show('Main branches green', g, `${g.value} of ${g.total}`),
    show('Days since last release', r, `${r.value} (${r.worstRepo})`),
    show('Pools on pace', p, `${p.value} of ${p.measured}`)];
}
