/**
 * Amplify advisory tick journal → self-improvement backlog items.
 *
 * Every leader cycle — including cycles without a model run — and every
 * `phm amplify tick` appends one `amplify.tick.v1` ADVISORY row to
 * metrics/amplify.jsonl under the fleet runs directory (~/.ashlr-runs or
 * $ASHLR_RUNS_DIR). Each row is the projectAmplify projection itself:
 * per-pool quota/burn/saturation readings, host vitals, the controller's
 * one-hour merge velocity, fleet-heartbeat staleness, a prioritized
 * action list and per-source health states. The actions are the advisory
 * loop's own verdicts — 'use-expiring-capacity' when a pool projects at
 * least ten percentage points of unused quota at its reset or expiry
 * within a day, 'check-heartbeat' when any heartbeat source is stale,
 * 'review-merge-flow' when the merge vital reads zero while lanes report
 * running work, 'refresh-evidence' when quota or burn readings fail
 * freshness, and 'review-saturation' at capacity.
 *
 * Until now the journal had no reader of its history: `phm amplify
 * status`/`tick`/`goal` and the leader memo's UNTRUSTED DATA block only
 * ever consume the newest snapshot, so a recommendation the advisory
 * loop kept making tick after tick — capacity expiring unused, heartbeats
 * gone stale, merges stalled while work ran, evidence that kept failing
 * to parse — never became work.
 *
 * amplifyBacklogItems carries the journal into discoverBacklog, so `phm
 * improve discover` and the scheduler's autoDiscover queue it exactly
 * like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail read; rows are validated by the writer's own
 *    contract — schema 'amplify.tick.v1' with a parseable `at` — and the
 *    action, heartbeat and source fields are folded defensively; nothing
 *    is written and no process is inspected.
 *  - Missing or unreadable evidence yields no items. An absent,
 *    non-file or unreadable journal reads as no evidence — unknown
 *    stays unknown, never a guessed tally — while a truncated tail
 *    still folds the retained rows with the prompts stating the
 *    counts as lower bounds.
 *  - The verdicts are the recorded ones. The fold reads the snapshot's
 *    own `actions` array — the projection's prioritized recommendations,
 *    already capped at twenty per tick — plus the `sources` health map
 *    and `heartbeat.sources` staleness the same snapshot publishes, so
 *    a cell means exactly what `phm amplify status` would have shown.
 *    'review-saturation' and unrecognized kinds never count: a lane at
 *    target is expected, not adverse.
 *  - Recurring means recorded, on the sibling feeds' own bars. A cell
 *    emits only while its qualifying ticks span at least
 *    AMPLIFY_MIN_DAYS distinct UTC days inside the window AND number at
 *    least AMPLIFY_MIN_ROWS — one bad afternoon never queues a session,
 *    and the claim is recurrence, which a single-day burst cannot prove.
 *  - The evidence carries no repository dimension — pools are lane and
 *    quota labels, not repositories. Items therefore emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Every id is a stable string — capacity ids key
 *    on the pool's sanitized name, never the counts or timestamps — so a
 *    refresh re-derives the same ids and appendUserBacklogItems adds only
 *    what is new; shifted tallies do not spawn twin items and a quiet
 *    window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, the snapshot cadence and the twenty-action cap
 *    ride in the evidence, and the brief names the journal, its writer
 *    and `phm amplify`'s live readers — with the usual no-change escape
 *    when the window no longer reproduces or the cause is a deliberate
 *    posture or pinned ops machinery.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit before the hard cap. */
export const AMPLIFY_BACKLOG_MAX_ITEMS = 8;
const AMPLIFY_ITEM_HARD_MAX = 12;
/**
 * Per-pool 'use-expiring-capacity' cells itemized individually; beyond
 * this the excess pools still count in the window tallies but do not
 * each mint an item.
 */
export const AMPLIFY_MAX_CAPACITY_ITEMS = 4;
/**
 * Evidence window: seven days, the same convention the friction,
 * tick-health, load, memory and disk sources apply.
 */
export const AMPLIFY_WINDOW_HOURS = 168;
/** Qualifying ticks must span at least this many distinct UTC days. */
export const AMPLIFY_MIN_DAYS = 2;
/** And number at least this many recorded ticks — a cell needs real recurrence, not one flapping pass. */
export const AMPLIFY_MIN_ROWS = 3;
/** Bounded tail for the journal; each row is a full snapshot of a few KiB. */
const AMPLIFY_LEDGER_TAIL_BYTES = 1024 * 1024;
/** Journal path under the runs dir, matching amplifyTick's writer. */
const AMPLIFY_LEDGER_RELATIVE = join('metrics', 'amplify.jsonl');
/** The fleet's own repository label: amplify evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
const HOUR_MS = 3_600_000;

export interface AmplifyItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/amplify.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default AMPLIFY_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in hours (default AMPLIFY_WINDOW_HOURS). */
  windowHours?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

type CellKind = 'capacity' | 'heartbeat' | 'merge-flow' | 'refresh' | 'source';

/** One recorded action as the fold consumes it. */
interface TickAction {
  kind: string;
  pool: string | null;
}

/** A heartbeat source the snapshot marked stale, with its recorded reason when present. */
interface StaleHeartbeat {
  source: string;
  reason: string | null;
}

/** One validated in-window journal row's folded fields. */
interface ParsedTick {
  atMs: number;
  at: string;
  actions: TickAction[];
  staleHeartbeats: StaleHeartbeat[];
  degradedSources: string[];
}

/** Recurring tally for one evidence cell: qualifying ticks and the UTC days they span. */
interface CellTally {
  kind: CellKind;
  label: string;
  rows: number;
  days: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
}

/** A window heartbeat source with its stale-tick tally and recorded reasons. */
export interface AmplifyHeartbeatSource {
  source: string;
  rows: number;
  reasons: string[];
}

/** A recurring cell's measured evidence; every count is over in-window valid rows only. */
export interface AmplifyCellEvidence {
  kind: CellKind;
  /** The pool name, heartbeat label, 'merge flow' or source path the cell keys on. */
  label: string;
  /** Qualifying recorded ticks inside the window. */
  rows: number;
  /** Distinct UTC days those ticks fall on. */
  days: number;
  /** Tick-time bounds across the cell's qualifying rows; null when none. */
  firstAt: string | null;
  lastAt: string | null;
}

/** The heartbeat cell plus the stale sources that recurred with it. */
export interface AmplifyHeartbeatEvidence extends AmplifyCellEvidence {
  staleSources: AmplifyHeartbeatSource[];
}

/** The fold's measured evidence; every count is over in-window valid rows only. */
export interface AmplifyEvidence {
  /** 'known' when the window holds at least one valid tick; 'unknown' is no evidence, never a zero. */
  state: 'known' | 'unknown';
  /** Valid tick rows inside the window. */
  ticks: number;
  /** Lines that were not a valid amplify.tick.v1 row; ignored, never guessed. */
  invalidRows: number;
  /** Valid rows dated outside the window or in the future; not evidence either way. */
  outsideWindow: number;
  /** True when the retained tail dropped older bytes — coverage is the retained window only. */
  ledgerTruncated: boolean;
  /** Tick-time bounds across the in-window rows; null when none parsed. */
  oldestAt: string | null;
  newestAt: string | null;
  /** Recurring per-pool expiring-capacity cells, worst first. */
  capacity: AmplifyCellEvidence[];
  /** The recurring heartbeat cell with its stale-source detail; null when it does not recur. */
  heartbeat: AmplifyHeartbeatEvidence | null;
  /** The recurring merge-flow cell; null when it does not recur. */
  mergeFlow: AmplifyCellEvidence | null;
  /** Recurring refresh-evidence and degraded-source cells feeding the evidence-health item. */
  degraded: AmplifyCellEvidence[];
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * One line under the writer's contract — an object with schema
 * 'amplify.tick.v1' and a parseable `at`. The action, heartbeat and
 * source fields are then folded defensively: each must be its recorded
 * shape or it contributes nothing, and off-contract action kinds are
 * ignored rather than counted.
 */
function amplifyTickRow(value: unknown): ParsedTick | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['schema'] !== 'amplify.tick.v1') return null;
  const at = row['at'];
  if (typeof at !== 'string') return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;

  const actions: TickAction[] = [];
  const rawActions = row['actions'];
  if (Array.isArray(rawActions)) {
    for (const entry of rawActions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const action = entry as Record<string, unknown>;
      const kind = action['kind'];
      if (typeof kind !== 'string' || kind === '') continue;
      const pool = action['pool'];
      actions.push({ kind, pool: typeof pool === 'string' && pool !== '' ? pool : null });
    }
  }

  const staleHeartbeats: StaleHeartbeat[] = [];
  const heartbeat = row['heartbeat'];
  if (heartbeat && typeof heartbeat === 'object' && !Array.isArray(heartbeat)) {
    const sources = (heartbeat as Record<string, unknown>)['sources'];
    if (Array.isArray(sources)) {
      for (const entry of sources) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const source = entry as Record<string, unknown>;
        if (source['stale'] !== true) continue;
        const name = source['source'];
        const reason = source['reason'];
        staleHeartbeats.push({
          source: typeof name === 'string' && name !== '' ? name : '(unnamed)',
          reason: typeof reason === 'string' && reason !== '' ? reason : null,
        });
      }
    }
  }

  const degradedSources: string[] = [];
  const sources = row['sources'];
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
    for (const [path, state] of Object.entries(sources as Record<string, unknown>)) {
      if (state === 'degraded') degradedSources.push(path);
    }
  }

  return { atMs, at, actions, staleHeartbeats, degradedSources };
}

/**
 * Pure: fold parsed journal lines into the amplify evidence. `values`
 * are the JSON.parsed ledger lines; each is validated by amplifyTickRow
 * — the writer's own structural check — then its recorded actions,
 * heartbeat staleness and degraded sources tally into per-cell day
 * sets. Unknown stays unknown: unparseable or off-contract lines count
 * as invalidRows, out-of-window rows as outsideWindow, and an empty
 * window reports state 'unknown', never a zero.
 */
export function foldAmplifyEvidence(
  values: readonly unknown[],
  opts: { nowMs: number; windowHours?: number },
): AmplifyEvidence {
  const windowHours = opts.windowHours ?? AMPLIFY_WINDOW_HOURS;
  const nowMs = opts.nowMs;
  const windowStart = nowMs - windowHours * HOUR_MS;
  const evidence: AmplifyEvidence = {
    state: 'unknown', ticks: 0, invalidRows: 0, outsideWindow: 0,
    ledgerTruncated: false, oldestAt: null, newestAt: null,
    capacity: [], heartbeat: null, mergeFlow: null, degraded: [],
  };
  const cells = new Map<string, CellTally>();
  const heartbeatSources = new Map<string, { rows: number; reasons: Set<string> }>();
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;

  const bump = (key: string, kind: CellKind, label: string, atMs: number, day: string): void => {
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { kind, label, rows: 0, days: new Set(), firstAtMs: atMs, lastAtMs: atMs };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.days.add(day);
    if (atMs < cell.firstAtMs) cell.firstAtMs = atMs;
    if (atMs > cell.lastAtMs) cell.lastAtMs = atMs;
  };

  for (const value of values) {
    const tick = amplifyTickRow(value);
    if (tick === null) { evidence.invalidRows += 1; continue; }
    if (tick.atMs < windowStart || tick.atMs > nowMs) { evidence.outsideWindow += 1; continue; }
    evidence.ticks += 1;
    if (tick.atMs < oldestMs) oldestMs = tick.atMs;
    if (tick.atMs > newestMs) newestMs = tick.atMs;
    const day = tick.at.slice(0, 10);
    for (const action of tick.actions) {
      // 'use-expiring-capacity' always names its pool; an unscoped one is
      // off-contract and skipped rather than guessed.
      if (action.kind === 'use-expiring-capacity') {
        if (action.pool !== null) bump(`capacity|${action.pool}`, 'capacity', action.pool, tick.atMs, day);
      } else if (action.kind === 'check-heartbeat') {
        bump('heartbeat', 'heartbeat', 'fleet heartbeats', tick.atMs, day);
      } else if (action.kind === 'review-merge-flow') {
        bump('merge-flow', 'merge-flow', 'merge flow', tick.atMs, day);
      } else if (action.kind === 'refresh-evidence') {
        bump(`refresh|${action.pool ?? '*'}`, 'refresh', action.pool ?? '(all pools)', tick.atMs, day);
      }
      // 'review-saturation' and unrecognized kinds are not adverse evidence.
    }
    for (const path of tick.degradedSources) {
      bump(`source|${path}`, 'source', path, tick.atMs, day);
    }
    for (const stale of tick.staleHeartbeats) {
      let tally = heartbeatSources.get(stale.source);
      if (tally === undefined) {
        tally = { rows: 0, reasons: new Set() };
        heartbeatSources.set(stale.source, tally);
      }
      tally.rows += 1;
      if (stale.reason !== null) tally.reasons.add(stale.reason);
    }
  }

  if (evidence.ticks === 0) return evidence;
  evidence.state = 'known';
  evidence.oldestAt = new Date(oldestMs).toISOString();
  evidence.newestAt = new Date(newestMs).toISOString();

  const recurring = (cell: CellTally): boolean => cell.days.size >= AMPLIFY_MIN_DAYS && cell.rows >= AMPLIFY_MIN_ROWS;
  const toEvidence = (cell: CellTally): AmplifyCellEvidence => ({
    kind: cell.kind,
    label: cell.label,
    rows: cell.rows,
    days: cell.days.size,
    firstAt: new Date(cell.firstAtMs).toISOString(),
    lastAt: new Date(cell.lastAtMs).toISOString(),
  });

  const all = [...cells.values()].filter(recurring);
  evidence.capacity = all
    .filter((cell) => cell.kind === 'capacity')
    .sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label))
    .map(toEvidence);
  const heartbeatCell = all.find((cell) => cell.kind === 'heartbeat');
  if (heartbeatCell !== undefined) {
    const base = toEvidence(heartbeatCell);
    const staleSources = [...heartbeatSources.entries()]
      .map(([source, tally]) => ({
        source,
        rows: tally.rows,
        reasons: [...tally.reasons].sort(),
      }))
      .sort((a, b) => b.rows - a.rows || a.source.localeCompare(b.source));
    evidence.heartbeat = { ...base, staleSources };
  }
  const mergeCell = all.find((cell) => cell.kind === 'merge-flow');
  if (mergeCell !== undefined) evidence.mergeFlow = toEvidence(mergeCell);
  evidence.degraded = all
    .filter((cell) => cell.kind === 'refresh' || cell.kind === 'source')
    .sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label))
    .map(toEvidence);
  return evidence;
}

const NO_CHANGE = 'If the window has rolled forward, the flagged condition was a one-off burst the later ticks recovered from, or the cause is a deliberate posture or pinned ops machinery (the contrib/mac dispatcher and fleet files, credential or billing boundaries) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal, its writer and its live readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/amplify.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), schema amplify.tick.v1 — one ADVISORY snapshot row per amplifyTick pass, appended by the leader tick every cycle (src/core/vision/leader.ts) and by `phm amplify tick` (src/core/amplify/index.ts). Each row is the projectAmplify projection (src/core/amplify/snapshot.ts): per-pool quota/burn/saturation readings, host vitals, the controller\'s one-hour merge velocity, fleet-heartbeat staleness, a prioritized action list capped at twenty and per-source health states. `phm amplify status`, `phm amplify tick`, `phm amplify goal` and the leader memo\'s UNTRUSTED DATA block consume only the newest snapshot — no reader ever folded the journal\'s history, so a recommendation the advisory loop kept making tick after tick never became work. This feed folds the recorded actions, heartbeat staleness and degraded source states over a seven-day window and emits only for cells recurring across distinct UTC days; the twenty-action cap means tallies are lower bounds when many pools qualify at once.';

function spanText(ev: AmplifyEvidence): string {
  if (ev.oldestAt === null || ev.newestAt === null) return '';
  return ev.oldestAt === ev.newestAt
    ? ` Recorded ${ev.oldestAt}.`
    : ` Recorded ${ev.oldestAt} through ${ev.newestAt}.`;
}

function coverageNote(ev: AmplifyEvidence): string {
  const notes: string[] = [];
  if (ev.ledgerTruncated) notes.push('the retained tail dropped older rows, so every count is a lower bound');
  if (ev.invalidRows > 0) notes.push(`${ev.invalidRows} malformed lines dropped`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

/** Recorded labels are unbounded text; scrub, flatten and cap before they reach a prompt. */
function labelText(label: string): string {
  return scrubSecrets(label).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 80) || 'unnamed';
}

/** Deterministic, readable slug for a pool name; anything unexpected hashes instead of leaking text. */
function poolSlug(label: string): string {
  const clean = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return clean !== '' ? clean : createHash('sha256').update(label).digest('hex').slice(0, 12);
}

function amplifyItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, 200),
    prompt,
    area: 'amplify',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function capacityPrompt(cell: AmplifyCellEvidence, ev: AmplifyEvidence): string {
  const pool = labelText(cell.label);
  return [
    `Phantom's amplify advisory loop keeps flagging expiring included capacity on pool '${pool}' — the use-expiring-capacity recommendation fired in ${cell.rows} recorded ticks across ${cell.days} UTC days inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each recorded tick is one projectAmplify pass: the pool projected at least ten percentage points of unused quota at its reset or expiry within twenty-four hours, so included capacity kept heading for the bin unused. ${ev.ticks} ticks in the window.${spanText(ev)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find why this pool's capacity keeps expiring unused: whether eligible queued work exists but is not reaching it (lane hints, needs/work_class matching, holds — phm fleet unfed and metrics/work-market.jsonl are the demand-side view), whether producers stopped minting work it can take, or whether the quota and burn readings themselves are stale (the refresh-evidence actions name that case). Fix what lives in this repo — queue producers, lane targets and routing; if the waste is a deliberate preserve/reset posture or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function heartbeatPrompt(cell: AmplifyHeartbeatEvidence, ev: AmplifyEvidence): string {
  const top = cell.staleSources.slice(0, 3)
    .map((s) => `${labelText(s.source)} (${s.rows} ticks${s.reasons.length > 0 ? `, ${s.reasons.join('/')}` : ''})`)
    .join(', ');
  const sourceText = top === '' ? 'the snapshot did not retain which sources were stale' : `the recurring stale sources were ${top}`;
  return [
    `Phantom's amplify advisory loop keeps flagging stale fleet heartbeats — heartbeat.stale held in ${cell.rows} recorded ticks across ${cell.days} UTC days inside the window, the self-improvement work this backlog exists for.`,
    '',
    `heartbeat.stale means at least one fleet heartbeat source — queue/status.json or a supervisor/status-*.md file — was missing, unparseable, timed out or older than the freshness bar, so the advisory loop could not trust that part of the fleet was still reporting. ${sourceText}. ${ev.ticks} ticks in the window.${spanText(ev)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find which heartbeat keeps dropping: a supervisor that stopped writing its status file, the queue status producer, or a freshness bar the producers cannot meet. The heartbeat sources are named above; supervisor status files live under supervisor/ in the runs dir and queue/status.json is the dispatcher's own liveness record. Fix what lives in this repo — the producers and their cadence; if the staleness is a deliberately paused machine or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function mergeFlowPrompt(cell: AmplifyCellEvidence, ev: AmplifyEvidence): string {
  return [
    `Phantom's amplify advisory loop keeps flagging stalled merge flow — the review-merge-flow recommendation fired in ${cell.rows} recorded ticks across ${cell.days} UTC days inside the window while lanes reported running work, the self-improvement work this backlog exists for.`,
    '',
    `The controller's one-hour merge_rate_1h vital read zero while at least one pool reported running above zero — active work producing no recorded merges for stretches at a time. ${ev.ticks} ticks in the window.${spanText(ev)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find the bottleneck between running work and recorded merges: merge-queue stalls, verification latency, conflict recuts or a merge observer that stopped recording. metrics/merge-events.jsonl, the merge queue files and the friction ledger are the detailed views; this signal is the controller's own vital recurring across days. Fix what lives in this repo — the merge path and its observers; if the stall is pinned ops machinery or a deliberate merge freeze — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function degradedPrompt(cells: AmplifyCellEvidence[], ev: AmplifyEvidence): string {
  const parts = cells.slice(0, 6).map((cell) => {
    const what = cell.kind === 'source' ? 'unreadable input' : 'stale quota reading';
    return `'${labelText(cell.label)}' (${what}: ${cell.rows} ticks, ${cell.days} days)`;
  });
  const more = cells.length > 6 ? ` and ${cells.length - 6} more` : '';
  return [
    `Phantom's amplify advisory loop keeps failing to read its capacity evidence — ${cells.length} evidence cell${cells.length === 1 ? '' : 's'} recurred across distinct UTC days inside the window, the self-improvement work this backlog exists for.`,
    '',
    `The recurring cells were ${parts.join(', ')}${more}. A degraded source means the input file was present but unreadable or failed to parse; a refresh-evidence cell means that pool's quota or burn readings kept failing the freshness bar, so capacity planning ran on stale or missing numbers. ${ev.ticks} ticks in the window.${spanText(ev)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find why the evidence pipeline keeps degrading: the producers of queue/resources-ledger.json, queue/budget-overrides.json, queue/status.json and metrics/fleet-controller.jsonl — mid-write reads, schema drift, truncated appends or a stopped producer. Fix what lives in this repo — the writers and the readers' tolerance; if the degradation is pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

/**
 * Backlog items for the amplify advisory tick journal's recurring
 * adverse recommendations and degraded inputs. Total: any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function amplifyBacklogItems(opts: AmplifyItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the amplify reader and sibling feeds apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const ledger = await readLedgerTail(join(runsDir, AMPLIFY_LEDGER_RELATIVE), AMPLIFY_LEDGER_TAIL_BYTES);
    if (ledger.state !== 'read') return [];
    const values: unknown[] = [];
    for (const line of ledger.text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { values.push(JSON.parse(line)); } catch { values.push(null); }
    }
    const evidence = foldAmplifyEvidence(values, { nowMs, windowHours: opts.windowHours });
    evidence.ledgerTruncated = ledger.truncated;
    const items: CloudBacklogItem[] = [];
    for (const cell of evidence.capacity.slice(0, AMPLIFY_MAX_CAPACITY_ITEMS)) {
      items.push(amplifyItem(
        `amplify-expiring-capacity-${poolSlug(cell.label)}`,
        `Amplify keeps flagging expiring capacity on pool ${labelText(cell.label)}`,
        capacityPrompt(cell, evidence),
        repo,
      ));
    }
    if (evidence.heartbeat !== null) {
      items.push(amplifyItem(
        'amplify-heartbeat-stale',
        'Amplify keeps flagging stale fleet heartbeats',
        heartbeatPrompt(evidence.heartbeat, evidence),
        repo,
      ));
    }
    if (evidence.mergeFlow !== null) {
      items.push(amplifyItem(
        'amplify-merge-flow-stalled',
        'Amplify keeps flagging stalled merge flow',
        mergeFlowPrompt(evidence.mergeFlow, evidence),
        repo,
      ));
    }
    if (evidence.degraded.length > 0) {
      items.push(amplifyItem(
        'amplify-evidence-degraded',
        'Amplify keeps failing to read its capacity evidence',
        degradedPrompt(evidence.degraded, evidence),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? AMPLIFY_BACKLOG_MAX_ITEMS, AMPLIFY_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
