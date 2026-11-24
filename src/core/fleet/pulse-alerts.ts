/** `phm fleet pulse --alerts`: "if no job started and no PR merged in 30 minutes, treat it as an incident" (Mason), and three
 * more things worth a red row: a lane starved of work, a lane wasting its jobs on EMPTY, and a plan that will end its window unused.
 * Built only on readers other commands already use: the job metrics ledger (`phm throughput`), the lane snapshot's starved read
 * (`phm fleet idle-lanes`) and the spend snapshot (`phm usage spend`). `buildPulseAlerts` is pure. `notifyPulseAlerts` sends one
 * plain-words notice per alert through the same email outbox and Telegram path as `phm fleet main-red-notify`, at most once an hour
 * per alert. Anything that could not be read is listed in `unknown`, never counted as fine. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { buildStaleText, buildStaleness, buildUnidentifiedText, resolveBuildStaleLimits, savedBuildStaleLimits, type BuildStaleLimits, type MaybeBuildReport } from './build-stale.js';
import type { CadenceV1 } from '../release/cadence.js';
import type { SpendSnapshot } from '../usage/spend.js';
import type { StarvedRead } from './lane-starved.js';
import { summarizeSkips, type SkippedJobsV1 } from './skipped-jobs.js';
import type { ThroughputMark } from './throughput.js';

export const PULSE_ALERTS_SCHEMA = 'fleet.pulse.alerts.v1' as const;
export const PULSE_ALERT_KINDS = ['stalled', 'starved', 'wasting', 'pool_waste', 'release_stale', 'build-stale', 'skipped'] as const;
export type PulseAlertKind = (typeof PULSE_ALERT_KINDS)[number];
export interface PulseAlertV1 {
  kind: PulseAlertKind;
  /** The lane, or the pool for pool_waste, or the repo for release_stale, or the short running commit for build-stale; `fleet` for stalled. */
  lane: string;
  /** ISO time the trouble began; null when it is a projection with no start (pool_waste). */
  since: string | null;
  detail: string;
  fix_hint: string;
}
export interface PulseAlertsV1 {
  schema: typeof PULSE_ALERTS_SCHEMA; v: 1; as_of: string;
  alerts: PulseAlertV1[];
  /** Plain-words checks that could not be made. An alert may be missing for each of these. */
  unknown: string[];
}
/** Every reader's output as it returned it; null when that reader failed. */
export interface PulseAlertInputs { marks: readonly ThroughputMark[] | null; starved: StarvedRead | null; spend: SpendSnapshot | null;
  /** Release cadence; absent means not checked, null means the read failed. */
  releases?: CadenceV1 | null;
  /** The live build (`phm doctor build`); absent means not checked, null means the read failed. */
  build?: MaybeBuildReport;
  /** Override the build-stale limits (50 commits, 24 hours). */
  buildLimits?: BuildStaleLimits;
  /** Precheck skips in the last SKIP_ALERT_HOURS; absent means not checked, null means the ledger could not be read. */
  skips?: SkippedJobsV1 | null }

export const STALL_MINUTES = 30;
export const WASTING_JOBS = 20;
/** Fewer finished jobs than this say too little about a lane's EMPTY rate. */
export const WASTING_MIN_JOBS = 5;
export const WASTING_RATE = 0.4;
export const POOL_WASTE_PERCENT = 10;
/** How far back a precheck skip counts toward the skipped alert. */
export const SKIP_ALERT_HOURS = 6;
/** How far back the ledger is scanned for the last launch, the last merge and the last 20 jobs per lane. */
export const ALERT_LOOKBACK_H = 72;
const MIN = 60_000;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const minutesText = (ms: number): string => ms >= 120 * MIN ? `${Math.floor(ms / (60 * MIN))} hours` : plural(Math.floor(ms / MIN), 'minute');

/** Pure: the active alerts for these inputs at `now`. */
export function buildPulseAlerts(inputs: PulseAlertInputs, now: number): PulseAlertsV1 {
  const alerts: PulseAlertV1[] = [], unknown: string[] = [];
  const { marks, starved, spend, releases, build, buildLimits, skips } = inputs;

  if (!marks) unknown.push('Stalled, wasting: the job metrics file could not be read.');
  else {
    const lastStart = Math.max(-Infinity, ...marks.filter(m => m.kind === 'launched' || m.kind === 'merged').map(m => m.at));
    if (!Number.isFinite(lastStart) || now - lastStart >= STALL_MINUTES * MIN) {
      const known = Number.isFinite(lastStart);
      alerts.push({ kind: 'stalled', lane: 'fleet', since: new Date(known ? lastStart : now - ALERT_LOOKBACK_H * 3_600_000).toISOString(),
        detail: known ? `No job has started and no PR has merged for ${minutesText(now - lastStart)}.` : `No job has started and no PR has merged in the last ${ALERT_LOOKBACK_H} hours.`,
        fix_hint: 'Check that the dispatcher is running, then look for lanes with no work: phm fleet idle-lanes.' });
    }
    const byLane = new Map<string, ThroughputMark[]>();
    for (const m of marks) if (m.kind === 'finished' && m.route.lane !== 'unknown') byLane.set(m.route.lane, [...(byLane.get(m.route.lane) ?? []), m]);
    for (const [lane, finished] of [...byLane].sort((a, b) => a[0].localeCompare(b[0]))) {
      const last = finished.sort((a, b) => b.at - a.at).slice(0, WASTING_JOBS);
      const empty = last.filter(m => m.empty).length;
      if (last.length < WASTING_MIN_JOBS || empty / last.length <= WASTING_RATE) continue;
      alerts.push({ kind: 'wasting', lane, since: new Date(last[last.length - 1]!.at).toISOString(),
        detail: `${lane}: ${empty} of its last ${plural(last.length, 'job')} finished EMPTY (${Math.round(empty / last.length * 100)}%).`,
        fix_hint: 'See why they came back empty: phm fleet empty-causes.' });
    }
  }

  if (!starved) unknown.push('Starved: the lane snapshot could not be read.');
  else for (const [lane, row] of Object.entries(starved.lanes).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!row.starved) continue;
    const since = row.starved_since === null ? NaN : Date.parse(row.starved_since);
    if (!Number.isFinite(since)) { unknown.push(`Starved: ${lane} has free slots and nothing queued, but how long is not recorded yet.`); continue; }
    if (now - since < STALL_MINUTES * MIN) continue;
    alerts.push({ kind: 'starved', lane, since: row.starved_since,
      detail: `${lane} has ${plural(row.free_slots ?? 0, 'free slot')} and nothing queued for ${minutesText(now - since)}.`,
      fix_hint: `Add jobs for ${lane}: phm fleet idle-lanes.` });
  }

  if (!spend) unknown.push('Pool waste: the spend snapshot could not be read.');
  else {
    for (const row of spend.pools) {
      if (row.status !== 'behind') continue;
      if (row.projectedUnusedPercent === null) { unknown.push(`Pool waste: ${row.pool} is behind pace, but the unused share is not known.`); continue; }
      if (row.projectedUnusedPercent <= POOL_WASTE_PERCENT) continue;
      alerts.push({ kind: 'pool_waste', lane: row.pool, since: null,
        detail: `${row.pool} is on track to leave ${Math.round(row.projectedUnusedPercent)}% unused${row.resetsIn ? ` when it resets in ${row.resetsIn}` : ''}.`,
        fix_hint: `Queue more jobs for ${row.pool} before it resets.` });
    }
    if (!spend.pools.some(row => row.status !== 'unknown')) unknown.push(`Pool waste: ${spend.headline.replace(/^Unknown: /, '')}`);
  }

  if (releases === null) unknown.push('Release cadence: GitHub releases could not be read.');
  else if (releases) for (const row of releases.repos) {
    const since = row.published_at === 'unknown' ? null : row.published_at;
    if (row.status === 'unknown') { unknown.push(`Release cadence: ${row.repo} could not be read.`); continue; }
    if (row.status === 'stale') alerts.push({ kind: 'release_stale', lane: row.repo, since,
      detail: `${row.repo} last released ${row.latest_tag} ${Math.floor(row.hours_since as number)} hours ago and ${row.merged_since} PRs have merged since.`,
      fix_hint: `Cut a release for ${row.repo}: phm release cadence.` });
    else if (row.has_assets === false) alerts.push({ kind: 'release_stale', lane: row.repo, since,
      detail: `${row.repo} ${row.latest_tag} was published with 0 assets, so nobody can download it.`,
      fix_hint: `Re-run the release workflow for ${row.repo}: phm release cadence.` });
  }

  if (build === null) unknown.push('Live build: it could not be read.');
  else if (build) {
    const unidentified = buildUnidentifiedText(build);
    if (unidentified) alerts.push({ kind: 'build-stale', lane: 'unidentified', since: null, detail: unidentified.detail, fix_hint: unidentified.fix });
    else if (buildStaleness(build, now, buildLimits) === 'unknown') unknown.push('Live build: how far behind master is not known here.');
    const text = buildStaleText(build, now, buildLimits);
    if (text && build.commit?.state === 'known') {
      const behind = build.behind?.state === 'known' ? build.behind.since : null;
      alerts.push({ kind: 'build-stale', lane: build.commit.sha.slice(0, 7), since: behind ?? null, detail: text.detail, fix_hint: text.fix });
    }
  }

  if (skips === null) unknown.push('Skipped jobs: the job metrics file could not be read.');
  else if (skips && (skips.repeated.length || skips.leader_skipped.length)) {
    const parts = [
      skips.repeated.length ? `${skips.repeated.join(', ')} ${skips.repeated.length === 1 ? 'was' : 'were'} skipped more than once` : '',
      skips.leader_skipped.length ? `${skips.leader_skipped.join(', ')} ${skips.leader_skipped.length === 1 ? 'was' : 'were'} queued by the leader and skipped` : '',
    ].filter(Boolean);
    const first = skips.by_code.flatMap(g => g.jobs).map(j => Date.parse(j.at)).filter(Number.isFinite);
    alerts.push({ kind: 'skipped', lane: 'fleet', since: first.length ? new Date(Math.min(...first)).toISOString() : null,
      detail: `In the last ${SKIP_ALERT_HOURS} hours the precheck dropped jobs that may have been wrongly skipped: ${parts.join('; ')}.`,
      fix_hint: 'See why: phm jobs skipped.' });
  }

  const order = (a: PulseAlertV1) => PULSE_ALERT_KINDS.indexOf(a.kind);
  alerts.sort((a, b) => order(a) - order(b));
  return { schema: PULSE_ALERTS_SCHEMA, v: 1, as_of: new Date(now).toISOString(), alerts, unknown };
}

/** The one sentence a notice carries. */
export const alertNotice = (alert: PulseAlertV1): string => `Phantom alert: ${alert.detail} ${alert.fix_hint}`;

/** Plain lines for a terminal. A quiet fleet reads "All lanes busy." */
export function pulseAlertsText(pulse: PulseAlertsV1): string[] {
  const gaps = pulse.unknown.length ? [`Not checked: ${pulse.unknown.join(' ')}`] : [];
  if (!pulse.alerts.length) return [pulse.unknown.length ? 'No alerts.' : 'All lanes busy.', ...gaps];
  return [`${plural(pulse.alerts.length, 'alert')}:`, ...pulse.alerts.flatMap(a => [`  ${a.lane}: ${a.detail}`, `    ${a.fix_hint}`]), ...gaps];
}

// ---------------------------------------------------------------------------
// Notices: one per new alert, at most once an hour per alert.
// ---------------------------------------------------------------------------

export const PULSE_NOTIFY_STATE = join('state', 'pulse-alerts-notify.json');
export const NOTIFY_EVERY_MS = 3_600_000;
export type PulseNoticeSender = (text: string) => Promise<unknown>;
export interface PulseNoticeSenders { email?: PulseNoticeSender; telegram?: PulseNoticeSender }
type NotifyState = Record<string, number>;

const alertKey = (a: PulseAlertV1): string => `${a.kind}:${a.lane}`;
function readNotifyState(runsDir: string): NotifyState {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(runsDir, PULSE_NOTIFY_STATE), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => Number.isFinite(e[1])));
  } catch { return {}; }
}

/** Send one notice per alert not already sent in the last hour; returns the alerts sent. An alert is recorded as sent only when
 * a channel took it, so a failed send retries on the next call. Never throws. */
export async function notifyPulseAlerts(pulse: PulseAlertsV1, opts: { runsDir: string; now: number; senders: PulseNoticeSenders }): Promise<PulseAlertV1[]> {
  const state = readNotifyState(opts.runsDir), sent: PulseAlertV1[] = [];
  const next: NotifyState = {};
  // Keep only entries still inside the hour, so the file stays small. A build-stale entry is kept for as long as
  // that commit stays stale (one notice per commit, not one an hour) and dropped once it recovers.
  const stale = new Set(pulse.alerts.filter(a => a.kind === 'build-stale').map(alertKey));
  for (const [key, at] of Object.entries(state)) {
    if (key.startsWith('build-stale:') ? stale.has(key) : opts.now - at < NOTIFY_EVERY_MS) next[key] = at;
  }
  for (const alert of pulse.alerts) {
    if (next[alertKey(alert)] !== undefined) continue;
    let took = false;
    for (const send of [opts.senders.email, opts.senders.telegram]) {
      if (!send) continue;
      try { const r = await send(alertNotice(alert)); if (!(r && typeof r === 'object' && (r as { ok?: unknown }).ok === false)) took = true; } catch { /* next channel */ }
    }
    if (took) { next[alertKey(alert)] = opts.now; sent.push(alert); }
  }
  if (sent.length || Object.keys(next).length !== Object.keys(state).length) {
    try {
      const path = join(opts.runsDir, PULSE_NOTIFY_STATE);
      ensurePrivateDirectory(dirname(path));
      writePrivateFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch { /* the notice already went out; the next call may repeat it */ }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Read, then notify. The CLI and the desktop and phone Pulse strip call this.
// ---------------------------------------------------------------------------

/** Email outbox always; Telegram when configured. Same pair as `phm fleet main-red-notify`. */
async function defaultSenders(runsDir: string): Promise<PulseNoticeSenders> {
  const [{ writeSignificantEmail }, { sendTelegramMessage, telegramEnabled }, { loadConfigReadOnly }] = await Promise.all([
    import('./operator-glance-read.js'), import('../integrations/telegram.js'), import('../config.js'),
  ]);
  const senders: PulseNoticeSenders = { email: text => writeSignificantEmail(text, runsDir) };
  try {
    const cfg = loadConfigReadOnly();
    if (telegramEnabled(cfg)) senders.telegram = text => sendTelegramMessage(text, undefined, cfg);
  } catch { /* no usable config: Telegram stays off */ }
  return senders;
}

/** Saved Settings limits (`fleet.buildStale`) under the ASHLR_BUILD_STALE_COMMITS / _HOURS env overrides; an unreadable config keeps the defaults. */
async function buildLimitsFromConfig(env: NodeJS.ProcessEnv = process.env): Promise<BuildStaleLimits> {
  let saved = savedBuildStaleLimits(undefined);
  try { saved = savedBuildStaleLimits((await import('../config.js')).loadConfigReadOnly().fleet?.buildStale); } catch { /* defaults */ }
  const { commits, hours } = resolveBuildStaleLimits(saved, env);
  return { commits, hours };
}

/** Read every input once. Read-only; a reader that fails leaves its checks unknown. */
export async function readPulseAlertInputs(runsDir: string, now: number): Promise<PulseAlertInputs> {
  const quiet = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);
  const [{ readText }, { throughputMarks }, { readUsageSpend }] = await Promise.all([
    import('./empty-cause.js'), import('./throughput.js'), import('../usage/spend.js'),
  ]);
  const [ledger, starved, spend, releases] = await Promise.all([
    readText(join(runsDir, 'metrics', 'jobs.jsonl'), 32 * 1024 * 1024),
    quiet(import('./lane-console.js').then(m => m.getFleetLaneSnapshot()).then(snapshot => snapshot.starved)),
    quiet(readUsageSpend(join(runsDir, 'queue', 'status.json'), now)),
    quiet(import('../release/cadence.js').then(m => m.readReleaseCadence({ now }))),
  ]);
  const build = await quiet(import('./build-live.js').then(m => m.readBuildLive({ now: () => now })));
  return { marks: ledger === null ? null : throughputMarks(ledger, now - ALERT_LOOKBACK_H * 3_600_000, now).marks, starved, spend, releases, build, buildLimits: await buildLimitsFromConfig(),
    skips: ledger === null ? null : summarizeSkips(ledger, now, SKIP_ALERT_HOURS) };
}

export interface ReadPulseAlertsOpts {
  runsDir?: string; now?: number;
  /** Send a notice for each alert not sent in the last hour. Default false: a plain read changes nothing. */
  notify?: boolean;
  read?: typeof readPulseAlertInputs;
  senders?: PulseNoticeSenders;
}
export async function readPulseAlerts(opts: ReadPulseAlertsOpts = {}): Promise<PulseAlertsV1> {
  const now = opts.now ?? Date.now(), runsDir = opts.runsDir ?? defaultRunsDir();
  const pulse = buildPulseAlerts(await (opts.read ?? readPulseAlertInputs)(runsDir, now), now);
  if (opts.notify) await notifyPulseAlerts(pulse, { runsDir, now, senders: opts.senders ?? (pulse.alerts.length ? await defaultSenders(runsDir) : {}) }).catch(() => []);
  return pulse;
}
