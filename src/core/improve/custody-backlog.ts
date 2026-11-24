/**
 * Fleet spawn-custody ledger recurring unwrapped evidence →
 * self-improvement backlog items.
 *
 * `spawnEngine` in src/core/run/engines.ts ends every engine spawn —
 * fleet worktree launches included — by calling appendCustodyRecord in
 * src/core/run/custody-ledger.ts, which appends one value-free
 * `{schema:1, at, wrapped, engine, preflight_exit, reason?}` line to
 * `~/.ashlr/custody/spawns.jsonl` (the writer's own path: homedir(),
 * never $ASHLR_HOME), rotating once to `spawns.jsonl.1` past
 * CUSTODY_LEDGER_MAX_BYTES. The record says whether the engine ran
 * under `phantom exec` and, when it did not, which closed-list
 * UNWRAPPED_REASONS code from src/core/run/phantom-custody.ts applies —
 * decidePhantomCustody's verdict order is phantom-disabled,
 * phantom-not-installed, not-initialized (or self-authenticating-engine
 * for claude/codex), worktree-namespace, then the strict preflight's
 * preflight-blocked / preflight-unavailable, else wrapped. A task that
 * declared needs-secrets is held before the child starts
 * (custodyRequiresWrap in src/core/run/custody-capture.ts), but every
 * other unwrapped spawn still runs — the ledger exists so "ran
 * unwrapped" is never silent.
 *
 * Until now the ledger's only readers were per-window or per-run
 * surfaces: `phm status`'s custody section tallies the last 24 hours by
 * reason (gatherCustodyStatus in src/cli/status-custody.ts),
 * `phm receipt timeline` lists custody spawns inside one run's window
 * (receipt-timeline.ts), and the automerge canary sums records since
 * its first-seen mark (src/cli/automerge-canary.ts). None of them fold
 * recurrence: a custody coverage gap that persists day after day —
 * preflight keeping every wrap out, worktree spawns never reaching the
 * vault namespace, phantom missing or uninitialized across the fleet's
 * checkouts — looked like a string of one-off unwrapped spawns, never a
 * pattern, never work. The custody boundary IS self-improvement
 * machinery (the fleet's own secrets-wrap coverage), so its recurring
 * gaps are the lane's most direct evidence.
 *
 * custodyBacklogItems carries the same journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling daemon-tick, self-tick and host-load sources
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. spawns.jsonl and its rotated predecessor are read once
 *    each through readLedgerTail's bounded no-follow tails —
 *    CUSTODY_LEDGER_MAX_BYTES per generation, the writer's own per-file
 *    cap, so two generations cover exactly the writer's own
 *    CUSTODY_LEDGER_MAX_READ_BYTES bound; nothing is written and no
 *    lock, process or network is touched. A missing, non-file or
 *    unreadable generation yields no items while the other still
 *    folds — unknown stays unknown, never a guessed tally — and a
 *    truncated tail folds the retained rows with the prompts stating
 *    the counts as lower bounds.
 *  - Rows count only under the writer's contract: schema
 *    CUSTODY_LEDGER_SCHEMA (1), a parseable `at`, a boolean `wrapped`,
 *    an `engine` string normalized by the writer's own ENGINE_SHAPE
 *    rule and — for unwrapped rows — a `reason` that normalizes into
 *    UNWRAPPED_REASONS (foreign values fold to 'unknown', the writer
 *    reader's own rule); `preflight_exit` is prompt context only —
 *    the writer's safeExit shape or null, malformed values degrading
 *    to null rather than costing the record, and never a cell key.
 *    Malformed lines and foreign shapes are skipped, never guessed.
 *  - Deliberate states never emit: 'phantom-disabled' is the operator's
 *    own off switch and 'self-authenticating-engine' is the writer's
 *    by-design reason (claude/codex authenticate with their own login,
 *    never project secrets), and wrapped rows are the machinery
 *    working — all three count only as window context. The remaining
 *    seven reasons are coverage gaps: the spawn ran without custody
 *    for a reason the fleet can fix or should see.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a reason's cell emits only when its in-window
 *    unwrapped records reach CUSTODY_MIN_UNITS across CUSTODY_MIN_DAYS
 *    distinct UTC days — one unwrapped spawn or a one-day burst stays
 *    quiet. The window is anchored on the clock with the sibling
 *    feeds' future-skew allowance.
 *  - The evidence carries no repository dimension — it describes this
 *    install's engine spawns and custody configuration. Items therefore
 *    emit only when the backlog target's repository name is 'phantom',
 *    the same last-segment rule the sibling fleet-evidence sources
 *    apply.
 *  - Dedup is downstream. Item ids key on the reason code — a member
 *    of the writer's closed vocabulary, never journal text — so a
 *    refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new; a reason that recovers simply stops re-adding.
 *  - Every journal string is untrusted text: engine names are
 *    scrubbed, flattened and capped before they reach a prompt, and
 *    the prompt quotes no raw ledger line.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { CUSTODY_LEDGER_MAX_BYTES, CUSTODY_LEDGER_SCHEMA } from '../run/custody-ledger.js';
import { normalizeUnwrappedReason, UNWRAPPED_REASONS, type UnwrappedReason } from '../run/phantom-custody.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the closed reason vocabulary bounds the cells anyway. */
export const CUSTODY_BACKLOG_MAX_ITEMS = 8;
const CUSTODY_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const CUSTODY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
const CUSTODY_FUTURE_SKEW_MS = 60_000;
/** In-window records a reason needs before its outcome counts as recurring. */
export const CUSTODY_MIN_UNITS = 3;
/** Distinct UTC days the records must span — recurring means recorded across days. */
export const CUSTODY_MIN_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded engine names are unbounded text; flatten, scrub and cap before use. */
const ENGINE_MAX = 64;
/** Distinct engine names quoted inside one prompt before the rest is summarized. */
const ENGINE_SAMPLES_MAX = 6;
/** The fleet's own repository label: custody evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's ledger file name under <home>/.ashlr/custody (custodyLedgerPath). */
const LEDGER_NAME = 'spawns.jsonl';

/**
 * The unwrapped reasons that are coverage gaps rather than deliberate
 * state: every UNWRAPPED_REASONS member except 'phantom-disabled' (the
 * operator's own off switch) and 'self-authenticating-engine' (the
 * writer's by-design reason — those engines authenticate with their own
 * login, never project secrets). Membership order follows the writer's
 * vocabulary so emission order is stable.
 */
export type AdverseCustodyReason = Exclude<UnwrappedReason, 'phantom-disabled' | 'self-authenticating-engine'>;
const ADVERSE_REASONS: readonly AdverseCustodyReason[] = UNWRAPPED_REASONS.filter(
  (reason): reason is AdverseCustodyReason => reason !== 'phantom-disabled' && reason !== 'self-authenticating-engine',
);
const ADVERSE_REASON_SET: ReadonlySet<string> = new Set(ADVERSE_REASONS);

export interface CustodyItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home holding .ashlr/custody/spawns.jsonl (default: os.homedir(), the writer's own root — $ASHLR_HOME is never consulted). */
  homeDir?: string;
  /** Ledger file override (default: <homeDir>/.ashlr/custody/spawns.jsonl); tests only. */
  ledgerPath?: string;
  /** Most items one call emits (default CUSTODY_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default CUSTODY_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated ledger record inside the evidence window. */
export interface CustodyRecord {
  atMs: number;
  utcDay: string;
  wrapped: boolean;
  /** The writer's safeExit shape kept as context: integer in [-1, 255] or null. */
  preflightExit: number | null;
  /** Unwrapped rows only: the normalized UNWRAPPED_REASONS member ('unknown' for foreign values). */
  reason: UnwrappedReason | null;
  /** Engine basename as recorded; 'unknown' when the writer's shape check failed. */
  engine: string;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The writer's engine contract (custody-ledger.ts ENGINE_SHAPE): safe charset, 1-64 chars, else 'unknown'. */
const CUSTODY_ENGINE_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The writer's safeExit contract as context: an integer in [-1, 255],
 * or null. Anything else degrades to null — the field is prompt
 * context, never evidence, so a malformed value costs the exit code,
 * not the custody record (the writer's own readers ignore it too).
 */
function safePreflightExit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= -1 && value <= 255) return value;
  return null;
}

/**
 * Pure: validate one parsed ledger line against the writer's record
 * contract — schema CUSTODY_LEDGER_SCHEMA, a parseable `at`, a boolean
 * `wrapped`, an `engine` string (off-shape values read as 'unknown',
 * the writer's own normalization) and the safeExit `preflight_exit`
 * shape. Unwrapped rows carry a `reason` normalized into
 * UNWRAPPED_REASONS exactly as the writer's own reader does (foreign
 * values become 'unknown'); wrapped rows ignore any stray reason.
 * Anything else is not a custody record.
 */
export function parseCustodyRecord(value: unknown): CustodyRecord | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== CUSTODY_LEDGER_SCHEMA) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const wrapped = value['wrapped'];
  if (typeof wrapped !== 'boolean') return null;
  const engineRaw = value['engine'];
  const engine = typeof engineRaw === 'string' && CUSTODY_ENGINE_SHAPE.test(engineRaw) ? engineRaw : 'unknown';
  const preflightExit = safePreflightExit(value['preflight_exit']);
  let reason: UnwrappedReason | null = null;
  if (!wrapped) reason = normalizeUnwrappedReason(value['reason']);
  return { atMs, utcDay: utcDayOf(atMs), wrapped, preflightExit, reason, engine };
}

/**
 * Pure: parse journal text into validated records plus the count of
 * lines that were not on-contract records — malformed JSON, foreign
 * shapes and off-contract rows are counted, never guessed.
 */
export function parseCustodyJournal(text: string): { records: CustodyRecord[]; invalidRows: number } {
  const records: CustodyRecord[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const record = parseCustodyRecord(value);
    if (record === null) { invalidRows += 1; continue; }
    records.push(record);
  }
  return { records, invalidRows };
}

/** One adverse reason's recurring tally across the in-window records. */
interface CustodyCell {
  /** The UNWRAPPED_REASONS member this cell folds — the stable item-id suffix. */
  reason: AdverseCustodyReason;
  /** Unwrapped in-window records carrying this reason. */
  units: number;
  /** Distinct UTC days those records fall on. */
  days: Set<string>;
  /** Per-engine record counts, for prompt context (never a cell key). */
  engines: Map<string, number>;
  /** Distinct preflight_exit values seen, for prompt context. */
  preflightExits: Set<number | null>;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded engine names are untrusted text; flatten, scrub and cap before use. */
function engineText(engine: string): string {
  return scrubSecrets(engine).replace(/[^A-Za-z0-9._-]/g, '').slice(0, ENGINE_MAX) || 'unknown';
}

/**
 * Pure: fold validated in-window records into per-reason tallies plus
 * window context. Only unwrapped records inside ADVERSE_REASONS count —
 * wrapped rows and the two deliberate reasons are context, never
 * evidence.
 */
export function foldCustodyEvidence(
  records: readonly CustodyRecord[],
  opts: { nowMs: number; windowMs?: number },
): { cells: CustodyCell[]; records: number; wrapped: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? CUSTODY_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<AdverseCustodyReason, CustodyCell>();
  let inWindow = 0;
  let wrapped = 0;
  let outsideWindow = 0;
  for (const record of records) {
    if (record.atMs < windowStart || record.atMs > opts.nowMs + CUSTODY_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    inWindow += 1;
    if (record.wrapped) { wrapped += 1; continue; }
    const reason = record.reason;
    if (reason === null || !ADVERSE_REASON_SET.has(reason)) continue;
    const adverse = reason as AdverseCustodyReason;
    let cell = cells.get(adverse);
    if (cell === undefined) {
      cell = { reason: adverse, units: 0, days: new Set(), engines: new Map(), preflightExits: new Set(), firstAtMs: Infinity, lastAtMs: -Infinity };
      cells.set(adverse, cell);
    }
    cell.units += 1;
    cell.days.add(record.utcDay);
    const engine = engineText(record.engine);
    cell.engines.set(engine, (cell.engines.get(engine) ?? 0) + 1);
    cell.preflightExits.add(record.preflightExit);
    cell.firstAtMs = Math.min(cell.firstAtMs, record.atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, record.atMs);
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.units >= CUSTODY_MIN_UNITS && cell.days.size >= CUSTODY_MIN_DAYS)
    .sort((a, b) => b.units - a.units || ADVERSE_REASONS.indexOf(a.reason) - ADVERSE_REASONS.indexOf(b.reason));
  return { cells: recurring, records: inWindow, wrapped, outsideWindow };
}

/** The evidence pointers every prompt shares; the ledger, its writer and its existing readers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ~/.ashlr/custody/spawns.jsonl (the writer\'s own path — homedir(), never $ASHLR_HOME; spawns.jsonl.1 is the rotated predecessor), schema 1 — one value-free record per engine spawn appended by appendCustodyRecord in src/core/run/custody-ledger.ts from the spawnEngine path in src/core/run/engines.ts, including phantom-disabled spawns, capped at 4 MiB per generation. Each row says whether the engine ran under `phantom exec` and, when it did not, which closed-list UNWRAPPED_REASONS code decidePhantomCustody in src/core/run/phantom-custody.ts returned; a needs-secrets task is held before the child starts (custodyRequiresWrap in src/core/run/custody-capture.ts) but every other unwrapped spawn still runs. Its only readers until this feed were `phm status`\'s 24-hour custody tally (gatherCustodyStatus in src/cli/status-custody.ts), `phm receipt timeline`\'s per-run window (src/core/receipt/receipt-timeline.ts) and the automerge canary\'s since-first-seen sum (src/cli/automerge-canary.ts) — per-window surfaces, never a recurrence fold.';

const NO_CHANGE = 'If the window has rolled forward, the unwrapped spawns were a one-off burst the later records recovered from, or the cause is owner-side or pinned ops machinery (the installed phantom binary or its initialization state on this host, credentials, billing, host resources, the Security-reviewed files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (outsideWindow > 0) notes.push(`${outsideWindow} records outside the window not counted`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function cellCounts(cell: CustodyCell, windowRecords: number, windowWrapped: number): string {
  return `${cell.units} in-window unwrapped records across ${cell.days.size} UTC days (of ${windowRecords} in-window spawns, ${windowWrapped} wrapped)`;
}

function engineMixText(cell: CustodyCell): string {
  const entries = [...cell.engines.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = entries.slice(0, ENGINE_SAMPLES_MAX).map(([engine, count]) => `${engine}×${count}`).join(', ');
  const rest = entries.length - Math.min(entries.length, ENGINE_SAMPLES_MAX);
  return rest > 0 ? `${shown}, and ${rest} more engine${rest === 1 ? '' : 's'}` : shown;
}

function exitText(cell: CustodyCell): string {
  const exits = [...cell.preflightExits].sort((a, b) => (a ?? -2) - (b ?? -2));
  if (exits.length === 0) return '';
  const shown = exits.slice(0, 6).map((exit) => (exit === null ? 'none' : String(exit))).join(', ');
  return exits.length > 6 ? ` Preflight exits seen include ${shown}, and more.` : ` Preflight exits seen: ${shown}.`;
}

/** What each adverse reason means under the writer's contract, and where the fix lives. */
const REASON_GUIDANCE: Record<AdverseCustodyReason, { means: string; hunt: string }> = {
  'not-initialized': {
    means: "decidePhantomCustody returned 'not-initialized': cfg.phantom.enabled was on and the phantom binary was found, but phantomInitializedAt(cwd) found no initialization at the spawn's working directory — and the engine is not one of the self-authenticating pair, so nothing else covers it.",
    hunt: 'Find why the spawn cwd keeps lacking phantom initialization: whether fleet worktree or job checkouts are created without running the phantom init step the repo expects, whether phantomInitializedAt probes the wrong marker, or whether init is genuinely a per-checkout step the fleet should run. The spawn path and custody decision live in this repo (src/core/run/engines.ts, src/core/run/phantom-custody.ts); whether a given checkout is initialized is host state — if the evidence says the fleet simply never initializes its worktrees, that gap is the work.',
  },
  'phantom-not-installed': {
    means: "decidePhantomCustody returned 'phantom-not-installed': cfg.phantom.enabled was on but phantomInstalled() could not find the phantom binary — every spawn then ran unwrapped regardless of checkout state.",
    hunt: 'Find why the installed check keeps failing: the phantomInstalled probe in src/core/run/engines.ts (PATH lookup, pinned location or version gate), a phantom install that moved or was removed on this host, or an enabled flag set where the binary was never provisioned. The probe and the enable flag are this repo\'s code; the host\'s phantom installation is ops state — report no-change if the binary is simply absent by owner choice.',
  },
  'worktree-namespace': {
    means: "decidePhantomCustody returned 'worktree-namespace': the spawn ran inside a linked git worktree (.git is a file), where phantom derives a separate, empty vault namespace from the checkout path — the documented gap 'until the opt-in source binding lands'.",
    hunt: 'This is the fleet\'s dominant unwrapped class by design today: every linked-worktree spawn records it. The work is the opt-in source binding the comment in engines.ts names — letting a worktree spawn resolve the parent checkout\'s vault namespace instead of opening an empty one — or an explicit decision that worktree custody stays out of scope, recorded where the next agent will find it. The namespace derivation and the wrap decision live in this repo (src/core/run/engines.ts, src/core/run/phantom-custody.ts, phantomWrap); do not weaken the hold rule or fabricate a namespace — report no-change if the binding is already landed or deliberately deferred.',
  },
  'preflight-blocked': {
    means: "the strict preflight (ASHLR_PHANTOM_PREFLIGHT=1, `phantom agent doctor --json --strict` in the spawn cwd, src/core/run/phantom-preflight.ts) returned verdict 'blocked' or 'degraded' — exit 1 or 2 — so mayWrap was false and the spawn ran unwrapped rather than under custody.",
    hunt: 'Find which doctor check keeps blocking: run `phantom agent doctor --json --strict` in a fleet spawn cwd and read the failing check ids (the ledger row carries only the exit code — the check ids live in the preflight result, not the ledger). A check that fails on every worktree is a real custody gap; a check failing only on stale or foreign checkouts may be correct blocking. The preflight contract is this repo\'s (src/core/run/phantom-preflight.ts); the doctor implementation is the phantom side — report no-change if the blocks are correct verdicts on genuinely unready environments.',
  },
  'preflight-unavailable': {
    means: "the strict preflight could not evaluate at all — spawn error, timeout, unparsable or oversized output, an exit code outside {0,1,2}, a schema/kind/verdict mismatch, or a vault_probed disagreement — so interpretPhantomPreflight returned 'unavailable' and the spawn ran unwrapped.",
    hunt: 'Find why the preflight keeps failing to produce a verdict: a phantom binary that hangs or crashes under spawnSync (PHANTOM_PREFLIGHT_TIMEOUT_MS is 15s), output that stopped matching schema_version 1 / kind phantom.agent.preflight, or a phantom version drift between the fleet\'s expectation and the installed binary. The interpreter and its contract are this repo\'s (src/core/run/phantom-preflight.ts); the binary\'s behavior is phantom-side — report no-change if the preflight is simply off (ASHLR_PHANTOM_PREFLIGHT unset) and these rows predate its enablement.',
  },
  'connection-string-blocked': {
    means: "the reason code is in UNWRAPPED_REASONS but no current decidePhantomCustody path returns it — the rows come from an older writer, a path this checkout does not show, or a contract drift between writer versions.",
    hunt: 'Find what emits this reason today: git log -S connection-string-blocked across the repo and its history, the phantom-side writer if one exists, and whether the installed fleet build is older or newer than this checkout. If the vocabulary member is dead, the recurring rows are stale-writer evidence and the fix is a writer/reader contract reconciliation — report no-change if the rows are all outside the current writer\'s vocabulary and predate it.',
  },
  'unknown': {
    means: "the row's reason normalized to 'unknown' — normalizeUnwrappedReason maps any value outside UNWRAPPED_REASONS there, so these unwrapped records carry a reason this checkout's vocabulary does not know (a newer writer, a hand-edited row, or corruption that still parsed).",
    hunt: 'Find what wrote the unclassifiable reasons: compare the raw reason values in spawns.jsonl against UNWRAPPED_REASONS in src/core/run/phantom-custody.ts — a newer phantom build may have extended the vocabulary this checkout lacks, in which case the fix is syncing the closed list; genuinely corrupt rows are writer bugs. Report no-change if every unknown row is a one-off foreign write.',
  },
};

function reasonTitle(reason: AdverseCustodyReason): string {
  switch (reason) {
    case 'not-initialized': return 'Fleet engine spawns keep running unwrapped: phantom not initialized at the spawn cwd';
    case 'phantom-not-installed': return 'Fleet engine spawns keep running unwrapped: phantom binary not found';
    case 'worktree-namespace': return 'Fleet worktree spawns keep running unwrapped: linked-worktree vault namespace';
    case 'preflight-blocked': return 'Fleet engine spawns keep running unwrapped: strict phantom preflight keeps blocking';
    case 'preflight-unavailable': return 'Fleet engine spawns keep running unwrapped: strict phantom preflight keeps failing to evaluate';
    case 'connection-string-blocked': return 'Fleet engine spawns keep running unwrapped: connection-string-blocked records recur';
    case 'unknown': return 'Fleet engine spawns keep running unwrapped with unclassifiable reasons';
    default: return `Fleet engine spawns keep running unwrapped: '${reason}'`;
  }
}

function custodyPrompt(cell: CustodyCell, windowRecords: number, windowWrapped: number, truncated: boolean, invalidRows: number, outsideWindow: number): string {
  const guidance = REASON_GUIDANCE[cell.reason];
  return [
    `Phantom's engine spawns keep running without secrets custody — ${cellCounts(cell, windowRecords, windowWrapped)} inside the window recorded unwrapped reason '${cell.reason}', the self-improvement work this backlog exists for.`,
    '',
    `${guidance.means} ${guidance.hunt}${spanText(cell.firstAtMs, cell.lastAtMs)} Engines seen: ${engineMixText(cell)}.${exitText(cell)}${coverageNote(truncated, invalidRows, outsideWindow)}`,
    '',
    EVIDENCE,
    '',
    `The recurring bar is three unwrapped records across two UTC days inside seven days; 'phantom-disabled' and 'self-authenticating-engine' are the writer's deliberate vocabulary and never count, and wrapped rows are the machinery working. Fix the coverage gap in this repo — the wrap decision, the namespace or init detection, the installed-binary probe or the preflight contract — never by weakening the needs-secrets hold, inventing custody the spawn did not have, or printing secret values. ${NO_CHANGE}`,
  ].join('\n');
}

function custodyItem(cell: CustodyCell, windowRecords: number, windowWrapped: number, repo: string, truncated: boolean, invalidRows: number, outsideWindow: number): CloudBacklogItem {
  return {
    id: `custody-${cell.reason}`,
    title: reasonTitle(cell.reason).slice(0, MAX_TITLE_CHARS),
    prompt: custodyPrompt(cell, windowRecords, windowWrapped, truncated, invalidRows, outsideWindow),
    area: 'fleet-custody',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the spawn-custody ledger's recurring unwrapped
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function custodyBacklogItems(opts: CustodyItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // The writer's own path: custodyDir() is homedir()/.ashlr/custody and
    // never consults $ASHLR_HOME, so neither does this read.
    const journalPath = opts.ledgerPath ?? join(home, '.ashlr', 'custody', LEDGER_NAME);
    const nowMs = (opts.now ?? new Date()).getTime();
    // The writer rotates at CUSTODY_LEDGER_MAX_BYTES keeping one .1
    // predecessor; read both tails so the window reaches back across a
    // rotation, oldest file first — the same two-generation convention
    // the runtime-journal feed applies.
    const previousPath = `${journalPath}.1`;
    const [current, previous] = await Promise.all([
      readLedgerTail(journalPath, CUSTODY_LEDGER_MAX_BYTES),
      readLedgerTail(previousPath, CUSTODY_LEDGER_MAX_BYTES),
    ]);
    const texts: string[] = [];
    let lowerBound = false;
    if (previous.state === 'read') {
      texts.push(previous.text);
      lowerBound = previous.truncated;
    }
    if (current.state === 'read') {
      texts.push(current.text);
      lowerBound = lowerBound || current.truncated;
    } else if (texts.length === 0) {
      return [];
    }
    const records: CustodyRecord[] = [];
    let invalidRows = 0;
    for (const text of texts) {
      const parsed = parseCustodyJournal(text);
      records.push(...parsed.records);
      invalidRows += parsed.invalidRows;
    }
    const folded = foldCustodyEvidence(records, { nowMs, windowMs: opts.windowMs });
    if (folded.cells.length === 0) return [];
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(custodyItem(cell, folded.records, folded.wrapped, repo, lowerBound, invalidRows, folded.outsideWindow));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? CUSTODY_BACKLOG_MAX_ITEMS, CUSTODY_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
