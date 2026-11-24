/**
 * Host load-blocking evidence → self-improvement backlog items.
 *
 * When the dispatcher's admission-ctl reports `over_host` blocking,
 * the self-tick's applied runs take one host-load attribution snapshot
 * — at most one per ten minutes — through takeLoadSnapshot in
 * src/core/fleet/load-history.ts, appending a
 * `host.load.history.v1` row {at, load1, hostMax, contributors:
 * [{name, sharePercent}]} to `queue/host-load-history.jsonl` under the
 * fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR). The file
 * keeps seven days and 2,000 rows. Every recorded row is a blocked
 * moment by construction: the writer only snapshots while launches
 * are being held for host load.
 *
 * Until now the journal's only readers were `phm host load
 * --history` (the summarizeLoadHistory fold — per-hour peak load,
 * blocked minutes and top contributors), the pulse and the hourly
 * digest's blockedHourLine warning, which prints only while the last
 * hour shows more than BLOCKED_LINE_OVER_MINUTES blocked minutes, and
 * the contributor cross-references inside the sibling memory- and
 * controller-pressure prompts — reports and a transient warning
 * someone had to see. A host whose launches kept being held for load
 * — whether the fleet's own jobs and model server were the cause or
 * an owner-side app was — never became work even though each held
 * launch is fleet capacity the queue cannot use.
 *
 * loadBacklogItems carries the same journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling memory-pressure and disk-pressure sources
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail read; rows are validated by the same
 *    contract parseHistory applies — an object with finite numeric
 *    `at`, `load1`/`hostMax` each null or finite, and a contributors
 *    array of {name: string, sharePercent: finite} — and nothing is
 *    written and no process is inspected.
 *  - Missing or unreadable evidence yields no items. An absent,
 *    non-file or unreadable journal reads as no evidence — unknown
 *    stays unknown, never a guessed tally — while a truncated tail
 *    still folds the retained rows with the prompts stating the
 *    counts as lower bounds.
 *  - The verdicts are the production ones. The fold is
 *    summarizeLoadHistory itself — the same per-snapshot blocked-time
 *    attribution (each snapshot covers at most SNAPSHOT_MIN_GAP_MS
 *    toward the next) and the same blocked-time-weighted contributor
 *    shares `phm host load --history` prints — so an hour bucket's
 *    blockedMinutes and a contributor's sharePercent mean exactly
 *    what the report says they mean.
 *  - Recurring means recorded, on the fold's own bars. An item emits
 *    only while at least LOAD_RECURRING_HOURS distinct hour buckets
 *    inside the window each recorded at least
 *    LOAD_HOUR_MIN_BLOCKED_MINUTES blocked minutes — the same
 *    BLOCKED_LINE_OVER_MINUTES line the digest calls worth saying —
 *    AND those buckets span at least LOAD_MIN_DAYS separate UTC days,
 *    so one bad afternoon never queues a session. When the retained
 *    tail cannot show two days of recurrence the source stays quiet:
 *    the claim is recurrence, and a short window cannot prove it.
 *  - The dominant-contributor item is a refinement, not a second
 *    claim: it emits only while the blocked-hours recurrence holds
 *    AND the window's top contributor is fleet-side machinery —
 *    'fleet jobs' or 'local model server', the two labels
 *    contributorsOf attributes to this install — holding at least
 *    LOAD_DOMINANT_MIN_SHARE of blocked-time CPU share. External apps,
 *    'system', 'other apps' and 'other' never mint the second item:
 *    the blocked-hours item already names them as evidence, and a
 *    dominant owner-side app has no repo-side fix the fleet can ship.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and fleet machinery. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Both ids are stable strings — the dominant
 *    id keys on the fixed fleet-contributor vocabulary, never the
 *    counts or timestamps — so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; shifted tallies do
 *    not spawn twin items and a quiet window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the snapshot cadence and the digest's
 *    own threshold ride in the evidence, and the brief names the
 *    journal, `phm host load --history`, the digest/pulse warning
 *    and the pinned contrib/mac machinery boundary — with the usual
 *    no-change escape when the window no longer reproduces or the
 *    cause is owner-side or pinned ops machinery.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  BLOCKED_LINE_OVER_MINUTES,
  LOAD_HISTORY_FILE,
  summarizeLoadHistory,
  type LoadContributor,
  type LoadSnapshotRow,
} from '../fleet/load-history.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit: at most one per evidence axis. */
export const LOAD_BACKLOG_MAX_ITEMS = 2;
const LOAD_ITEM_HARD_MAX = 25;
/**
 * Evidence window: seven days, the same convention the friction,
 * tick-health, memory and disk sources apply — also the journal's own
 * retention, so the fold sees everything the writer kept.
 */
export const LOAD_WINDOW_HOURS = 168;
/**
 * Blocked minutes one hour bucket needs before it counts as a blocked
 * hour — the same BLOCKED_LINE_OVER_MINUTES the digest's blockedHourLine
 * and the pulse warning apply to the last hour, so a qualifying bucket
 * is one the fleet's own rule would have flagged.
 */
export const LOAD_HOUR_MIN_BLOCKED_MINUTES = BLOCKED_LINE_OVER_MINUTES;
/**
 * Distinct blocked hour buckets that must qualify inside the window
 * before the axis counts as recurring.
 */
export const LOAD_RECURRING_HOURS = 6;
/** Those recurring hours must span at least this many separate UTC days — one bad day is an incident, not a pattern. */
export const LOAD_MIN_DAYS = 2;
/**
 * Blocked-time CPU share the window's top contributor must hold before
 * the fleet-dominance refinement can emit — a majority share, so a
 * merely-plurality contributor never mints the second item.
 */
export const LOAD_DOMINANT_MIN_SHARE = 50;
/** Bounded tail for the journal; the writer keeps at most 2,000 rows of a few hundred bytes each. */
const LOAD_LEDGER_TAIL_BYTES = 1024 * 1024;
/** The fleet's own repository label: host load evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/**
 * The contributor labels contributorsOf attributes to this install's own
 * machinery — fleet dispatches and the local model server. Named apps,
 * 'system', 'other apps' and 'other' are owner-side or unattributed and
 * never mint the dominance item.
 */
const FLEET_CONTRIBUTOR_SLUGS: Record<string, string> = {
  'fleet jobs': 'fleet-jobs',
  'local model server': 'local-model-server',
};
const HOUR_MS = 3_600_000;

export interface LoadItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/host-load-history.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LOAD_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in hours (default LOAD_WINDOW_HOURS). */
  windowHours?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** Recurring-hour tally for one evidence axis: qualifying buckets and the days they span. */
export interface LoadHourEvidence {
  /** Distinct hour buckets meeting the recurrence bar inside the window. */
  hours: number;
  /** Distinct UTC days those buckets fall on. */
  days: number;
}

/** A window contributor with its blocked-hour dominance tally. */
export interface LoadContributorEvidence {
  name: string;
  /** Share of blocked-time-weighted CPU the production fold recorded (0-100, rounded). */
  sharePercent: number;
  /** Qualifying blocked hour buckets where this contributor ranked first. */
  topHours: number;
}

/** The fold's measured evidence; every count is over in-window valid rows only. */
export interface LoadEvidence {
  /** 'known' when the window holds at least one valid snapshot; 'unknown' is no evidence, never a zero. */
  state: 'known' | 'unknown';
  /** Valid snapshot rows inside the window. */
  snapshots: number;
  /** Lines that were not a valid snapshot row; ignored, never guessed. */
  invalidRows: number;
  /** Valid rows dated outside the window or in the future; not evidence either way. */
  outsideWindow: number;
  /** True when the retained tail dropped older bytes — coverage is the retained window only. */
  ledgerTruncated: boolean;
  /** Snapshot-time bounds across the in-window rows; null when none parsed. */
  oldestAt: string | null;
  newestAt: string | null;
  /** The production fold's window blocked-minutes estimate; null when no rows. */
  blockedMinutes: number | null;
  /** Hour buckets holding at least one in-window snapshot. */
  judgedHours: number;
  /** Buckets recording at least LOAD_HOUR_MIN_BLOCKED_MINUTES blocked minutes, and the days they span. */
  blockedHours: LoadHourEvidence;
  /** The production fold's top contributors by blocked-time share, each with its first-place hour tally. */
  top: LoadContributorEvidence[];
  /** The top contributor when it is fleet-side machinery holding a majority share; null otherwise. */
  dominant: LoadContributorEvidence | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * One line under the writer's contract — the same check parseHistory's
 * validRow applies: an object with finite numeric `at` (ms epoch),
 * `load1`/`hostMax` each null or finite, and a contributors array whose
 * every entry carries a string name and a finite sharePercent. Anything
 * else is not a snapshot.
 */
function loadSnapshotRow(value: unknown): LoadSnapshotRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const at = row['at'];
  const load1 = row['load1'];
  const hostMax = row['hostMax'];
  const contributors = row['contributors'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (!(load1 === null || (typeof load1 === 'number' && Number.isFinite(load1)))) return null;
  if (!(hostMax === null || (typeof hostMax === 'number' && Number.isFinite(hostMax)))) return null;
  if (!Array.isArray(contributors)) return null;
  const parsed: LoadContributor[] = [];
  for (const c of contributors) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const entry = c as Record<string, unknown>;
    const name = entry['name'];
    const sharePercent = entry['sharePercent'];
    if (typeof name !== 'string' || typeof sharePercent !== 'number' || !Number.isFinite(sharePercent)) return null;
    parsed.push({ name, sharePercent });
  }
  return { at, load1: load1 as number | null, hostMax: hostMax as number | null, contributors: parsed };
}

/**
 * Pure: fold parsed journal lines into the load evidence. `values` are
 * the JSON.parsed ledger lines; each is validated by loadSnapshotRow —
 * the writer's own structural check — then sorted by `at` (the order
 * summarizeLoadHistory's gap attribution requires, the same order
 * parseHistory produces) and folded through summarizeLoadHistory
 * itself. Unknown stays unknown: unparseable or off-contract lines
 * count as invalidRows, out-of-window rows as outsideWindow, and an
 * empty window reports state 'unknown', never a zero.
 */
export function foldLoadEvidence(
  values: readonly unknown[],
  opts: { nowMs: number; windowHours?: number },
): LoadEvidence {
  const windowHours = opts.windowHours ?? LOAD_WINDOW_HOURS;
  const nowMs = opts.nowMs;
  const windowStart = nowMs - windowHours * HOUR_MS;
  const evidence: LoadEvidence = {
    state: 'unknown', snapshots: 0, invalidRows: 0, outsideWindow: 0,
    ledgerTruncated: false, oldestAt: null, newestAt: null,
    blockedMinutes: null, judgedHours: 0,
    blockedHours: { hours: 0, days: 0 },
    top: [], dominant: null,
  };
  const rows: LoadSnapshotRow[] = [];
  for (const value of values) {
    const row = loadSnapshotRow(value);
    if (row === null) { evidence.invalidRows += 1; continue; }
    rows.push(row);
  }
  rows.sort((a, b) => a.at - b.at);
  const inWindow = rows.filter((row) => row.at >= windowStart && row.at <= nowMs);
  evidence.outsideWindow = rows.length - inWindow.length;
  if (inWindow.length === 0) return evidence;
  evidence.oldestAt = new Date(inWindow[0]!.at).toISOString();
  evidence.newestAt = new Date(inWindow[inWindow.length - 1]!.at).toISOString();
  const report = summarizeLoadHistory(inWindow, nowMs, windowHours);
  evidence.state = report.state;
  evidence.snapshots = report.snapshots;
  evidence.blockedMinutes = report.blockedMinutes;
  evidence.judgedHours = report.hours.length;
  const blockedRows = report.hours.filter((h) => h.blockedMinutes >= LOAD_HOUR_MIN_BLOCKED_MINUTES);
  evidence.blockedHours = {
    hours: blockedRows.length,
    days: new Set(blockedRows.map((h) => h.hour.slice(0, 10))).size,
  };
  const topHoursByName = new Map<string, number>();
  for (const h of blockedRows) {
    const name = h.top[0]?.name;
    if (name !== undefined) topHoursByName.set(name, (topHoursByName.get(name) ?? 0) + 1);
  }
  evidence.top = report.top.map((c: LoadContributor) => ({
    name: c.name,
    sharePercent: c.sharePercent,
    topHours: topHoursByName.get(c.name) ?? 0,
  }));
  const first = evidence.top[0];
  if (first !== undefined && first.sharePercent >= LOAD_DOMINANT_MIN_SHARE && Object.hasOwn(FLEET_CONTRIBUTOR_SLUGS, first.name)) {
    evidence.dominant = first;
  }
  return evidence;
}

const NO_CHANGE = 'If the window has rolled forward, the blocking was a one-off burst the later snapshots recovered from, or the cause is owner-only or pinned ops machinery (credentials, billing, host disk or memory, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/host-load-history.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema host.load.history.v1 — one {at, load1, hostMax, contributors:[{name, sharePercent}]} row per snapshot src/core/fleet/load-history.ts\'s takeLoadSnapshot appends during an applied fleet self-tick, at most one per 10 minutes and only while the dispatcher\'s queue/admission-ctl.json reports over_host blocking (7 days / 2,000 rows kept) — folded by this feed through the same row contract and summarizeLoadHistory hour fold `phm host load --history` prints, against the same BLOCKED_LINE_OVER_MINUTES worth-saying line the digest\'s blockedHourLine and the pulse warning apply to the last hour.';

function spanText(ev: LoadEvidence): string {
  if (ev.oldestAt === null || ev.newestAt === null) return '';
  return ev.oldestAt === ev.newestAt
    ? ` Recorded ${ev.oldestAt}.`
    : ` Recorded ${ev.oldestAt} through ${ev.newestAt}.`;
}

function coverageNote(ev: LoadEvidence): string {
  const notes: string[] = [];
  if (ev.ledgerTruncated) notes.push('the retained tail dropped older rows, so every count is a lower bound');
  if (ev.invalidRows > 0) notes.push(`${ev.invalidRows} malformed lines dropped`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function topText(ev: LoadEvidence): string {
  if (ev.top.length === 0) return 'no contributor shares were recorded';
  return ev.top.map((c) => `${nameText(c.name)} ${c.sharePercent}%`).join(', ');
}

/** Ledger-recorded labels are unbounded text; scrub, flatten and cap before they reach a prompt. */
function nameText(name: string): string {
  return scrubSecrets(name).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 60) || 'unnamed';
}

function recurring(ev: LoadEvidence): boolean {
  return ev.blockedHours.hours >= LOAD_RECURRING_HOURS && ev.blockedHours.days >= LOAD_MIN_DAYS;
}

function blockedPrompt(ev: LoadEvidence): string {
  return [
    `Phantom's fleet host keeps blocking launches on machine load — ${ev.blockedHours.hours} distinct hour buckets across ${ev.blockedHours.days} UTC days inside the window each recorded at least ${LOAD_HOUR_MIN_BLOCKED_MINUTES} blocked minutes, the self-improvement work this backlog exists for.`,
    '',
    `The self-tick snapshots host load at most once per 10 minutes and only while the dispatcher reports over_host blocking, so every recorded row is a blocked moment: ${ev.snapshots} snapshots across ${ev.judgedHours} hour buckets estimate ${ev.blockedMinutes ?? 'unknown'} blocked minutes in the window, with ${topText(ev)} holding the largest shares of blocked-time CPU.${spanText(ev)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find what is loading the host: the recorded contributor names are the first suspects — recurring 'fleet jobs' or 'local model server' dominance means this fleet's own parallelism, worker footprints or model-server concurrency is the cause (lane targets, queue producers and job shapes live in this repo; the contrib/mac dispatcher files that enforce the caps are pinned ops machinery); recurring named apps, 'system' or 'other apps' mean owner-side or OS load the fleet can only route around. Fix what lives in this repo — lane parallelism and targets, launch fan-out, footprint reductions; if the load is owner-side apps or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function dominantPrompt(ev: LoadEvidence, d: LoadContributorEvidence): string {
  const name = nameText(d.name);
  const fleetJobs = d.name === 'fleet jobs';
  const cause = fleetJobs
    ? 'fleet jobs means worker parallelism, launch fan-out and per-job footprints: the lane targets, queue producers and job shapes this repo owns decide how much CPU the fleet asks this host for, while the contrib/mac dispatcher files that enforce the caps are pinned ops machinery'
    : 'the local model server means local-inference load: lane model placement, which lanes run local models and the server\'s own concurrency and quantization posture are the suspects this repo owns';
  return [
    `Phantom's fleet host keeps blocking launches on machine load, and ${name} dominates the recorded cause — it held ${d.sharePercent}% of blocked-time CPU share across the window and ranked first in ${d.topHours} of ${ev.blockedHours.hours} recurring blocked hour buckets, the self-improvement work this backlog exists for.`,
    '',
    `The fleet's own machinery is the measured cause, not an owner-side app: ${cause}. ${ev.snapshots} snapshots across ${ev.judgedHours} hour buckets estimate ${ev.blockedMinutes ?? 'unknown'} blocked minutes in the window; ${topText(ev)}.${spanText(ev)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Reduce what this repo asks the host for: lane targets and autopilot posture, queue producers and job shapes that fan out too wide, per-job footprints, and — for the model server — lane model placement and local-inference concurrency. The contrib/mac dispatcher admission constants are pinned ops machinery: if the evidence says the caps themselves are wrong, report no-change and name the measurement rather than editing them. ${NO_CHANGE}`,
  ].join('\n');
}

/** Deterministic, readable slug for the fixed fleet-contributor vocabulary; anything unexpected hashes instead of leaking text. */
function dominantSlug(name: string): string {
  const known = Object.hasOwn(FLEET_CONTRIBUTOR_SLUGS, name) ? FLEET_CONTRIBUTOR_SLUGS[name] : undefined;
  if (known !== undefined) return known;
  return createHash('sha256').update(name).digest('hex').slice(0, 12);
}

function loadItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, 200),
    prompt,
    area: 'host-load',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the host-load journal's recurring blocked-launch
 * evidence. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function loadBacklogItems(opts: LoadItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the self-tick and vitals reads apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const ledger = await readLedgerTail(join(runsDir, LOAD_HISTORY_FILE), LOAD_LEDGER_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const values: unknown[] = [];
    for (const line of ledger.text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); } catch { values.push(null); }
    }
    const evidence = foldLoadEvidence(values, { nowMs, windowHours: opts.windowHours });
    evidence.ledgerTruncated = ledger.truncated;
    const items: CloudBacklogItem[] = [];
    if (recurring(evidence)) {
      items.push(loadItem(
        'host-load-blocked-hours',
        'Fleet host keeps blocking launches on machine load',
        blockedPrompt(evidence),
        repo,
      ));
      if (evidence.dominant !== null) {
        const d = evidence.dominant;
        items.push(loadItem(
          `host-load-dominant-${dominantSlug(d.name)}`,
          `${d.name} dominates the host load blocking fleet launches`,
          dominantPrompt(evidence, d),
          repo,
        ));
      }
    }
    const limit = Math.max(1, Math.min(opts.limit ?? LOAD_BACKLOG_MAX_ITEMS, LOAD_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
