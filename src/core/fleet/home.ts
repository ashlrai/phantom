/** `phm home`: is the fleet healthy and moving, in one typed summary. Built only from reports other commands already
 * serve (throughput, main health, the resource ledger, the work log, asks). The desktop and phone Home screens show nothing else. A field whose source is missing is `unknown` with a reason, never zero. */
import { join } from 'node:path';
import { ASK_ANSWERS, listAsks, type AskAnswer, type AskKind, type AsksList } from './asks.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { readFleetMainHealth, type FleetMainHealthV1 } from './main-health.js';
import { ledgerWindowPlan } from './reset-window-plan.js';
import { readResourceLedger, type ResourceLedgerV1 } from './runs-resource-ledger.js';
import { durationText, readThroughput, type ThroughputReport } from './throughput.js';
import { readWorklog, type WorklogKind, type WorklogReport } from './worklog.js';

export type HomeField<T> = { state: 'ok'; value: T } | { state: 'unknown'; reason: string };
export interface HomeSummary {
  schema: 'home.v1'; asOf: string;
  /** red: a default branch is red. stalled: no PR merged in 60 minutes. unknown: merges or main could not be read. */
  health: 'healthy' | 'stalled' | 'red' | 'unknown';
  headline: string;
  /** The median is seconds from publish to merge over the last 24 hours. */
  mergedLastHour: HomeField<number>; merged24h: HomeField<number>; medianMergeSeconds: HomeField<number>;
  main: HomeField<{ repo: string; state: 'green' | 'red' | 'unknown' }[]>;
  running: HomeField<{ lane: string; running: number; target: number | null }[]>;
  /** The allowance most at risk of expiring unused at its reset; null when none is. */
  atRisk: HomeField<{ resource: string; percentUnused: number; resetAt: string; reason: string } | null>;
  worklog: HomeField<{ at: string; kind: WorklogKind; text: string; url: string | null }[]>;
  /** Leader replies in the last 24 hours that are newer than the caller's last-read time. */
  unreadLeaderReplies: HomeField<number>;
  /** What only Mason can do, oldest first (`phm asks`). Each takes one word from `answers`; an empty list means nothing is waiting. */
  needsYou: HomeField<{ id: string; shortId: string; kind: AskKind | 'signin'; request: string; ageSeconds: number | null; answers: readonly AskAnswer[] }[]>;
}
/** Each report as its own reader returned it; null when that reader failed. */
export interface HomeSources { throughput: ThroughputReport | null; main: FleetMainHealthV1 | null; ledger: ResourceLedgerV1 | null; worklog: WorklogReport | null; asks: AsksList | null }
const HOME_HOURS = 24;
const ok = <T>(value: T): HomeField<T> => ({ state: 'ok', value });
const unknown = (reason: string): { state: 'unknown'; reason: string } => ({ state: 'unknown', reason });

/** Pure: the summary for these reports at `now`. `leaderSeenMs` is when the reader last read the Leader thread. */
export function buildHome(sources: HomeSources, now: number, leaderSeenMs?: number | null): HomeSummary {
  const { throughput, main: mains, ledger, worklog, asks } = sources;
  const metrics = throughput?.metrics === 'ok' ? throughput : null;
  const merged = (value: number | null | undefined): HomeField<number> => metrics && typeof value === 'number' ? ok(value)
    : unknown(throughput ? 'The job metrics file could not be read.' : 'The throughput report could not be read.');
  const hour = metrics?.buckets.at(-1)?.merged, mergedLastHour = merged(hour), merged24h = merged(metrics?.totals.merged);
  const median = metrics?.totals.median_publish_to_merge_s;
  const medianMergeSeconds = !metrics ? merged(null) : typeof median === 'number' ? ok(median)
    : unknown('No merged PR with a known publish time in the last 24 hours.');
  const main: HomeSummary['main'] = !mains || mains.source !== 'ok' ? unknown('The main guardian status could not be read.')
    : mains.stale ? unknown('The main guardian status is more than 30 minutes old.')
    : mains.repos.length ? ok(mains.repos.map(({ repo, state }) => ({ repo, state }))) : unknown('The main guardian status lists no repos.');
  const lanes = ledger?.sources.status === 'healthy' ? ledger.lanes.flatMap(row => row.running === null ? [] : [{ lane: row.lane, running: row.running, target: row.target }]) : [];
  const running: HomeSummary['running'] = lanes.length ? ok(lanes)
    : unknown(!ledger || ledger.sources.status === 'missing' ? 'No fleet status has been written yet.' : 'The fleet status has no readable lane counts.');
  // The plan ranks expiring allowances first, nearest reset first.
  const plan = ledger ? ledgerWindowPlan(ledger, now) : [], wasting = plan.find(row => row.verdict === 'wasting');
  const atRisk: HomeSummary['atRisk'] = wasting ? ok({ resource: wasting.resource, percentUnused: Math.round(wasting.projectedPercentLeftAtReset! * 10) / 10, resetAt: wasting.resetAt!, reason: wasting.reason })
    : plan.some(row => row.verdict !== 'unknown') ? ok(null) : unknown('No resource has a fresh usage reading, a burn rate and a future reset.');
  const missing = worklog ? Object.values(worklog.sources).flatMap(source => source.state === 'unknown' ? [source.reason] : []) : ['The work log could not be read.'], rows = worklog?.rows ?? [];
  const items: HomeSummary['worklog'] = rows.length || !missing.length ? ok(rows.slice(0, 5).map(({ at, kind, text, url }) => ({ at, kind, text, url }))) : unknown(missing.join(' '));
  const leader = worklog?.sources.leader;
  const unreadLeaderReplies: HomeSummary['unreadLeaderReplies'] = !leader ? unknown('The work log could not be read.') : leader.state === 'unknown' ? unknown(leader.reason)
    : typeof leaderSeenMs !== 'number' || !Number.isFinite(leaderSeenMs) ? unknown('No last-read time was given, so replies cannot be counted as unread.')
    : ok(rows.filter(row => row.kind === 'leader' && Date.parse(row.at) > leaderSeenMs).length);
  const needsYou: HomeSummary['needsYou'] = !asks || asks.ledger === 'unavailable' ? unknown('The needs-you ledger could not be read.')
    : ok(asks.asks.map(({ id, shortId, kind, request, ageSeconds }) => ({ id, shortId, kind, request, ageSeconds, answers: ASK_ANSWERS })));
  const named = (state: string) => main.state === 'ok' ? main.value.filter(repo => repo.state === state).map(repo => repo.repo) : [];
  const red = named('red'), dim = named('unknown');
  const unsure = [...[mergedLastHour, main].flatMap(field => field.state === 'unknown' ? [field.reason] : []), ...(dim.length ? [`Main is not known for ${dim.join(', ')}.`] : [])];
  const health: HomeSummary['health'] = red.length ? 'red' : mergedLastHour.state === 'ok' && mergedLastHour.value === 0 ? 'stalled' : unsure.length ? 'unknown' : 'healthy';
  const headline = health === 'red' ? `Main is red on ${red.join(', ')}.` : health === 'stalled' ? 'Stalled: no PR merged in the last 60 minutes.'
    : health === 'unknown' ? `Unknown: ${unsure[0]}` : `Healthy: ${hour} PR${hour === 1 ? '' : 's'} merged in the last hour and main is green.`;
  return { schema: 'home.v1', asOf: new Date(now).toISOString(), health, headline, mergedLastHour, merged24h, medianMergeSeconds, main, running, atRisk, worklog: items, unreadLeaderReplies, needsYou };
}
/** Read the five reports once each. Read-only; a reader that fails leaves its fields unknown. */
export async function readHomeSources(runsDir: string, now: number): Promise<HomeSources> {
  const quiet = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const [throughput, main, ledger, worklog, asks] = await Promise.all([
    quiet(readThroughput({ runsDir, now, hours: HOME_HOURS, by: 'lane', metricsPath: join(runsDir, 'metrics', 'jobs.jsonl') })),
    quiet(readFleetMainHealth({ runsDir, now: () => now })),
    quiet(readResourceLedger({ runsDir, now: () => now })),
    quiet(readWorklog(HOME_HOURS, { now, runsDir })),
    quiet(Promise.resolve().then(() => listAsks({ runsDir, now: () => now }))),
  ]);
  return { throughput, main, ledger, worklog, asks };
}
/** The summary now. `read` is the one place data comes from; tests pass fixtures through it. */
export async function readHome(opts: { runsDir?: string; now?: number; leaderSeenMs?: number | null; read?: typeof readHomeSources } = {}): Promise<HomeSummary> {
  const now = opts.now ?? Date.now();
  return buildHome(await (opts.read ?? readHomeSources)(opts.runsDir ?? defaultRunsDir(), now), now, opts.leaderSeenMs);
}
/** Plain lines for a terminal: the headline, then one line per field. */
export function homeText(home: HomeSummary): string[] {
  const show = <T>(field: HomeField<T>, text: (value: T) => string): string => field.state === 'ok' ? text(field.value) : `unknown (${field.reason})`;
  return [
    home.headline,
    `Merged, last hour: ${show(home.mergedLastHour, String)}`,
    `Merged, last 24 hours: ${show(home.merged24h, String)}`,
    `Median time to merge: ${show(home.medianMergeSeconds, durationText)}`,
    `Main: ${show(home.main, repos => repos.map(repo => `${repo.repo} ${repo.state}`).join(', '))}`,
    `Running jobs: ${show(home.running, lanes => lanes.map(lane => `${lane.lane} ${lane.running}${lane.target === null ? '' : ` of ${lane.target}`}`).join(', '))}`,
    `Most at risk of going unused: ${show(home.atRisk, risk => risk ? `${risk.resource}. ${risk.reason}` : 'nothing')}`,
    `Unread Leader replies: ${show(home.unreadLeaderReplies, String)}`,
    `Needs you: ${show(home.needsYou, asks => asks.length ? asks.map(ask => `${ask.request} (${ask.answers.join(', ')} ${ask.shortId})`).join('; ') : 'nothing')}`,
    `Work log: ${show(home.worklog, rows => rows.length ? '' : 'nothing in the last 24 hours')}`.trimEnd(),
    ...(home.worklog.state === 'ok' ? home.worklog.value.map(row => `  ${row.at.slice(11, 16)}Z  ${row.kind}  ${row.text}`) : []),
  ];
}
