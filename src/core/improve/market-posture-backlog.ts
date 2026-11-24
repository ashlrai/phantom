/**
 * Work-market posture journal recurring adverse posture reasons →
 * self-improvement backlog items.
 *
 * Every dispatcher tick that has any budget override or a live devin
 * target, market_metric (contrib/mac/dispatchd.py) appends one
 * `posture` event to <runsDir>/metrics/work-market.jsonl: the market
 * view's per-lane {posture, posture_reason, projected_unused_pct,
 * hours_to_reset, cost_class} plus the optional cost_class_reason,
 * zero_cost and allowance evidence — written by contrib/mac/
 * work_market.py lane_view()/devin_cost()/spend_down() from the
 * budget-overrides.json allowance map and the devin weekly-capacity
 * reading. The journal is append-only with no rotation, so readers
 * take a bounded tail.
 *
 * Until now the only reader of posture_reason was readRouteView
 * (src/core/queue/route-explain.ts)'s latest-row lookup behind `phm
 * route explain` — a point-in-time report someone had to run. The
 * posture events are the market's own per-tick verdict on whether
 * each lane's measured allowance evidence is usable: while an
 * evidence-gap reason recurs, spend_down cannot project the lane and
 * devin cost classification degrades to metered, so the router's
 * cost evidence starves exactly where the market needs it; while a
 * use-it-all override reason recurs, included subscription windows
 * keep projecting waste or behind-pace often enough that dispatchd
 * forces burn posture tick after tick. Neither condition ever became
 * work.
 *
 * marketPostureBacklogItems carries the same journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling fleet-evidence
 * sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail (the same 32 MiB bound the unfed feed
 *    uses); nothing is written and no network is touched. A missing
 *    or unreadable file yields no items.
 *  - Rows count only under the writer's contract: schema
 *    'work-market.v1', event 'posture', a finite non-negative
 *    epoch-second ts inside the window plus the sibling folds'
 *    five-minute future skew, and a lanes record whose entries carry
 *    a lane id, a posture inside the writer's POSTURES vocabulary
 *    and a code-shaped posture_reason. An optional cost_class_reason
 *    counts only when it is code-shaped too. Anything less is skipped
 *    entry-by-entry — never guessed, never partially trusted.
 *  - Only the adverse vocabulary emits. Evidence-gap reasons —
 *    'spend_down_unknown' and the devin_* evidence failures — mean
 *    the lane's measured allowance/usage reading keeps failing the
 *    writer's freshness and shape checks; designed reasons
 *    ('spend_down_not_subscription', 'spend_down_on_pace',
 *    'spend_down_projected_unused', 'spend_down_projected_exhaustion',
 *    'devin_within_allowance', 'devin_allowance_headroom',
 *    'devin_free_preview', 'free_until', 'host_declared') are the
 *    market working as designed and never emit. The two use-it-all
 *    override reasons emit as their own kind.
 *  - Recurring means recorded across days: one posture event per
 *    tick carries every lane, so a (lane, reason) cell emits only
 *    when it reaches POSTURE_MIN_ROWS in-window rows across
 *    POSTURE_MIN_DAYS distinct UTC days — the unfed feed's per-tick
 *    convention. The prompt quotes the cell's share of that lane's
 *    valid in-window entries so a rare-but-recurring code reads
 *    honestly.
 *  - Fleet machinery only: the journal carries no per-tick
 *    repository dimension — the market view describes this install's
 *    lanes — so items emit only when the backlog target's repository
 *    name is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply.
 *  - Truncation is stated, never hidden: when the bounded tail cuts
 *    older rows, every prompt says the counts are a lower bound.
 *  - Dedup is downstream: item ids hash the cell identity — never
 *    the counts or timestamps — so a refresh re-derives the same ids
 *    and appendUserBacklogItems adds only what is new; a lane whose
 *    evidence recovers simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, ROUTER_MARKET_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; per-(lane, reason) cells stay well under this on a real fleet. */
export const MARKET_POSTURE_MAX_ITEMS = 10;
const MARKET_POSTURE_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention, in hours like the unfed feed on the same journal. */
export const MARKET_POSTURE_WINDOW_HOURS = 168;
/**
 * Bounded tail of the append-only journal — the same 32 MiB bound the
 * unfed feed reads (route_decision rows dominate the file). Prompts
 * state any truncation as a lower bound.
 */
export const MARKET_POSTURE_TAIL_BYTES = 32 * 1024 * 1024;
/** Future-skew allowance on row timestamps, the sibling folds' convention. */
const MARKET_POSTURE_FUTURE_SKEW_SECONDS = 300;
/**
 * In-window rows a (lane, reason) cell needs before it counts as
 * recurring — the unfed feed's per-tick convention. One posture event
 * per tick carries every lane, so six rows is a burst, not a pattern.
 */
export const POSTURE_MIN_ROWS = 6;
/** Distinct UTC days the evidence must span — recurring means recorded across days. */
export const POSTURE_MIN_DAYS = 2;
/** The fleet's own repository label: journal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Lane identifiers the producer writes (dispatchd lane names) — the unfed feed's pattern. */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Reason codes the producer writes — the same closed shape the unfed folds validate. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** The writer's posture vocabulary (work_market.py POSTURES). */
const POSTURES: ReadonlySet<string> = new Set(['burn', 'balanced', 'preserve']);
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

/**
 * Evidence-gap reasons: the lane's measured allowance/usage reading
 * keeps failing the writer's freshness and shape checks, so the
 * spend-down projection records 'spend_down_unknown' and devin cost
 * classification records its own devin_* failure. Each names a
 * different missing or stale input — never a designed state.
 */
export const POSTURE_EVIDENCE_REASONS = [
  'spend_down_unknown',
  'devin_reset_unknown',
  'devin_reset_expired',
  'devin_allowance_unknown',
  'devin_usage_unknown',
  'devin_usage_stale',
  'devin_reservations_unknown',
  'devin_preview_unverified',
  'devin_preview_expired',
] as const;

/**
 * Use-it-all override reasons: dispatchd forces posture 'burn' on an
 * included lane while the host's use-it-all projection keeps reporting
 * medium/high waste risk or a behind-pace window. The projection is
 * host-owned ops machinery; the recurring signal is that included
 * subscription windows keep projecting waste often enough to need the
 * override tick after tick.
 */
export const POSTURE_WASTE_REASONS = [
  'use_it_all_waste_risk',
  'use_it_all_behind',
] as const;

const EVIDENCE_REASONS: ReadonlySet<string> = new Set(POSTURE_EVIDENCE_REASONS);
const ADVERSE_REASONS: ReadonlySet<string> = new Set([...POSTURE_EVIDENCE_REASONS, ...POSTURE_WASTE_REASONS]);

export interface MarketPostureItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/work-market.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default MARKET_POSTURE_WINDOW_HOURS). */
  windowHours?: number;
  /** Journal override (default: <runsDir>/metrics/work-market.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default MARKET_POSTURE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are regex-bounded already; scrub and cap defensively before display. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dayOf = (tsSeconds: number): string => new Date(tsSeconds * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-(lane, reason) adverse posture evidence inside the window. */
interface PostureReasonCell {
  lane: string;
  reason: string;
  kind: 'evidence' | 'waste';
  /** Lane entries carrying this reason. */
  rows: number;
  /** The lane's valid in-window posture entries — the share denominator. */
  laneEntries: number;
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface PostureFold {
  /** Valid in-window posture events (rows that passed the producer contract). */
  records: number;
  /** Retained-tail lines that failed JSON parse or the producer contract. */
  invalidRows: number;
  /** Valid lane entries across all records — per-lane denominators live on the cells. */
  laneEntries: Map<string, number>;
  /** Adverse (lane, reason) cells. */
  cells: Map<string, PostureReasonCell>;
}

// Lane ids and reason codes are both colon-free closed vocabularies, so the pair key is unambiguous.
const cellKey = (lane: string, reason: string): string => `${lane}:${reason}`;

/**
 * Pure: fold one journal tail into per-(lane, reason) adverse posture
 * cells. Rows outside the window, malformed JSON, wrong schema/event
 * and non-finite timestamps are skipped; lane entries that fail the
 * producer's shape (bad lane id, posture outside POSTURES, a
 * non-code-shaped posture_reason) are skipped entry-by-entry.
 */
export function foldPostureJournal(text: string, nowMs: number, windowHours: number): PostureFold {
  const fold: PostureFold = { records: 0, invalidRows: 0, laneEntries: new Map(), cells: new Map() };
  const since = nowMs / 1000 - windowHours * 3600;
  const until = nowMs / 1000 + MARKET_POSTURE_FUTURE_SKEW_SECONDS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Cheap prefilter: posture events are a minority of rows and the
    // pinned writer emits compact JSON, so '"event":"posture"' is verbatim.
    if (!trimmed.includes('"event":"posture"')) continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (!isRecord(row) || row['schema'] !== 'work-market.v1' || row['event'] !== 'posture') {
      fold.invalidRows += 1;
      continue;
    }
    const ts = row['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
      fold.invalidRows += 1;
      continue;
    }
    if (ts < since || ts > until) continue;
    const lanes = row['lanes'];
    if (!isRecord(lanes)) continue;
    fold.records += 1;
    const atMs = ts * 1000;
    const day = dayOf(ts);
    for (const [lane, value] of Object.entries(lanes)) {
      if (!LANE.test(lane) || !isRecord(value)) continue;
      const posture = value['posture'];
      const postureReason = value['posture_reason'];
      if (typeof posture !== 'string' || !POSTURES.has(posture) ||
          typeof postureReason !== 'string' || !CODE.test(postureReason)) continue;
      fold.laneEntries.set(lane, (fold.laneEntries.get(lane) ?? 0) + 1);
      const costReason = value['cost_class_reason'];
      const reasons = new Set<string>([postureReason]);
      if (typeof costReason === 'string' && CODE.test(costReason)) reasons.add(costReason);
      for (const reason of reasons) {
        if (!ADVERSE_REASONS.has(reason)) continue;
        const key = cellKey(lane, reason);
        let cell = fold.cells.get(key);
        if (cell === undefined) {
          cell = {
            lane, reason,
            kind: EVIDENCE_REASONS.has(reason) ? 'evidence' : 'waste',
            rows: 0, laneEntries: 0, days: new Set(), firstMs: null, lastMs: null,
          };
          fold.cells.set(key, cell);
        }
        cell.rows += 1;
        cell.days.add(day);
        cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
        cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
      }
    }
  }
  // Share denominators: each cell quotes its lane's valid in-window entries.
  for (const cell of fold.cells.values()) {
    cell.laneEntries = fold.laneEntries.get(cell.lane) ?? 0;
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface PostureCell {
  kind: 'evidence' | 'waste';
  lane: string;
  reason: string;
  /** Entries carrying the reason inside the window. */
  rows: number;
  /** The lane's valid in-window posture entries — rows/laneEntries is the share. */
  laneEntries: number;
  days: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const boundNote = (lowerBound: boolean): string =>
  lowerBound ? ' The journal tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

/**
 * Pure: the recurring cells the fold justifies. A (lane, reason) cell
 * emits only while its adverse rows reach POSTURE_MIN_ROWS across
 * POSTURE_MIN_DAYS distinct UTC days. Sorted by rows, then lane and
 * reason — deterministic across refreshes.
 */
export function postureCells(fold: PostureFold, lowerBound = false): PostureCell[] {
  const cells: PostureCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < POSTURE_MIN_ROWS || cell.days.size < POSTURE_MIN_DAYS) continue;
    cells.push({
      kind: cell.kind, lane: cell.lane, reason: cell.reason,
      rows: cell.rows, laneEntries: cell.laneEntries,
      days: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) => b.rows - a.rows || a.lane.localeCompare(b.lane) || a.reason.localeCompare(b.reason));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/work-market.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): dispatchd\'s market_metric appends one work-market.v1 posture event per tick whenever any lane carries a budget override or the devin target is live — each row\'s lanes map records every lane\'s posture (burn | balanced | preserve), posture_reason, projected_unused_pct, hours_to_reset, cost_class and the optional cost_class_reason/zero_cost/allowance evidence, computed by contrib/mac/work_market.py lane_view()/devin_cost()/spend_down() from the queue/budget-overrides.json allowance map and the devin weekly-capacity reading. The journal is append-only with no rotation; route_decision rows dominate it. `phm route explain --json` reads only the latest row\'s posture_reason for its per-lane view (src/core/queue/route-explain.ts) — until this feed no fold turned the recurring adverse reasons into work.';

const PINNED_NOTE = ' contrib/mac/work_market.py and contrib/mac/dispatchd.py are pinned dispatcher machinery: a fix there needs Security review and re-pin before install — prefer evidence-backed changes in this repository\'s src/ where the cause lives (the allowance readers and publishers, the usage sensors, the lane-target writers), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the condition was a one-off burst the fleet recovered from, the recorded reasons trace to a deliberate operator state (a held lane, a quota window that reset, free_until or host_declared posture, a maintenance pause) or owner-only cause (credentials, billing, host capacity, the host use-it-all probe, pinned dispatch machinery), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

const pct = (rows: number, total: number): string =>
  total > 0 ? `${((rows / total) * 100).toFixed(1)}%` : 'unknown';

const cellDays = (cell: PostureCell): string =>
  `across ${cell.days.length} UTC day(s) (${daysText(cell.days)})`;

/**
 * Per-reason fix guidance for evidence-gap cells — where the missing or
 * stale input lives in this repository. The devin_* codes all read the
 * weekly-capacity.json measurement publishDevinWeeklyCapacity writes;
 * spend_down_unknown reads the budget-overrides.json allowance entry
 * the lane-usage-self sanctioned readers maintain.
 */
const EVIDENCE_GUIDANCE: Record<string, string> = {
  'spend_down_unknown': `spend_down records 'spend_down_unknown' when an included lane's allowance reading lacks a usable weekly_used_pct (0–100), burn_pct_per_hour (>= 0), reset_at (still ahead) or as_of (fresh within the writer's -60 s..1800 s bound) — or when the lane carries no budget entry at all. The reading is the lane's queue/budget-overrides.json entry, maintained by the lane-usage-self sanctioned readers: SELF_LANES and defaultReaders in src/core/fabric/lane-usage-self.ts, the refresh pass in src/core/fabric/lane-usage-self-io.ts (runSelfRefresh), and the live usage sensors in src/core/usage/live/engine.ts whose budgetFragment feeds the same shape. Check whether the lane has a sanctioned reader at all, whether its reader keeps returning null (a source outage, a changed local CLI shape, missing credentials — owner-side when so), or whether OWNED_FIELDS drifted from what spend_down reads.`,
  'devin_reset_unknown': `devin_cost records 'devin_reset_unknown' when the weekly-capacity reading carries no parseable reset_at — the measured window anchor is missing. The publisher is publishDevinWeeklyCapacity in src/core/devin/weekly-capacity.ts (run by \`phm capacity publish\`), which derives reset_at from devinWeeklyWindow's anchor math; the consumer-side anchor check lives in read_devin_allowance (contrib/mac/work_market.py, pinned). Check whether the capacity publish is running, whether devinWeeklyWindow can anchor without a configured weeklyResetAt, and whether the published file's reset_at survives the consumer's recurrence check.`,
  'devin_reset_expired': `devin_cost records 'devin_reset_expired' when reset_at parses but is already in the past — the weekly window anchor is stale, so the allowance reading describes an expired week. Check the publish cadence for \`phm capacity publish\` and devinWeeklyWindow's rollover math in src/core/devin/weekly-capacity.ts: a publisher that stopped running, or a window function that fails to roll to the next anchor, leaves every reading expired.`,
  'devin_allowance_unknown': `devin_cost records 'devin_allowance_unknown' when the weekly limit is missing or <= 0 — neither the published capacity's limit nor the configured allowance produced a positive ACU ceiling. The limit chain is devinWeeklyAllowance in src/core/devin/weekly-capacity.ts (config devin.weeklyAcuAllowance, falling back to devin/budget.json acuBudgetTotal) — check whether the config section or budget file is absent, malformed, or carries a zero/negative value (owner-side config when so).`,
  'devin_usage_unknown': `devin_cost records 'devin_usage_unknown' when the weekly used-ACU reading is missing or negative — consumption exists but its measurement does not. The used figure comes from measureDevinWeekly in src/core/devin/weekly-capacity.ts over the v3 sessions API totals; check whether the sessions read is failing, returning an unexpected shape, or being clamped away before publish.`,
  'devin_usage_stale': `devin_cost records 'devin_usage_stale' when the reading's state is not 'live' or its as_of/observed_at is older than the writer's 900 s bound (or from the future) — the measurement exists but is too old to trust. Check the publish cadence for \`phm capacity publish\`, whether measureDevinWeekly marks state 'live' only on a fresh v3 read, and whether as_of is stamped at measurement time rather than publish time in src/core/devin/weekly-capacity.ts.`,
  'devin_reservations_unknown': `devin_cost records 'devin_reservations_unknown' when in_flight, reserve or session_cap is missing or non-positive — the reservation inventory the headroom math needs was never measured. in_flight comes from the task-inventory scan and session_cap/reserve from devin/budget.json inside measureDevinWeekly/publishDevinWeeklyCapacity (src/core/devin/weekly-capacity.ts); check whether the inventory read is failing closed to null or the budget file lacks the cap fields.`,
  'devin_preview_unverified': `devin_cost records 'devin_preview_unverified' when a free-preview model's binding evidence fails — state not 'live', as_of older than 900 s, or provenance missing the account_id/model pair that binds the preview to this install. The preview observation is devinPreviewObservation in src/core/devin/weekly-capacity.ts over the model catalog; check whether the catalog read, the account binding, or the freshness stamp is what keeps failing.`,
  'devin_preview_expired': `devin_cost records 'devin_preview_expired' once now passes the preview window's DEVIN_PREVIEW_UNTIL instant — every preview-model evaluation lands metered from then on. If the window genuinely ended this is designed metered posture (report no-change); if the catalog or config still advertises preview models past their real expiry, or the until instant is wrong, the fix is in the preview evidence this repository publishes — src/core/devin/weekly-capacity.ts and the model catalog it reads.`,
};

const WASTE_GUIDANCE: Record<string, string> = {
  'use_it_all_waste_risk': `dispatchd records 'use_it_all_waste_risk' when the host's use-it-all projection reports medium/high waste risk on this included lane — quota projected to expire unused — and forces posture 'burn' for the tick. The projection itself is host-owned ops machinery (<runs>/bin/use-it-all.py, schema use-it-all.v1, consumed only inside the pinned dispatcher), so the recurring question this repository owns is why included windows keep going to waste: lane targets and budget entries this repo writes (src/core/fabric/lane-usage-self*.ts, src/core/resources/lane-autopilot.ts, src/core/fleet/dynconfig.ts), the queue producers' job supply and shapes, and the yield/admission signals the market ranks on. If targets are already at the host's ceiling or the waste traces to owner-side capacity, report no-change and name the evidence.`,
  'use_it_all_behind': `dispatchd records 'use_it_all_behind' when the host's use-it-all projection reports the lane's window behind pace — usage too slow to spend the allowance before reset — and forces posture 'burn' plus the waste_boost tier lift for the tick. The projection is host-owned ops machinery; the recurring question this repository owns is what keeps the lane behind: whether producers mint too little runnable work for the lane's target, whether admission or tier ceilings starve it, or whether the pace inputs the projection reads (the same budget-overrides.json readings spend_down consumes) are stale. Check the lane's target vs its finished-job rate in metrics/jobs.jsonl and the producers' output before touching routing code.`,
};

function evidencePrompt(cell: PostureCell): string {
  const lane = fieldText(cell.lane, MAX_NAME_CHARS);
  const reason = fieldText(cell.reason, MAX_NAME_CHARS);
  const guidance = EVIDENCE_GUIDANCE[cell.reason] ??
    'Find which input the writer\'s checks keep rejecting and where this repository produces it.';
  const share = pct(cell.rows, cell.laneEntries);
  return [
    `Phantom's work market keeps recording '${reason}' for lane '${lane}' — ${cell.rows} posture entr${cell.rows === 1 ? 'y' : 'ies'} inside the 7-day window (${share} of the lane's ${cell.laneEntries} valid posture readings) ${cellDays(cell)}, the self-improvement work this backlog exists for.`,
    '',
    `Each posture event is the market's per-tick verdict on the lane's allowance evidence; '${reason}' is the writer's closed-vocabulary name for the specific input that keeps failing its freshness or shape checks — while it recurs, the lane's spend-down projection records nothing usable and its cost classification cannot see the real allowance, so routing ranks the lane on degraded cost evidence.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    guidance,
    '',
    `Fix what lives here — the allowance readers, publishers and usage sensors in this repository's src/ — and keep deliberate operator state (held lanes, expired windows that genuinely ended, owner-side credentials or config) out of scope.${PINNED_NOTE} If the window has rolled forward or the reasons trace to deliberate state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function wastePrompt(cell: PostureCell): string {
  const lane = fieldText(cell.lane, MAX_NAME_CHARS);
  const reason = fieldText(cell.reason, MAX_NAME_CHARS);
  const guidance = WASTE_GUIDANCE[cell.reason] ??
    'Find why the lane\'s included window keeps projecting waste or behind-pace.';
  const share = pct(cell.rows, cell.laneEntries);
  return [
    `Phantom's work market keeps forcing lane '${lane}' to burn on use-it-all evidence — ${cell.rows} posture entr${cell.rows === 1 ? 'y' : 'ies'} recorded '${reason}' inside the 7-day window (${share} of the lane's ${cell.laneEntries} valid posture readings) ${cellDays(cell)}, the self-improvement work this backlog exists for.`,
    '',
    `'${reason}' is dispatchd's override verdict: the host's use-it-all projection (schema use-it-all.v1, refreshed about every two minutes, consumed only inside the pinned dispatcher) keeps reporting this included lane's window going to waste or falling behind pace, so the market overrides its posture to 'burn' — and for behind-pace also lifts eligible work a tier through waste_boost — tick after tick. A lane that needs the override this often is leaving included subscription capacity unused.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    guidance,
    '',
    `Fix what lives here — the lane targets, budget entries and job-supply shapes this repository owns — rather than the pinned dispatcher copy; the use-it-all probe itself is host ops machinery.${PINNED_NOTE} If the overrides trace to deliberate holds, a quiet queue, owner-side capacity or a projection the owner already knows about, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const AREAS: Record<PostureCell['kind'], string> = {
  'evidence': 'posture-evidence',
  'waste': 'posture-waste',
};

const TITLES: Record<PostureCell['kind'], (cell: PostureCell) => string> = {
  'evidence': (c) => `Work market keeps lane ${c.lane} without usable allowance evidence: ${c.reason}`,
  'waste': (c) => `Work market keeps forcing lane ${c.lane} to burn on use-it-all: ${c.reason}`,
};

function postureItem(cell: PostureCell, repo: string): CloudBacklogItem {
  const identity = `${cell.kind}:${cell.lane}:${cell.reason}`;
  return {
    id: `market-posture-${sha(identity)}`,
    title: TITLES[cell.kind](cell).slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'evidence' ? evidencePrompt(cell) : wastePrompt(cell),
    area: AREAS[cell.kind],
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the work market's recurring adverse posture
 * reasons. Total: a missing journal, another repository or any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function marketPostureBacklogItems(opts: MarketPostureItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR'];
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns.startsWith('/') ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? MARKET_POSTURE_WINDOW_HOURS;
    const path = opts.journalPath ?? join(runsDir, ROUTER_MARKET_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, MARKET_POSTURE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldPostureJournal(tail.text, nowMs, windowHours);
    if (fold.records === 0) return [];
    const cells = postureCells(fold, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? MARKET_POSTURE_MAX_ITEMS, MARKET_POSTURE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => postureItem(cell, repo));
  } catch {
    return [];
  }
}
