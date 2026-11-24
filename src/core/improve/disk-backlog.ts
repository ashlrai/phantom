/**
 * Host disk-pressure evidence → self-improvement backlog items.
 *
 * Two sample files under the fleet runs directory record free disk:
 * `queue/host-disk-samples.json` — one {at, free_gb} row per applied
 * self-tick (at most one per 5 minutes, 48 hours kept;
 * src/core/fleet/host-disk.ts recordDiskSample) — and
 * `queue/disk-growth-history.json` — the contrib/mac/disk-growth.py
 * sampler's rows (48 samples kept). `phm host disk` merges both and
 * folds them through diskBurn/diskLowLine into the status,
 * hoursToFreeze and warning its report and the hourly digest's
 * disk_low blocker print; `phm fleet vitals`' disk section, `phm host
 * top`'s disk trend and `phm fleet disk-forecast` read the same
 * evidence. Until now every reader was a report someone had to run
 * or a transient warning line — nothing folded the recurrence into
 * work, so a host whose disk keeps trending into the lane-freeze
 * line (`compact.lanes.raise_freeze_below_gb`, default 60 GB) never
 * became a backlog item even though each below-freeze hour is fleet
 * capacity the autopilot cannot use.
 *
 * diskBacklogItems carries the same samples into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling memory-pressure source beside it.
 *
 * Two evidence axes, both anchored to the fleet's own disk_low rule:
 *   - below the freeze line: the hour's closing diskBurn verdict is
 *     'below-threshold' — the newest sample recorded for that hour
 *     read free disk under the freeze line, so lanes were freezing.
 *   - freeze runway: the closing verdict is 'falling' with
 *     hoursToFreeze under DISK_LOW_HOURS — the exact condition the
 *     digest's disk_low warning prints — without yet crossing the
 *     line.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both files are JSON arrays read through readSource's
 *    bounded no-follow whole-file read (5 MiB, the same bound
 *    host-top applies to the sampler history); rows are validated by
 *    the {at, free_gb} contract parseDiskHistory applies plus the
 *    non-negative guard readDiskSampleRows enforces; nothing is
 *    written and no process is inspected.
 *  - Missing or unreadable evidence yields no items. An absent,
 *    non-file, oversized or degraded file reads as that source's own
 *    state — never a guessed tally — a body that is not a JSON array
 *    of rows is 'invalid', and rows failing validation count as
 *    invalidRows, never zero-filled. Both sources missing leaves no
 *    samples and no items.
 *  - Recurring means recorded, on the fold's own bars. An item emits
 *    only while at least DISK_RECURRING_HOURS distinct judged hour
 *    buckets inside the window each closed on the axis's verdict,
 *    spanning at least DISK_MIN_DAYS separate UTC days — where a
 *    judged hour is one with at least DISK_HOUR_MIN_SAMPLES recorded
 *    samples whose closing diskBurn verdict was determinate
 *    ('steady', 'falling' or 'below-threshold'; 'unknown' can judge
 *    neither way). When the retained tail cannot show two days of
 *    recurrence the source stays quiet: the claim is recurrence, and
 *    a short window cannot prove it.
 *  - The verdicts are the production ones. Each judged hour's burn is
 *    diskBurn over the merged samples up to that hour's last reading
 *    — the same 6-hour trailing window, 10-minute minimum span, 0.1
 *    GB/h steady line and freeze comparison `phm host disk` applies —
 *    and the freeze line is readFreezeLine's live-config value, so a
 *    config change re-anchors every hour the way the report would.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet machinery. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Both ids are stable strings, so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only what
 *    is new; shifted tallies do not spawn twin items and a quiet
 *    window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the freeze line and its config source
 *    ride in the evidence, and the brief names the sample files,
 *    `phm host disk`, the digest's disk_low warning and the
 *    worktree/reap surfaces — with the usual no-change escape when
 *    the window no longer reproduces or the cause is owner-side.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  DISK_GROWTH_HISTORY_FILE,
  DISK_LOW_HOURS,
  diskBurn,
  diskLowLine,
  HOST_DISK_SAMPLES_FILE,
  readFreezeLine,
} from '../fleet/host-disk.js';
import type { HostDiskSample } from '../fleet/host-top-view.js';
import { readSource, type Source } from '../fleet/runs-parked-queue.js';

/** Items one call may emit: at most one per evidence axis. */
export const DISK_MAX_ITEMS = 2;
const DISK_ITEM_HARD_MAX = 25;
/**
 * Evidence window: seven days, the same convention the friction,
 * tick-health, memory and ci-rerun sources apply. The retained tail —
 * 48 hours of self-tick samples plus the sampler's 48 rows — may cover
 * less; the fold uses what the window holds and the recurrence bars
 * keep short coverage honest.
 */
export const DISK_WINDOW_HOURS = 168;
/**
 * Recorded samples one hour bucket needs before its closing verdict
 * can judge it — sparse hours never count toward recurrence. The
 * self-tick writes at most one row per 5 minutes (~12 an hour), so
 * four readings still make an hour representative while tolerating
 * missed ticks.
 */
export const DISK_HOUR_MIN_SAMPLES = 4;
/**
 * Distinct judged hour buckets that must each close on the axis's
 * verdict before it counts as recurring.
 */
export const DISK_RECURRING_HOURS = 6;
/** Those recurring hours must span at least this many separate UTC days — one bad day is an incident, not a pattern. */
export const DISK_MIN_DAYS = 2;
/** The fleet's own repository label: host disk evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Whole-file read bound per sample file — the same 5 MiB host-top applies to the sampler history. */
const DISK_SAMPLE_MAX_BYTES = 5 * 1024 * 1024;
const HOUR_S = 3600;
const HOUR_MS = 3_600_000;

export interface DiskItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/host-disk-samples.json and queue/disk-growth-history.json; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default DISK_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One sample file's read state plus its parsed rows; 'invalid' is a readable body that is not the {at, free_gb} array contract. */
export type DiskSourceState = Source | 'invalid';

export interface DiskSampleSource {
  /** Queue-relative file name, for evidence and prompts. */
  name: string;
  state: DiskSourceState;
  /** Rows that passed the sample contract, before merge dedupe and windowing. */
  samples: readonly HostDiskSample[];
  /** Array elements that failed the contract; a non-array body counts as one invalid record. */
  invalidRows: number;
}

/** Recurring-hour tally for one evidence axis: qualifying buckets and the days they span. */
export interface DiskHourEvidence {
  /** Distinct judged hour buckets closing on the axis's verdict inside the window. */
  hours: number;
  /** Distinct UTC days those buckets fall on. */
  days: number;
}

/** The fold's measured evidence; every count is over in-window merged rows only. */
export interface DiskEvidence {
  /** Valid merged samples inside the window (deduped by timestamp across both files). */
  samples: number;
  /** Rows that failed the sample contract in either file, plus unparseable bodies. */
  invalidRows: number;
  /** Valid merged rows dated outside the window or in the future; not evidence either way. */
  outsideWindow: number;
  /** Per-file read state and row yields, so the prompt can say what the coverage actually was. */
  sources: Array<{ name: string; state: DiskSourceState; rows: number; invalidRows: number }>;
  /** Sample-time bounds across the in-window rows; null when none parsed. */
  oldestAt: string | null;
  newestAt: string | null;
  /** The freeze line the verdicts were judged against and which config layer supplied it. */
  freezeBelowGb: number;
  freezeSource: string;
  /** Hour buckets with enough samples for a determinate closing verdict ('steady', 'falling' or 'below-threshold'). */
  judgedHours: number;
  /** Judged hours closing below the freeze line, and the days they span. */
  belowHours: DiskHourEvidence;
  /** Judged hours closing on the disk_low runway condition (falling, under DISK_LOW_HOURS to freeze) without crossing the line. */
  runwayHours: DiskHourEvidence;
  /** In-window samples recording free disk under the freeze line. */
  samplesBelowFreeze: number;
  /** The most recent judged hour's recorded burn; null when that hour's rate was unknown. */
  latestBurnGbPerHour: number | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * One row under the contract parseDiskHistory applies — an object with
 * finite numeric `at` and `free_gb` — plus the non-negative guard
 * readDiskSampleRows enforces before a sample can steer a verdict.
 * Anything else is not a sample.
 */
function diskSampleRow(value: unknown): HostDiskSample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { at, free_gb: freeGb } = value as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) return null;
  if (typeof freeGb !== 'number' || !Number.isFinite(freeGb) || freeGb < 0) return null;
  return { at, freeGb };
}

/**
 * Bounded no-follow read of one sample file. A missing, non-file or
 * oversized source keeps readSource's own state; a readable body that
 * is not a JSON array of rows is 'invalid' — the file exists but its
 * content cannot be evidence.
 */
async function readDiskSampleSource(runsDir: string, name: string): Promise<DiskSampleSource> {
  const source = await readSource(join(runsDir, name), DISK_SAMPLE_MAX_BYTES, false);
  if (source.state !== 'healthy') return { name, state: source.state, samples: [], invalidRows: 0 };
  let body: unknown;
  try { body = JSON.parse(source.text); } catch { return { name, state: 'invalid', samples: [], invalidRows: 1 }; }
  if (!Array.isArray(body)) return { name, state: 'invalid', samples: [], invalidRows: 1 };
  const samples: HostDiskSample[] = [];
  let invalidRows = 0;
  for (const value of body) {
    const row = diskSampleRow(value);
    if (row === null) invalidRows += 1;
    else samples.push(row);
  }
  return { name, state: 'healthy', samples, invalidRows };
}

interface HourBucket {
  /** Recorded samples whose timestamp fell inside this UTC hour. */
  count: number;
  /** Index of the bucket's last sample in the merged, sorted row array. */
  lastIndex: number;
}

/**
 * Pure: fold parsed sample sources into the disk evidence. Sources are
 * merged by timestamp — a later source wins a same-second tie, the
 * same overwrite order readDiskSampleRows applies (sampler history,
 * then self-tick samples) — then windowed on each sample's own `at`.
 * Each judged hour's verdict is diskBurn over the merged rows up to
 * that hour's last reading, exactly the trailing-6-hour computation
 * `phm host disk` runs; unknown stays unknown — an hour whose verdict
 * cannot be determined is never judged, and an axis emits only at the
 * recurring bars.
 */
export function foldDiskEvidence(
  sources: readonly DiskSampleSource[],
  opts: { nowMs: number; freezeBelowGb: number; freezeSource?: string; windowHours?: number },
): DiskEvidence {
  const windowMs = (opts.windowHours ?? DISK_WINDOW_HOURS) * HOUR_MS;
  const windowStart = opts.nowMs - windowMs;
  const freezeBelowGb = opts.freezeBelowGb;
  const evidence: DiskEvidence = {
    samples: 0, invalidRows: 0, outsideWindow: 0,
    sources: sources.map((s) => ({ name: s.name, state: s.state, rows: s.samples.length, invalidRows: s.invalidRows })),
    oldestAt: null, newestAt: null,
    freezeBelowGb, freezeSource: opts.freezeSource ?? 'default',
    judgedHours: 0,
    belowHours: { hours: 0, days: 0 },
    runwayHours: { hours: 0, days: 0 },
    samplesBelowFreeze: 0,
    latestBurnGbPerHour: null,
  };
  for (const source of sources) evidence.invalidRows += source.invalidRows;
  const byAt = new Map<number, number>();
  for (const source of sources) {
    for (const row of source.samples) byAt.set(row.at, row.freeGb);
  }
  const rows = [...byAt].map(([at, freeGb]) => ({ at, freeGb })).sort((a, b) => a.at - b.at);
  const buckets = new Map<number, HourBucket>();
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;
  rows.forEach((row, index) => {
    const atMs = row.at * 1000;
    if (atMs < windowStart || atMs > opts.nowMs) { evidence.outsideWindow += 1; return; }
    evidence.samples += 1;
    oldestMs = Math.min(oldestMs, atMs);
    newestMs = Math.max(newestMs, atMs);
    if (row.freeGb < freezeBelowGb) evidence.samplesBelowFreeze += 1;
    const hour = Math.floor(row.at / HOUR_S);
    let bucket = buckets.get(hour);
    if (bucket === undefined) { bucket = { count: 0, lastIndex: -1 }; buckets.set(hour, bucket); }
    bucket.count += 1;
    bucket.lastIndex = index;
  });
  if (evidence.samples > 0) {
    evidence.oldestAt = new Date(oldestMs).toISOString();
    evidence.newestAt = new Date(newestMs).toISOString();
  }
  const below = { hours: 0, days: new Set<string>() };
  const runway = { hours: 0, days: new Set<string>() };
  for (const [hour, bucket] of buckets) {
    if (bucket.count < DISK_HOUR_MIN_SAMPLES) continue;
    const last = rows[bucket.lastIndex];
    if (!last) continue;
    // The verdict "as of" the hour's last reading: diskBurn's own
    // trailing window reaches back before the hour, so the prefix —
    // not just the hour's rows — is what the report would have seen.
    const burn = diskBurn(rows.slice(0, bucket.lastIndex + 1), freezeBelowGb, last.at * 1000);
    if (burn.status === 'unknown') continue;
    evidence.judgedHours += 1;
    evidence.latestBurnGbPerHour = burn.burnGbPerHour;
    const day = new Date(hour * HOUR_S * 1000).toISOString().slice(0, 10);
    if (burn.status === 'below-threshold') { below.hours += 1; below.days.add(day); }
    else if (diskLowLine(burn) !== null) { runway.hours += 1; runway.days.add(day); }
  }
  evidence.belowHours = { hours: below.hours, days: below.days.size };
  evidence.runwayHours = { hours: runway.hours, days: runway.days.size };
  return evidence;
}

const NO_CHANGE = 'If the window has rolled forward, the pressure was a one-off burst the next samples recovered from, or the cause is owner-side or pinned ops machinery (credentials, billing, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin, or consumption outside the fleet runs tree) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the files, their writers and their existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/host-disk-samples.json and queue/disk-growth-history.json under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — {at, free_gb} arrays written by the self-tick\'s recordDiskSample (one reading per 5 minutes, 48 hours kept) and the contrib/mac/disk-growth.py sampler — merged and folded by this feed through the same diskBurn and diskLowLine verdicts `phm host disk` reports and the hourly digest\'s disk_low blocker prints, against the freeze line `compact.lanes.raise_freeze_below_gb` that readFreezeLine resolves from the fleet\'s layered config.';

function spanText(ev: DiskEvidence): string {
  if (ev.oldestAt === null || ev.newestAt === null) return '';
  return ev.oldestAt === ev.newestAt
    ? ` Recorded ${ev.oldestAt}.`
    : ` Recorded ${ev.oldestAt} through ${ev.newestAt}.`;
}

function sourceNote(ev: DiskEvidence): string {
  const bad = ev.sources.filter((s) => s.state !== 'healthy');
  if (bad.length === 0) return 'Both sample files read healthy.';
  return `${bad.map((s) => `\`${s.name}\` was ${s.state}`).join(' and ')} — coverage is the healthy sources only.`;
}

function belowPrompt(ev: DiskEvidence): string {
  return [
    `Phantom's fleet host keeps dropping below the disk freeze line — ${ev.belowHours.hours} distinct hour buckets across ${ev.belowHours.days} UTC days inside the window each closed with free disk under the ${ev.freezeBelowGb} GB line where lanes freeze, the self-improvement work this backlog exists for.`,
    '',
    `Of ${ev.samples} recorded samples, ${ev.samplesBelowFreeze} sat below the freeze line; ${ev.judgedHours} hour buckets carried enough readings for a determinate verdict. Every below-freeze hour is fleet capacity the autopilot could not use — lane raises freeze at this line.${spanText(ev)} ${sourceNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find what is consuming the disk: finished job worktrees (\`phm worktrees plan\` lists the reapable set and its GB), job-folder retention, model weights, logs and caches — \`phm host disk\`'s worktrees section and the top growers queue/disk-growth.json records are the first suspects. Fix what lives in this repo (reap and retention paths, growth detectors, the freeze-line config if the evidence supports a different value); if the consumer is owner-side apps or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function runwayPrompt(ev: DiskEvidence): string {
  const burn = ev.latestBurnGbPerHour === null ? 'an unrecorded pace' : `about ${ev.latestBurnGbPerHour} GB an hour`;
  return [
    `Phantom's fleet host disk keeps burning toward the lane-freeze line — ${ev.runwayHours.hours} distinct hour buckets across ${ev.runwayHours.days} UTC days inside the window each closed falling fast enough to reach the ${ev.freezeBelowGb} GB freeze line in under ${DISK_LOW_HOURS} hours — the fleet's own disk_low condition — without yet crossing it, the self-improvement work this backlog exists for.`,
    '',
    `Of ${ev.samples} recorded samples across ${ev.judgedHours} judged hour buckets, the disk kept a falling verdict with under ${DISK_LOW_HOURS} hours of runway; the most recent judged hour burned ${burn}. A host on this trajectory freezes lanes on a delay — the digest's disk_low warning prints each time but nothing folds the recurrence into work.${spanText(ev)} ${sourceNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find the sustained consumer: job worktrees and job-folder retention, model weights, logs, caches — \`phm host disk\`'s worktrees section and queue/disk-growth.json's recorded top growers are the first suspects, and \`phm fleet disk-forecast\` projects the same histories against its own threshold. Fix what lives in this repo (reap and retention paths, growth detectors, producers that leave large artifacts); if the burn is owner-side apps or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function recurring(ev: DiskEvidence, axis: 'below' | 'runway'): boolean {
  const hours = axis === 'below' ? ev.belowHours : ev.runwayHours;
  return hours.hours >= DISK_RECURRING_HOURS && hours.days >= DISK_MIN_DAYS;
}

function diskItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, 200),
    prompt,
    area: 'disk-pressure',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the host disk sample files' recurring freeze-line
 * evidence. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function diskBacklogItems(opts: DiskItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the vitals and host-disk reads apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const [sampler, selfTick, freeze] = await Promise.all([
      readDiskSampleSource(runsDir, DISK_GROWTH_HISTORY_FILE),
      readDiskSampleSource(runsDir, HOST_DISK_SAMPLES_FILE),
      readFreezeLine(runsDir),
    ]);
    const evidence = foldDiskEvidence([sampler, selfTick], { nowMs, freezeBelowGb: freeze.gb, freezeSource: freeze.source });
    const items: CloudBacklogItem[] = [];
    if (recurring(evidence, 'below')) {
      items.push(diskItem(
        'disk-below-freeze-hours',
        'Fleet host disk keeps dropping below the lane-freeze line',
        belowPrompt(evidence),
        repo,
      ));
    }
    if (recurring(evidence, 'runway')) {
      items.push(diskItem(
        'disk-freeze-runway-hours',
        'Fleet host disk keeps burning toward the lane-freeze line',
        runwayPrompt(evidence),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? DISK_MAX_ITEMS, DISK_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
