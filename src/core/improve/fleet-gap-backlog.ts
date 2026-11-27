/**
 * Fleet gap evidence → self-improvement backlog items.
 *
 * `phm fleet gaps` (src/core/fleet/sleep-gaps.ts) folds three bounded
 * reads — the PLANNER_TICK lines the planner tick appends to
 * queue/dispatch-events.log (falling back to dispatch-events.log), the
 * `launch` rows of metrics/jobs.jsonl and the queue/clock-samples.json
 * wall-versus-monotonic pairs a self-tick records — into every stretch
 * of GAP_MIN_MINUTES+ minutes where the dispatcher stopped ticking or
 * stopped launching while jobs sat queued, each stamped with a cause:
 * host-asleep, dispatcher-stalled, admission-blocked, queue-empty or
 * unknown. Until now those gaps reached only `phm fleet gaps` itself,
 * the hourly digest's first-line blocker and gapLine summaries —
 * reports someone had to open. A dispatcher that keeps stalling, or
 * admission that keeps refusing launches, never became work even
 * though each gap is fleet capacity the queue could not use and, when
 * the queue was non-empty, jobs that did not run.
 *
 * fleetGapBacklogItems carries the same fold into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling load-, memory- and disk-pressure sources.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. dispatch-events.log is read through readLedgerTail's
 *    bounded no-follow tail on the first readable candidate in the
 *    dispatchEventsCandidates order — the same precedence readTicks
 *    applies — metrics/jobs.jsonl likewise, and the clock samples
 *    through readClockSamples; nothing is written and no process is
 *    inspected.
 *  - Missing or unreadable evidence yields no items. A dispatch log
 *    no candidate can read returns [] — ticks are the fold's spine,
 *    and without them there is no gap verdict at all (unknown stays
 *    unknown, never a guessed tally). An unreadable jobs.jsonl, or a
 *    truncated tail whose retained head cannot prove coverage back to
 *    the window start, drops only the launch evidence: no-launch gaps
 *    stay uncomputed while no-tick gaps still fold — exactly what
 *    buildFleetGaps reports under sources.launches 'unknown'. Clock
 *    samples that are missing or do not bracket a gap degrade its
 *    cause to 'unknown', never to a guessed 'dispatcher-stalled'.
 *  - The verdicts are the production ones. The fold is
 *    buildFleetGaps itself — the same tick-pair edges, the same
 *    sleptBetween sleep attribution, the same admission-blocked
 *    skip-reason tally and the same GAP_MIN_MINUTES bar `phm fleet
 *    gaps` prints — so a gap here is a gap the report would print.
 *  - Launch coverage under a truncated jobs.jsonl tail is proven, not
 *    assumed: ledger rows append in event order, so the retained
 *    head's first stampable row is the coverage edge and must reach
 *    back to the window start, else launches fold as unknown rather
 *    than risk a fabricated admission-blocked gap.
 *  - Recurring means episodes, not minutes. An item emits only while
 *    its cell holds at least GAP_MIN_EPISODES separate gap episodes
 *    spanning at least GAP_MIN_DAYS distinct UTC days inside the
 *    window — one bad afternoon never queues a session. Episodes whose
 *    queue was provably empty (lostWork false) and host-asleep gaps —
 *    owner-side, like the sibling load source's external apps — never
 *    count toward the bar.
 *  - The evidence carries no repository dimension — it describes this
 *    install's dispatcher and fleet machinery. Items therefore emit
 *    only when the backlog target's repository name is 'phantom', the
 *    same last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. All three ids are stable strings — the
 *    admission id keys on the modal skip reason's slug, never the
 *    counts or timestamps — so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; shifted tallies do
 *    not spawn twin items and a quiet window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the sources and their coverage caveats
 *    ride in the evidence, and the brief names the logs, `phm fleet
 *    gaps`, the digest blocker and the pinned contrib/mac dispatcher
 *    boundary — with the usual no-change escape when the window no
 *    longer reproduces or the cause is owner-side sleep or pinned ops
 *    machinery.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { dispatchEventsCandidates } from '../fleet/dispatch-events-path.js';
import { ledgerAtMs, ledgerRows } from '../fleet/empty-cause.js';
import {
  GAP_MIN_MINUTES,
  buildFleetGaps,
  parseTicks,
  readClockSamples,
  type FleetGap,
  type FleetGapsReport,
  type Tick,
} from '../fleet/sleep-gaps.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit: at most one per evidence cell. */
export const GAP_BACKLOG_MAX_ITEMS = 3;
const GAP_ITEM_HARD_MAX = 25;
/**
 * Evidence window: seven days, the same convention the sibling
 * fleet-evidence sources apply — long enough for nightly and weekly
 * stall patterns to recur inside it.
 */
export const GAP_WINDOW_HOURS = 168;
/**
 * Separate gap episodes a cell needs inside the window before it
 * counts as recurring — each episode is already a GAP_MIN_MINUTES+
 * anomaly, so three across days is a pattern, not a blip.
 */
export const GAP_MIN_EPISODES = 3;
/** Those episodes must span at least this many separate UTC days — one bad day is an incident, not a pattern. */
export const GAP_MIN_DAYS = 2;
/** Bounded tail for dispatch-events.log — the sibling fleet folds read the same log at 8 MiB. */
const DISPATCH_EVENTS_TAIL_BYTES = 8 * 1024 * 1024;
/**
 * Bounded tail for metrics/jobs.jsonl — generous so launch coverage
 * usually reaches the whole window; when it cannot, launches fold as
 * unknown rather than risk a fabricated gap.
 */
const JOBS_LEDGER_TAIL_BYTES = 32 * 1024 * 1024;
/** The fleet's own repository label: gap evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
const HOUR_MS = 3_600_000;

export interface FleetGapItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding the dispatch-events candidates, metrics/jobs.jsonl and queue/clock-samples.json; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default GAP_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in hours (default GAP_WINDOW_HOURS). */
  windowHours?: number;
  /** Newest-bytes bound on the jobs-ledger tail (default JOBS_LEDGER_TAIL_BYTES). */
  jobsLedgerLimit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** Per-cell recurrence tally: episodes, the days they span and the work they cost. */
export interface GapCellTally {
  /** In-window gap episodes the production fold emitted for this cell. */
  episodes: number;
  /** Distinct UTC days those episodes' starts fall on. */
  days: number;
  /** Summed gap minutes across the episodes. */
  minutes: number;
  /** Episodes where the queue provably held work (lostWork true). */
  lostWork: number;
  /** Episodes where queue depth stayed unknown (lostWork null). */
  lostWorkUnknown: number;
  /** Earliest episode start (ISO); null when the cell is empty. */
  oldestStart: string | null;
  /** Latest episode end (ISO); null when the cell is empty. */
  newestEnd: string | null;
}

/** The fold's measured evidence; every count is over in-window production gaps only. */
export interface FleetGapEvidence {
  /** 'known' when the tick spine read (report.count is a number); 'unknown' is no evidence, never a zero. */
  state: 'known' | 'unknown';
  windowHours: number;
  /** Which production sources read; mirrors buildFleetGaps' own sources block plus the tick-tail truncation flag. */
  sources: {
    ticks: 'read' | 'unknown';
    ticksTruncated: boolean;
    launches: 'read' | 'unknown';
    clock: 'read' | 'unknown';
  };
  /** report.count — in-window gaps the production fold found; null when ticks were unreadable. */
  gapCount: number | null;
  /** report.lostMinutes — minutes inside gaps where work was or may have been queued; null when ticks unreadable. */
  lostMinutes: number | null;
  /** no-tick gaps the clock samples proved were dispatcher stalls — not sleep — with work queued or unknown. */
  stall: GapCellTally;
  /** no-launch admission-blocked gaps; reasons tallies the recorded skip reason across episodes. */
  admission: GapCellTally & { reasons: { reason: string; count: number }[]; modalReason: string | null };
  /** Gaps whose cause stayed unattributed — no tick or no launch while work was queued or unknown. */
  unattributed: GapCellTally & { noTick: number; noLaunch: number };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * A gap counts toward recurrence only when work was queued or queue
 * depth stayed unknown — a provably-empty queue lost nothing — and
 * never when the cause is host-asleep: the Mac sleeping is owner-side,
 * like the sibling load source's external apps, with no repo-side fix.
 */
function actionable(gap: FleetGap): boolean {
  return gap.lostWork !== false && gap.cause !== 'host-asleep';
}

const inStall = (gap: FleetGap): boolean =>
  gap.kind === 'no-tick' && gap.cause === 'dispatcher-stalled' && actionable(gap);
const inAdmission = (gap: FleetGap): boolean =>
  gap.kind === 'no-launch' && gap.cause === 'admission-blocked' && actionable(gap);
const inUnattributed = (gap: FleetGap): boolean =>
  ((gap.kind === 'no-tick' && gap.cause === 'unknown') || (gap.kind === 'no-launch' && gap.cause === 'unknown')) && actionable(gap);

function tally(gaps: readonly FleetGap[]): GapCellTally {
  const days = new Set<string>();
  let minutes = 0;
  let lostWork = 0;
  let lostWorkUnknown = 0;
  let oldestStart: string | null = null;
  let newestEnd: string | null = null;
  for (const gap of gaps) {
    days.add(gap.start.slice(0, 10));
    minutes += gap.minutes;
    if (gap.lostWork === true) lostWork += 1;
    else if (gap.lostWork === null) lostWorkUnknown += 1;
    if (oldestStart === null || gap.start < oldestStart) oldestStart = gap.start;
    if (newestEnd === null || gap.end > newestEnd) newestEnd = gap.end;
  }
  return { episodes: gaps.length, days: days.size, minutes, lostWork, lostWorkUnknown, oldestStart, newestEnd };
}

/** Ledger-recorded skip reasons are unbounded log tokens; scrub, strip control characters and cap before they reach a prompt or an id. */
function reasonText(reason: string | null): string {
  if (reason === null) return 'unrecorded';
  const clean = scrubSecrets(reason)
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex -- ledger reasons must not carry control bytes into a prompt or an id.
    .replace(/[\x00-\x1f\x7f]+/g, '')
    .trim();
  return clean.slice(0, 60) || 'unrecorded';
}

/** Deterministic, readable slug for the reason vocabulary; anything unexpected degrades to 'unrecorded' rather than leaking text. */
function reasonSlug(reason: string | null): string {
  const base = reasonText(reason).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base === '' ? 'unrecorded' : base;
}

/**
 * Pure: fold the production fleet.gaps.v1 report into per-cell
 * recurrence evidence. `report.gaps` are already window-clipped by
 * buildFleetGaps; the fold only classifies, tallies and applies the
 * recurrence bars. Unknown stays unknown: an unreadable tick spine
 * reports state 'unknown' with zeroed cells, never a guessed tally.
 */
export function foldFleetGapEvidence(
  report: FleetGapsReport,
  opts: { windowHours?: number; ticksTruncated?: boolean } = {},
): FleetGapEvidence {
  const windowHours = opts.windowHours ?? GAP_WINDOW_HOURS;
  const gaps = report.count === null ? [] : report.gaps;
  const stallGaps = gaps.filter(inStall);
  const admissionGaps = gaps.filter(inAdmission);
  const unattributedGaps = gaps.filter(inUnattributed);
  const reasons = new Map<string, number>();
  for (const gap of admissionGaps) {
    const reason = reasonText(gap.reason);
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const reasonRows = [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    state: report.count === null ? 'unknown' : 'known',
    windowHours,
    sources: {
      ticks: report.sources.ticks,
      ticksTruncated: opts.ticksTruncated ?? false,
      launches: report.sources.launches,
      clock: report.sources.clock,
    },
    gapCount: report.count,
    lostMinutes: report.lostMinutes,
    stall: tally(stallGaps),
    admission: {
      ...tally(admissionGaps),
      reasons: reasonRows.map(([reason, count]) => ({ reason, count })),
      modalReason: reasonRows[0]?.[0] ?? null,
    },
    unattributed: {
      ...tally(unattributedGaps),
      noTick: unattributedGaps.filter((g) => g.kind === 'no-tick').length,
      noLaunch: unattributedGaps.filter((g) => g.kind === 'no-launch').length,
    },
  };
}

const NO_CHANGE = 'If the window has rolled forward, the gaps were a one-off outage the fleet recovered from, the queue was empty, the Mac was simply asleep (owner-side), or the cause lives in the pinned contrib/mac dispatcher files under Security review or ~/.ashlr-runs/bin installs — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the logs, the production fold and its existing readers are named so the session can reproduce them. */
const EVIDENCE = 'The evidence is the fleet.gaps.v1 fold `phm fleet gaps --json` prints (src/core/fleet/sleep-gaps.ts buildFleetGaps): PLANNER_TICK lines from queue/dispatch-events.log — falling back to dispatch-events.log — under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), `launch` rows from the metrics/jobs.jsonl tail, and wall-versus-monotonic clock samples from queue/clock-samples.json. A gap is GAP_MIN_MINUTES+ minutes with no tick, or on-time ticks that all skipped launch while jobs sat queued; the same gaps feed the hourly digest\'s first-line blocker (src/core/fleet/digest-blocker.ts) and its gapLine summaries.';

function spanText(t: GapCellTally): string {
  if (t.oldestStart === null || t.newestEnd === null) return '';
  return ` First gap started ${t.oldestStart}; the latest ended ${t.newestEnd}.`;
}

function coverageNote(ev: FleetGapEvidence): string {
  const notes: string[] = [];
  if (ev.sources.ticksTruncated) notes.push('the retained dispatch-events tail dropped older lines, so gap counts are lower bounds');
  if (ev.sources.launches === 'unknown') notes.push('metrics/jobs.jsonl launches were unreadable or their retained tail could not prove window coverage, so only no-tick gaps were judged');
  if (ev.sources.clock === 'unknown') notes.push('no clock samples covered the gaps, so sleep versus stall stayed unattributed');
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function recurring(t: GapCellTally): boolean {
  return t.episodes >= GAP_MIN_EPISODES && t.days >= GAP_MIN_DAYS;
}

function stallPrompt(ev: FleetGapEvidence): string {
  const t = ev.stall;
  return [
    `Phantom's fleet dispatcher keeps stalling — ${t.episodes} separate stretches of ${GAP_MIN_MINUTES}+ minutes with no PLANNER_TICK across ${t.days} UTC days inside the window, with jobs queued or queue depth unknown, the self-improvement work this backlog exists for.`,
    '',
    `The clock samples proved the Mac was awake through these gaps, so this is dispatcher silence rather than sleep: ${t.minutes} stalled minutes in total; ${t.lostWork} episodes had jobs queued and ${t.lostWorkUnknown} could not prove the queue empty.${spanText(t)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find why the dispatcher stops ticking: the tick writer (src/cli/fleet-planner-tick.ts), the planner run it wraps (src/core/fleet/planner-run.ts), dispatchd's own loop and its launchd keepalive are the suspects — the contrib/mac dispatcher files and the ~/.ashlr-runs/bin installs are pinned, Security-reviewed ops machinery this repo does not edit live, so if the stall traces to them or to host sleep the samples missed, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function reasonsText(t: FleetGapEvidence['admission']): string {
  if (t.reasons.length === 0) return 'none recorded';
  return t.reasons.map((r) => `${r.reason} ×${r.count}`).join(', ');
}

function admissionPrompt(ev: FleetGapEvidence): string {
  const t = ev.admission;
  const reason = t.modalReason === null
    ? ''
    : ` The dominant skip reason was '${t.modalReason}' — all recorded reasons: ${reasonsText(t)}.`;
  return [
    `Phantom's fleet keeps refusing launches — ${t.episodes} stretches across ${t.days} UTC days where the dispatcher ticked on time, jobs sat queued and every tick skipped, so nothing launched, the self-improvement work this backlog exists for.`,
    '',
    `${t.minutes} blocked minutes in total; ${t.lostWork} episodes had jobs queued and ${t.lostWorkUnknown} could not prove the queue empty.${reason}${spanText(t)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find what admission keeps refusing: the skip reasons the ticks recorded name the gate — quota or auth holds, host-load admission, lane caps and the queue producers that shape the work all live across this repo and the pinned contrib/mac admission checks, so the reason tally above is the first suspect. If the refusals trace to pinned ops files, owner-side credentials or billing, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unattributedPrompt(ev: FleetGapEvidence): string {
  const t = ev.unattributed;
  return [
    `Phantom's fleet has recurring gaps the evidence cannot attribute — ${t.episodes} stretches across ${t.days} UTC days with no dispatcher tick or no launch while work was queued or queue depth stayed unknown, and neither the clock samples nor the launch ledger could prove sleep, stall or admission as the cause, the self-improvement work this backlog exists for.`,
    '',
    `${t.noTick} were silent-dispatcher gaps and ${t.noLaunch} were launch-starved gaps; ${t.minutes} minutes in total, ${t.lostWork} episodes with jobs queued and ${t.lostWorkUnknown} unknown.${spanText(t)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find what the gaps actually were: check whether queue/clock-samples.json covers the gap edges — missing samples leave every no-tick gap 'unknown' — whether the metrics/jobs.jsonl tail reached the window, and whether dispatchd was alive but silent versus the Mac asleep. Owner-side sleep and pinned contrib/mac dispatcher faults are not repo fixes, so if the evidence resolves to those, report no-change and name it. ${NO_CHANGE}`,
  ].join('\n');
}

function gapItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, 200),
    prompt,
    area: 'fleet-gaps',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * The first stampable ledger row's `at` near the retained head of a
 * bounded tail — the coverage anchor a truncated jobs.jsonl tail must
 * reach back to the window start. Ledger rows append in event order,
 * so this stamp approximates where retained coverage begins; scanning
 * is bounded and unparseable lines are skipped.
 */
function firstLedgerStampMs(text: string): number | null {
  let scanned = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (++scanned > 100) return null;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const at = ledgerAtMs(value as Record<string, unknown>);
        if (at !== null) return at;
      }
    } catch { /* keep scanning for a stampable row */ }
  }
  return null;
}

/**
 * Backlog items for the fleet gap fold's recurring stall, admission
 * and unattributed evidence. Total: any read or fold failure yields
 * no items rather than throwing into discovery.
 */
export async function fleetGapBacklogItems(opts: FleetGapItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling sources apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value
    // is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? GAP_WINDOW_HOURS;
    const sinceMs = nowMs - windowHours * HOUR_MS;

    // Ticks are the fold's spine: the first readable dispatch-events
    // candidate in the production order, bounded tail — the same
    // precedence readTicks applies, with the truncation flag kept for
    // the prompt's coverage note.
    let ticks: Tick[] | null = null;
    let ticksTruncated = false;
    for (const path of dispatchEventsCandidates(runsDir)) {
      const tail = await readLedgerTail(path, DISPATCH_EVENTS_TAIL_BYTES);
      if (tail.state === 'read') {
        ticks = parseTicks(tail.text, nowMs);
        ticksTruncated = tail.truncated;
        break;
      }
    }
    if (ticks === null) return [];

    // Launches feed only the no-launch pass; they fold only when the
    // retained tail provably covers the window — a truncated tail
    // whose head stamp cannot reach `since` would risk fabricated
    // admission-blocked gaps, so it degrades to ticks-only evidence.
    const jobsTail = await readLedgerTail(join(runsDir, 'metrics', 'jobs.jsonl'), opts.jobsLedgerLimit ?? JOBS_LEDGER_TAIL_BYTES);
    let launches: number[] | null = null;
    if (jobsTail.state === 'read') {
      const headStampMs = jobsTail.truncated ? firstLedgerStampMs(jobsTail.text) : null;
      const coverageProven = !jobsTail.truncated || (headStampMs !== null && headStampMs <= sinceMs);
      if (coverageProven) {
        const hours = Math.ceil((nowMs - sinceMs) / HOUR_MS) + 1;
        launches = ledgerRows(jobsTail.text, nowMs, hours, true).rows
          .filter((row) => [row.row.event, row.row.type, row.row.kind].find((v) => typeof v === 'string') === 'launch')
          .map((row) => row.at);
      }
    }

    const samples = readClockSamples(runsDir);
    const report = buildFleetGaps({ ticks, launches, samples, now: nowMs, since: sinceMs, minMinutes: GAP_MIN_MINUTES });
    const evidence = foldFleetGapEvidence(report, { windowHours, ticksTruncated });
    const items: CloudBacklogItem[] = [];
    if (recurring(evidence.stall)) {
      items.push(gapItem(
        'fleet-gap-dispatch-stall',
        'Fleet dispatcher keeps stalling with work queued',
        stallPrompt(evidence),
        repo,
      ));
    }
    if (recurring(evidence.admission)) {
      items.push(gapItem(
        `fleet-gap-admission-${reasonSlug(evidence.admission.modalReason)}`,
        'Fleet admission keeps blocking launches while jobs queue',
        admissionPrompt(evidence),
        repo,
      ));
    }
    if (recurring(evidence.unattributed)) {
      items.push(gapItem(
        'fleet-gap-unattributed',
        'Fleet gaps recur that the evidence cannot attribute',
        unattributedPrompt(evidence),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? GAP_BACKLOG_MAX_ITEMS, GAP_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
