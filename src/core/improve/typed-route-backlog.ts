/**
 * Typed-routing decision journal recurring unavailability and degradation →
 * self-improvement backlog items.
 *
 * Every dispatchd tick runs one bounded advisory sample of the typed
 * routing service — `phm route decide --input - --root <runs> --json` on
 * the first ready queue row — through observe_typed_route
 * (contrib/mac/dispatchd.py) and appends one `route.explain.v1` record to
 * `<runsDir>/metrics/route.explain.jsonl`: `status` 'observed' with the
 * validated lane/model/effort/speed_tier pick and its reason_codes plus
 * the optional duration_ms/attempts/candidate_count service metrics, or
 * 'unavailable' when the call itself failed — nonzero exit, the 0.9 s
 * outer cap, oversized or invalid JSON, or a decision outside the
 * route.decision.v1 contract and the dispatcher's allowlist. The journal
 * is append-only with no rotation, so readers take a bounded tail.
 *
 * Until now the only reader was readTypedDecisions
 * (src/core/router/typed-decisions.ts), whose route.typed-decisions.v1
 * digest surfaces on `phm route explain --json` — a report someone had
 * to run and read. The typed layer is the advisory path the fleet's
 * routing evidence depends on: while 'unavailable' rows recur, every
 * sample dies before a decision exists; while the degradation reason
 * codes recur on observed rows, decideRoute's model backends keep
 * failing over to the deterministic pick ('deterministic-fallback'), so
 * the recorded route is never the model's and the comparative evidence
 * stream starves. Neither condition ever became work.
 *
 * typedRouteBacklogItems carries the same journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail (the same TYPED_DECISIONS_LEDGER_LIMIT the
 *    digest reader retains); nothing is written and no network is
 *    touched. A missing or unreadable file yields no items.
 *  - Rows count only under the writer's contract: schema
 *    'route.explain.v1', the route.explain event name (event|type|kind
 *    alias set like the sibling ledger readers), advisory:true, a
 *    finite non-negative epoch-second ts inside the window (the same
 *    ±60 s future skew the sibling folds tolerate), and status
 *    'observed'/'unavailable'. An observed row must also carry a
 *    decision inside the producer's allowlist — bounded lane/model ids,
 *    the effort/speed-tier enums, 1–16 in-vocabulary reason codes —
 *    exactly what foldTypedDecisions validates. Anything less is an
 *    invalid row: counted, never partially trusted.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: this journal records one service call per tick,
 *    so a bare count of three says nothing about a high-volume window.
 *    Every cell emits only when its evidence spans at least
 *    TYPED_ROUTE_MIN_DAYS distinct UTC days AND reaches
 *    TYPED_ROUTE_MIN_ROWS in-window rows AND holds its share floor —
 *    unavailable samples must be at least TYPED_UNAVAILABLE_SHARE of
 *    all valid records, and a degradation code must ride at least
 *    TYPED_DEGRADED_SHARE of observed decisions.
 *  - Degradation codes are the decideRoute failure vocabulary only,
 *    and only on rows whose pick actually fell back: 'backend-unavailable'
 *    (every model backend threw or the env kills disabled them),
 *    'deadline' (the shared 450 ms budget or a per-backend timeout) and
 *    'schema-invalid' (model output failed routeDecisionSchema or named
 *    no valid candidate — 'schema-retry' only ever accompanies it and
 *    never emits alone) count only when the row also carries
 *    'deterministic-fallback', the marker decideRoute stamps on the
 *    fallback pick. A schema-invalid a later backend recovered never
 *    reaches the deterministic pick, so it is retry noise, not
 *    starvation, and stays out. Path and policy codes —
 *    'deterministic-fallback' itself, 'local-fast', 'jev',
 *    'local-strong', 'single-candidate', 'no-candidates',
 *    'admission-blocked', 'mode-tier', 'adequate-tier',
 *    'reset-pressure', 'free-capacity', 'cheapest', 'cost-prior' — are
 *    the router working as designed and never emit.
 *  - Fleet machinery only: the journal carries no per-sample repository
 *    dimension — the sampled ready row's repo never reaches the record —
 *    so items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    sources apply.
 *  - Truncation is stated, never hidden: when the bounded tail cuts
 *    older rows, every prompt says the counts are a lower bound.
 *  - Dedup is downstream: item ids hash the cell identity — never the
 *    counts or timestamps — so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a service that
 *    recovers simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { effortSchema, routeReasonSchema, speedTierSchema } from '../routing/decision-schema.js';
import { readLedgerTail } from '../router/outcomes.js';
import {
  TYPED_DECISIONS_LEDGER_LIMIT,
  TYPED_DECISIONS_LEDGER_RELATIVE,
  TYPED_DECISIONS_ROW_SCHEMA,
} from '../router/typed-decisions.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; one unavailable cell plus three degradation codes stay well under this. */
export const TYPED_ROUTE_MAX_ITEMS = 8;
const TYPED_ROUTE_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const TYPED_ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds apply. */
const TYPED_ROUTE_FUTURE_SKEW_MS = 60_000;
/**
 * In-window rows a cell needs before it counts as recurring — the
 * unfed feed's per-tick convention. The journal records one service
 * call per dispatcher tick, so three rows is a burst, not a pattern.
 */
export const TYPED_ROUTE_MIN_ROWS = 6;
/** Distinct UTC days the evidence must span — recurring means recorded across days. */
export const TYPED_ROUTE_MIN_DAYS = 2;
/**
 * 'unavailable' samples must be at least this share of all valid
 * in-window records: the whole-call failure is the severe signal, so a
 * handful of timeouts inside a healthy stream stays quiet.
 */
export const TYPED_UNAVAILABLE_SHARE = 0.1;
/**
 * A degradation code must ride at least this share of observed
 * decisions: below one decision in twenty the fallback noise is normal
 * operation, not a starving evidence stream.
 */
export const TYPED_DEGRADED_SHARE = 0.05;
/**
 * The decideRoute failure vocabulary that emits — the accumulated
 * reasons that force the deterministic fallback. 'schema-retry' is
 * derivative of 'schema-invalid' and never emits alone;
 * 'deterministic-fallback' is the path marker every counted row must
 * carry, so the codes name the causes, not recovered retries.
 */
export const TYPED_ROUTE_DEGRADED_CODES = ['backend-unavailable', 'deadline', 'schema-invalid'] as const;
/** The fleet's own repository label: journal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

const JOURNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORTS: ReadonlySet<string> = new Set(effortSchema.options);
const SPEED_TIERS: ReadonlySet<string> = new Set(speedTierSchema.options);
const REASON_CODES: ReadonlySet<string> = new Set(routeReasonSchema.options);
const DEGRADED: ReadonlySet<string> = new Set(TYPED_ROUTE_DEGRADED_CODES);

export interface TypedRouteItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/route.explain.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Journal override (default: <runsDir>/metrics/route.explain.jsonl). */
  journalPath?: string;
  /** Evidence window in ms (default TYPED_ROUTE_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default TYPED_ROUTE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_NAME_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const str = (r: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const v = r[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

const dayOf = (tsSeconds: number): string => new Date(tsSeconds * 1000).toISOString().slice(0, 10);

/**
 * One observed row's recorded decision, validated against the producer's
 * closed vocabulary — the same allowlist foldTypedDecisions applies
 * (bounded lane/model ids, the effort/speed-tier enums, 1–16
 * in-vocabulary reason codes). Returns the reason codes, or null when
 * the row is not a decision the producer could have written.
 */
function decisionReasons(raw: unknown): string[] | null {
  if (!isRecord(raw)) return null;
  const lane = raw['lane'];
  const model = raw['model'];
  const effort = raw['effort'];
  const speedTier = raw['speed_tier'];
  const reasons = raw['reason_codes'];
  if (typeof lane !== 'string' || !JOURNAL_ID.test(lane)) return null;
  if (typeof model !== 'string' || !JOURNAL_ID.test(model)) return null;
  if (typeof effort !== 'string' || !EFFORTS.has(effort)) return null;
  if (typeof speedTier !== 'string' || !SPEED_TIERS.has(speedTier)) return null;
  if (!Array.isArray(reasons) || reasons.length < 1 || reasons.length > 16) return null;
  const codes: string[] = [];
  for (const code of reasons) {
    if (typeof code !== 'string' || !REASON_CODES.has(code)) return null;
    codes.push(code);
  }
  return codes;
}

/** Degradation evidence for one reason code inside the window. */
export interface TypedRouteCodeCell {
  code: string;
  /** Observed decisions carrying the code. */
  rows: number;
  /** Distinct UTC days the rows span. */
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface TypedRouteFold {
  /** Valid in-window route.explain.v1 records (observed + unavailable). */
  records: number;
  /** Retained-tail lines that failed JSON parse or the producer contract. */
  invalidRows: number;
  /** Records whose status is 'observed' with a validated decision. */
  observed: number;
  /** Records whose status is 'unavailable' — the whole decide call failed. */
  unavailable: number;
  /** Distinct UTC days unavailable samples span. */
  unavailableDays: Set<string>;
  firstUnavailableMs: number | null;
  lastUnavailableMs: number | null;
  /** Per-degradation-code cells over observed decisions. */
  degraded: Map<string, TypedRouteCodeCell>;
}

/**
 * Pure: fold one journal tail into the typed-route evidence fold. Rows
 * outside the window, malformed JSON, wrong schema/event, missing
 * advisory or an unvalidated decision are skipped — never guessed.
 */
export function foldTypedRouteJournal(text: string, nowMs: number, windowMs: number): TypedRouteFold {
  const fold: TypedRouteFold = {
    records: 0, invalidRows: 0, observed: 0, unavailable: 0,
    unavailableDays: new Set(), firstUnavailableMs: null, lastUnavailableMs: null,
    degraded: new Map(),
  };
  const since = nowMs / 1000 - windowMs / 1000;
  const until = nowMs / 1000 + TYPED_ROUTE_FUTURE_SKEW_MS / 1000;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (!isRecord(row) || row['schema'] !== TYPED_DECISIONS_ROW_SCHEMA ||
        str(row, 'event', 'type', 'kind') !== 'route.explain' ||
        row['advisory'] !== true) {
      fold.invalidRows += 1;
      continue;
    }
    const ts = row['ts'];
    const status = row['status'];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0 ||
        (status !== 'observed' && status !== 'unavailable')) {
      fold.invalidRows += 1;
      continue;
    }
    if (ts < since || ts > until) continue;
    const atMs = ts * 1000;
    if (status === 'unavailable') {
      fold.records += 1;
      fold.unavailable += 1;
      fold.unavailableDays.add(dayOf(ts));
      fold.firstUnavailableMs = fold.firstUnavailableMs === null ? atMs : Math.min(fold.firstUnavailableMs, atMs);
      fold.lastUnavailableMs = fold.lastUnavailableMs === null ? atMs : Math.max(fold.lastUnavailableMs, atMs);
      continue;
    }
    const reasons = decisionReasons(row['decision']);
    if (reasons === null) { fold.invalidRows += 1; continue; }
    fold.records += 1;
    fold.observed += 1;
    // Only a decision that actually fell back counts: decideRoute stamps
    // 'deterministic-fallback' on the fallback pick, while a degraded
    // code a later backend recovered rides a model pick instead.
    if (!reasons.includes('deterministic-fallback')) continue;
    const seen = new Set<string>();
    for (const code of reasons) {
      if (!DEGRADED.has(code) || seen.has(code)) continue;
      seen.add(code);
      let cell = fold.degraded.get(code);
      if (cell === undefined) {
        cell = { code, rows: 0, days: new Set(), firstMs: null, lastMs: null };
        fold.degraded.set(code, cell);
      }
      cell.rows += 1;
      cell.days.add(dayOf(ts));
      cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
      cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export type TypedRouteCellKind = 'unavailable' | 'degraded';

export interface TypedRouteCell {
  kind: TypedRouteCellKind;
  /** Degradation code for kind 'degraded'; null for 'unavailable'. */
  code: string | null;
  /** Evidence rows inside the window. */
  rows: number;
  /** Share denominator: all valid records for 'unavailable', observed decisions for 'degraded'. */
  total: number;
  /** rows / total, computed by the caller-facing cell. */
  share: number;
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
 * Pure: the recurring cells the fold justifies. 'unavailable' emits
 * while unavailable samples reach the row/day bars and hold
 * TYPED_UNAVAILABLE_SHARE of all valid records; each degradation code
 * emits while its fallback-marked observed rows reach the same bars
 * and hold TYPED_DEGRADED_SHARE of observed decisions. Sorted
 * unavailable-first, then by rows.
 */
export function typedRouteCells(fold: TypedRouteFold, lowerBound = false): TypedRouteCell[] {
  const cells: TypedRouteCell[] = [];
  if (fold.records > 0 && fold.unavailable >= TYPED_ROUTE_MIN_ROWS &&
      fold.unavailableDays.size >= TYPED_ROUTE_MIN_DAYS &&
      fold.unavailable / fold.records >= TYPED_UNAVAILABLE_SHARE) {
    cells.push({
      kind: 'unavailable', code: null,
      rows: fold.unavailable, total: fold.records,
      share: fold.unavailable / fold.records,
      days: [...fold.unavailableDays].sort(),
      firstSeen: isoOrNull(fold.firstUnavailableMs), lastSeen: isoOrNull(fold.lastUnavailableMs),
      lowerBound,
    });
  }
  const degraded = [...fold.degraded.values()]
    .filter((cell) => cell.rows >= TYPED_ROUTE_MIN_ROWS && cell.days.size >= TYPED_ROUTE_MIN_DAYS &&
      fold.observed > 0 && cell.rows / fold.observed >= TYPED_DEGRADED_SHARE)
    .sort((a, b) => b.rows - a.rows || a.code.localeCompare(b.code));
  for (const cell of degraded) {
    cells.push({
      kind: 'degraded', code: cell.code,
      rows: cell.rows, total: fold.observed,
      share: cell.rows / fold.observed,
      days: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/route.explain.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): observe_typed_route in contrib/mac/dispatchd.py appends one route.explain.v1 row per dispatcher tick after sampling `phm route decide --input - --root <runs> --json` on the first ready queue row — status \'observed\' with the validated lane/model/effort/speed_tier pick, its reason_codes and the optional duration_ms/attempts/candidate_count service metrics, or \'unavailable\' when the call itself failed (nonzero exit, the 0.9 s outer cap, oversized or invalid JSON, or a decision outside route.decision.v1 and the dispatcher allowlist). readTypedDecisions (src/core/router/typed-decisions.ts) folds the same bounded tail into the route.typed-decisions.v1 digest `phm route explain --json` prints (src/core/queue/route-explain.ts); decideRoute and its backends live in src/core/routing/decision.ts, decision-backends.ts and decision-schema.ts. Until this feed that report was the journal\'s only reader — recurring unavailability or degradation never became work.';

const PINNED_NOTE = ' contrib/mac/dispatchd.py is pinned dispatcher machinery: a fix there needs Security review and re-pin before install — prefer evidence-backed changes in this repository\'s src/ where the cause lives (the route decide path, the decision backends and schemas, the journal reader), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the fleet was too quiet for the sample bars to mean anything, the codes trace to deliberate operator state (decision models disabled by env kill, Jev config off, a maintenance pause) or owner-side causes (backend credentials, quota, the local model server, host capacity), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

const cellDays = (cell: TypedRouteCell): string =>
  `across ${cell.days.length} UTC day(s) (${daysText(cell.days)})`;

function unavailablePrompt(cell: TypedRouteCell): string {
  return [
    `Phantom's typed routing service keeps failing before it can decide — the dispatcher recorded ${cell.rows} 'unavailable' route.explain sample(s) inside the 7-day window, ${pct(cell.share)} of ${cell.total} valid record(s) ${cellDays(cell)}, the self-improvement work this backlog exists for.`,
    '',
    `Each unavailable row is one tick where 'phm route decide' never produced a usable decision: the binary errored or exceeded the dispatcher's 0.9 s cap, stdout was oversized or invalid JSON, or the decision failed the route.decision.v1/advisory contract or the dispatcher's id/enum allowlist. While this holds, the typed_decisions digest stays thin and the typed routing layer — the advisory path the fleet's routing evidence depends on — produces no signal at all.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Reproduce the failure first: run the same probe the dispatcher runs — 'phm route decide --input - --root <runs> --json' with a minimal route request — under the runs dir's environment and time it against the 0.9 s cap. A slow or dead decide path points at src/cli/route.ts and src/core/routing/decision.ts (the shared 450 ms budget, backend timeouts, candidate enumeration); a contract or allowlist rejection points at drift between routeDecisionSchema/decision-backends output and the dispatcher's safe_id/enum checks; a missing binary or transport failure points at the install the dispatcher invokes.${PINNED_NOTE} If the unavailable rows trace to a deliberate config or owner-side state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const DEGRADED_GUIDANCE: Record<string, string> = {
  'backend-unavailable': `decideRoute recorded 'backend-unavailable' — every model backend threw (network, throttle, timeout, or the classifierKilledByEnv/jevKilledByEnv kills disabling them) or models are disabled outright, so the deterministic fallback pick stood in. Check whether the env kills are deliberate operator state before touching code; otherwise the causes live in src/core/routing/decision-backends.ts (the local-fast/local-strong 127.0.0.1:8123 fit and transport checks, the Jev decide() path and its config gate in src/core/decide/) — a dead local model server, missing Jev config or a transport that keeps throwing are the recurring shapes.`,
  'deadline': `decideRoute recorded 'deadline' — the shared 450 ms decision budget or a per-backend timeout fired before any backend produced a valid pick, so the deterministic fallback stood in. Check the typed_decisions digest's duration_ms/attempts/candidate_count summaries for whether the budget is chronically short or the backends chronically slow; the budget and timeout constants live in src/core/routing/decision.ts, and candidate enumeration cost lives in decision-candidates.ts.`,
  'schema-invalid': `decideRoute recorded 'schema-invalid' — a backend's output failed routeDecisionSchema or named no valid candidate ('schema-retry' rides the same rows when a retry ran, and never emits alone). The deterministic fallback or a later backend stood in. Check the ask() prompts and output contract in src/core/routing/decision-backends.ts against routeDecisionSchema in decision-schema.ts — a model that keeps answering outside the schema, or a criteria/projection drift that makes every answer unselectable, is the recurring shape.`,
};

function degradedPrompt(cell: TypedRouteCell): string {
  const code = fieldText(cell.code ?? '', MAX_NAME_CHARS);
  const guidance = DEGRADED_GUIDANCE[cell.code ?? ''] ??
    'Find which decideRoute path recorded the code and why it keeps recurring.';
  return [
    `Phantom's typed routing decisions keep degrading to the deterministic fallback — ${cell.rows} observed decision(s) inside the 7-day window carried reason code '${code}', ${pct(cell.share)} of ${cell.total} observed decision(s) ${cellDays(cell)}, the self-improvement work this backlog exists for.`,
    '',
    `An observed row is a decision the typed service did return; the code means its model path failed and decideRoute fell back to the deterministic pick — the recorded route is the deterministic pick's, not a model's, so the typed layer's comparative routing evidence is starving exactly where it should be thickest. 'deterministic-fallback' itself rides every counted decision and is the path marker, not a separate cause; 'schema-retry' only ever accompanies 'schema-invalid', and a degraded code a later backend recovered never reaches the fallback pick so it never counts here.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    guidance,
    '',
    `Fix what lives here — the decision path, backends and schemas in this repository's src/ — and keep deliberate operator state (env kills, disabled Jev, paused models) and owner-side causes (credentials, quota, host capacity) out of scope.${PINNED_NOTE} If the window has rolled forward or the codes trace to deliberate state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function typedRouteItem(cell: TypedRouteCell, repo: string): CloudBacklogItem {
  const identity = cell.kind === 'unavailable' ? 'unavailable' : `degraded:${cell.code ?? ''}`;
  const title = cell.kind === 'unavailable'
    ? `Typed routing service keeps failing before it can decide`
    : `Typed routing decisions keep degrading: ${cell.code}`;
  return {
    id: `typed-route-${sha(identity)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'unavailable' ? unavailablePrompt(cell) : degradedPrompt(cell),
    area: 'typed-route',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the typed-routing journal's recurring unavailability
 * and degradation evidence. Total: a missing journal, another repository
 * or any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function typedRouteBacklogItems(opts: TypedRouteItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR'];
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns.startsWith('/') ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : TYPED_ROUTE_WINDOW_MS;
    const path = opts.journalPath ?? join(runsDir, TYPED_DECISIONS_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, TYPED_DECISIONS_LEDGER_LIMIT);
    if (tail.state !== 'read') return [];
    const fold = foldTypedRouteJournal(tail.text, nowMs, windowMs);
    if (fold.records === 0) return [];
    const cells = typedRouteCells(fold, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? TYPED_ROUTE_MAX_ITEMS, TYPED_ROUTE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => typedRouteItem(cell, repo));
  } catch {
    return [];
  }
}
