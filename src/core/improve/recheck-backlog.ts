/**
 * Fleet recheck verdict history → self-improvement backlog items.
 *
 * The self-tick's recheck-record step appends one sanitized
 * fleet.recheck-record.v1 row per apply pass to
 * <ashlr home>/fleet/recheck-log.jsonl (newest 500 kept), and
 * `phm fleet recheck-record` appends the same row on demand. Each row is
 * the read-only fleet recheck's verdict projected to metadata: the
 * overall state (VERIFIED only when all four sections verify, else the
 * worst of BLOCKED > UNKNOWN), the runtime, claims, bridge and task
 * section states, and bounded per-section missing-reason lists. Until
 * now the retained history was write-only evidence: `phm fleet
 * recheck-record --last`, the verse recheck API's history parameter and
 * the fleet MCP recheck tool all read only the newest rows, so a section
 * that keeps coming back UNKNOWN (its evidence path never arrives) or
 * BLOCKED (a positively identified gap persists), or the same missing
 * reason recurring pass after pass, never became work — the fleet's own
 * verification of its claimed state degrading sat in a log nobody folds.
 *
 * recheckBacklogItems carries that history into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the fleet outcome-learning, nightly retro, policy,
 * local-gate, pass^k, friction, tick-health, cross-review, empty-tag,
 * post-merge, ci-rerun, lost-launch, memory, fleet-controller,
 * skill-outcome, precheck-skip and source-yield sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. fleet/recheck-log.jsonl is read through readSource's
 *    bounded no-follow tail read; nothing is written and no network is
 *    touched. Only the asOf, overall and per-section state and missing
 *    fields are consumed — task ids, owners, claim receipts, host and
 *    version strings and tailnet peer evidence never reach a prompt.
 *  - Healthy-only evidence. A missing log yields no items (a fresh
 *    install or a self-tick that never ran apply is normal, not a
 *    finding); an unreadable or oversized source yields no items —
 *    unknown stays unknown, never a guessed tally. Malformed lines are
 *    skipped like the reader's own skipped count, and a row missing the
 *    fields the fold needs contributes nothing rather than sinking the
 *    pass.
 *  - Recency-windowed. Only rows whose asOf parses inside
 *    RECHECK_WINDOW_MS of the clock count, with the same future-skew
 *    allowance the sibling folds apply; a row with no parseable
 *    timestamp cannot be placed in the window and is ignored, so a log
 *    that stopped being written weeks ago never queues work for stale
 *    verdicts.
 *  - Recurring means recorded. A cell emits only after
 *    RECHECK_RECURRING in-window rows carry it — the fleet's
 *    RECURRING_FAILURES convention — so one bad pass never queues a
 *    session. UNKNOWN (the section's evidence never arrived or its
 *    reader failed) and BLOCKED (a positively identified gap) are
 *    separate cells: they are different problems with different fixes.
 *    Missing reasons are normalized — digits collapse to '#' so
 *    'task: 3 candidate(s) lack a named owner' and 'task: 5 …' are the
 *    same recurring reason — and grouped across the per-section lists,
 *    never the flattened overall list, so a reason counts once per row
 *    however many sections recorded it.
 *  - The recheck is this install's own machinery: it verifies the
 *    fleet's runtime, claims ledger, bridges and work board. Items
 *    therefore emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    sources apply; self-improvement pointed at another repository
 *    inherits nothing.
 *  - Dedup is downstream. The item id embeds a stable hash of the cell
 *    identity — verdict state, section+state or normalized reason —
 *    never the counts or timestamps, so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; shifted
 *    tallies do not spawn twin items, and a cell that recovers simply
 *    stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: states, section
 *    names and reasons are scrubbed, flattened to one line and capped
 *    before they reach the prompt, counts are quoted only as recorded,
 *    and the brief names the log, the verb and the self-tick step with
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { RECHECK_RECORD_SCHEMA } from '../fleet/recheck-record.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by 2 verdicts + 8 section states + distinct reasons. */
export const RECHECK_MAX_ITEMS = 8;
const RECHECK_ITEM_HARD_MAX = 25;
/**
 * Non-clean rows inside the window a cell needs before it counts as
 * recurring — the same absolute-evidence bar TICK_HEALTH_RECURRING and
 * outcome-learning's RECURRING_FAILURES apply.
 */
export const RECHECK_RECURRING = 3;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const RECHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds apply. */
const RECHECK_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded no-follow tail of the verdict log. The writer keeps the newest
 * 500 rows and every field on a row is already bounded (8 reasons × 160
 * chars per list, 8 tailnet peers), so ~8 MiB covers the whole retained
 * history with headroom; past it the tail still holds the newest rows.
 */
const RECHECK_LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded text is bounded but still untrusted-shaped; flatten, scrub and cap before use. */
const MAX_REASON_CHARS = 160;
const MAX_REASON_KEY_CHARS = 200;
/** The fleet's own repository label: recheck evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Verdict vocabulary the writer projects from FleetRecheckState; anything else is not a verdict row. */
const VERDICT_STATES: ReadonlySet<string> = new Set(['VERIFIED', 'UNKNOWN', 'BLOCKED']);
const NON_CLEAN_STATES: ReadonlySet<string> = new Set(['UNKNOWN', 'BLOCKED']);
const SECTION_NAMES = ['runtime', 'claims', 'bridge', 'task'] as const;
type SectionName = (typeof SECTION_NAMES)[number];

export interface RecheckItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Ashlr home root holding fleet/recheck-log.jsonl; defaults to ashlrHome() ($ASHLR_HOME or ~/.ashlr). */
  rootDir?: string;
  /** Most items one call emits (default RECHECK_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default RECHECK_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
  /**
   * Injected recheck-log.jsonl text (tests); skips the file read when
   * set. Same contract as the sibling feeds' text inputs: null means the
   * log is missing — withheld evidence, never zero-filled tallies.
   */
  logText?: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded-shaped; flatten, scrub and cap before use. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** One parsed, in-window verdict row — only the fields the fold consumes. */
interface RecheckRow {
  atMs: number;
  overall: string;
  sections: Record<SectionName, string>;
  /** Per-section missing reasons, attribution kept; 'overall' list deliberately unused (it is their union). */
  reasons: Record<SectionName, string[]>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The reason lists a section bucket carries; absent or malformed reads as no reasons, never a failed row. */
function reasonList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Pure-ish: one ledger line → a row the fold can use, or null. Mirrors
 * the reader's own contract loosely on purpose: schema, a parseable
 * asOf, a verdict-vocabulary overall and the four section objects with
 * string states are required; missing reasons are optional (rows
 * recorded before reasons were retained carry null) and anything else
 * malformed drops only this line.
 */
function parseRecheckLine(line: string): { atMs: number; row: Omit<RecheckRow, 'atMs'> } | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isObj(value) || value['schema'] !== RECHECK_RECORD_SCHEMA) return null;
  if (typeof value['asOf'] !== 'string') return null;
  const atMs = Date.parse(value['asOf']);
  if (!Number.isFinite(atMs)) return null;
  if (typeof value['overall'] !== 'string' || !VERDICT_STATES.has(value['overall'])) return null;
  const s = value['sections'];
  if (!isObj(s)) return null;
  const sections = {} as Record<SectionName, string>;
  for (const name of SECTION_NAMES) {
    const part = s[name];
    if (!isObj(part) || typeof part['state'] !== 'string' || !VERDICT_STATES.has(part['state'])) return null;
    sections[name] = part['state'];
  }
  const missing = isObj(s['missing']) ? s['missing'] : {};
  const reasons = {} as Record<SectionName, string[]>;
  for (const name of SECTION_NAMES) reasons[name] = reasonList(missing[name]);
  return { atMs, row: { overall: value['overall'], sections, reasons } };
}

/** Digits collapse so count-carrying reasons group; whitespace and case fold the same way. */
function reasonKey(reason: string): string {
  return fieldText(reason.replace(/\d+/g, '#'), MAX_REASON_KEY_CHARS).toLowerCase();
}

/** A recurring cell: what it is, how often the window recorded it, and the rows behind it. */
interface RecheckCell {
  /** Stable identity hashed into the item id — never counts or timestamps. */
  key: string;
  kind: 'verdict' | 'section' | 'reason';
  /** Verdict/section scope or the normalized reason text. */
  label: string;
  /** Worst recorded state for state cells; null for reason cells. */
  state: string | null;
  /** Section names a reason cell was recorded under, sorted. */
  scopes: string[];
  count: number;
}

const STATE_RANK: Record<string, number> = { BLOCKED: 2, UNKNOWN: 1, VERIFIED: 0 };

/**
 * Pure: fold parsed ledger lines into recurring cells. `lines` are the
 * raw JSONL text; each line validates through parseRecheckLine then the
 * window. Cells emit at RECHECK_RECURRING in-window hits; ordering is
 * count desc, then BLOCKED before UNKNOWN, then key — deterministic so
 * the item cap keeps the same cells every refresh.
 */
export function foldRecheckCells(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): { cells: RecheckCell[]; rows: number; invalidRows: number; outsideWindow: number } {
  const windowMs = opts.windowMs ?? RECHECK_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const windowEnd = opts.nowMs + RECHECK_FUTURE_SKEW_MS;
  const verdictCounts = new Map<string, number>();
  const sectionCounts = new Map<string, number>();
  const reasonCounts = new Map<string, { count: number; label: string; scopes: Set<string> }>();
  let rows = 0;
  let invalidRows = 0;
  let outsideWindow = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseRecheckLine(line);
    if (parsed === null) { invalidRows += 1; continue; }
    if (parsed.atMs < windowStart || parsed.atMs > windowEnd) { outsideWindow += 1; continue; }
    rows += 1;
    const { row } = parsed;
    if (NON_CLEAN_STATES.has(row.overall)) {
      verdictCounts.set(row.overall, (verdictCounts.get(row.overall) ?? 0) + 1);
    }
    for (const name of SECTION_NAMES) {
      const state = row.sections[name];
      if (!NON_CLEAN_STATES.has(state)) continue;
      const key = `${name}:${state}`;
      sectionCounts.set(key, (sectionCounts.get(key) ?? 0) + 1);
    }
    const seen = new Set<string>();
    for (const name of SECTION_NAMES) {
      for (const reason of row.reasons[name]) {
        const key = reasonKey(reason);
        if (key === '') continue;
        const entry = reasonCounts.get(key) ?? { count: 0, label: fieldText(reason, MAX_REASON_CHARS), scopes: new Set<string>() };
        if (!seen.has(key)) { entry.count += 1; seen.add(key); }
        entry.scopes.add(name);
        reasonCounts.set(key, entry);
      }
    }
  }
  const cells: RecheckCell[] = [];
  for (const [state, count] of verdictCounts) {
    if (count >= RECHECK_RECURRING) cells.push({ key: `verdict:${state}`, kind: 'verdict', label: state, state, scopes: [], count });
  }
  for (const [key, count] of sectionCounts) {
    if (count < RECHECK_RECURRING) continue;
    const [name, state] = key.split(':') as [SectionName, string];
    cells.push({ key: `section:${key}`, kind: 'section', label: name, state, scopes: [], count });
  }
  for (const [key, entry] of reasonCounts) {
    if (entry.count < RECHECK_RECURRING) continue;
    cells.push({ key: `reason:${key}`, kind: 'reason', label: entry.label, state: null, scopes: [...entry.scopes].sort(), count: entry.count });
  }
  cells.sort((a, b) =>
    b.count - a.count
    || (STATE_RANK[b.state ?? ''] ?? 0) - (STATE_RANK[a.state ?? ''] ?? 0)
    || a.key.localeCompare(b.key));
  return { cells, rows, invalidRows, outsideWindow };
}

const SECTION_LABELS: Record<SectionName, string> = {
  runtime: 'the runtime section (installed fleet version and state freshness)',
  claims: 'the claims section (the live-claim ledger)',
  bridge: 'the bridge section (the messaging bridges)',
  task: 'the task section (the work board pick)',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The evidence pointers every prompt shares; the log, the verb and the self-tick step are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is fleet/recheck-log.jsonl under the ASHLR home (~/.ashlr or $ASHLR_HOME) — one fleet.recheck-record.v1 row per self-tick apply pass (the recheck-record step) and per manual `phm fleet recheck-record` run, newest 500 kept — read newest-first with `phm fleet recheck-record --last 50 --json` or the fleet MCP recheck tool. Each row is the read-only fleet recheck\'s verdict: overall VERIFIED only when the runtime, claims, bridge and task sections all verify, else the worst section state (BLOCKED = a positively identified gap, UNKNOWN = the evidence never arrived or its reader failed), plus bounded per-section missing reasons.';

const NO_CHANGE = 'If the window has rolled forward, the verdict recovered, the gap was pinned ops machinery or owner-side state this repository cannot fix, or the failing evidence path lives outside this repo — report no-change and name the evidence.';

function cellPrompt(cell: RecheckCell, rows: number, windowDays: number): string {
  const lines: string[] = [];
  if (cell.kind === 'verdict') {
    lines.push(
      `Phantom's own fleet recheck keeps coming back ${cell.state} — ${plural(cell.count, 'recorded verdict')} inside the ${windowDays}-day window out of ${plural(rows, 'valid row')}, the self-improvement work this backlog exists for.`,
      '',
      `An overall ${cell.state} means at least one of the four verification sections — runtime, claims, bridge, task — could not verify (UNKNOWN: its evidence never arrived or its reader failed) or carries a positively identified gap (BLOCKED). The per-section cells and missing reasons in the same log say which.`,
    );
  } else if (cell.kind === 'section') {
    lines.push(
      `Phantom's own fleet recheck keeps failing to verify ${SECTION_LABELS[cell.label as SectionName] ?? `the ${cell.label} section`} — ${cell.state} on ${plural(cell.count, 'recorded row')} inside the ${windowDays}-day window out of ${plural(rows, 'valid row')}, the self-improvement work this backlog exists for.`,
      '',
      cell.state === 'BLOCKED'
        ? 'BLOCKED is a positively identified gap — the section verified far enough to name what is wrong, and the row\'s missing reasons say what.'
        : 'UNKNOWN means the section\'s evidence never arrived or its reader failed — the check cannot say whether the fleet\'s claimed state is true, which is its own kind of machinery failure.',
    );
  } else {
    const scopes = cell.scopes.length > 0 ? cell.scopes.join(', ') : 'the verdict sections';
    lines.push(
      `Phantom's own fleet recheck keeps recording the same missing reason — '${cell.label}' — on ${plural(cell.count, 'recorded row')} inside the ${windowDays}-day window out of ${plural(rows, 'valid row')}, the self-improvement work this backlog exists for.`,
      '',
      `The reason recurs under the ${scopes} section${cell.scopes.length === 1 ? '' : 's'}; digits in the recorded text are normalized so count-carrying variants group as one recurring reason.`,
    );
  }
  lines.push(
    '',
    EVIDENCE,
    '',
    `Find out why the recheck keeps reporting this: read the newest rows, trace which evidence source feeds the failing section or reason (the claims ledger, the bridge channel states, the work board, the runtime version check), and fix the cause in this repository's recheck, self-tick or evidence machinery — or the upstream feed when the reason names one this repo owns. Run the affected suite. ${NO_CHANGE}`,
  );
  return lines.join('\n');
}

function cellItem(cell: RecheckCell, repo: string, rows: number, windowDays: number): CloudBacklogItem {
  const id = `fleet-recheck-${createHash('sha256').update(`recheck:${cell.key}`).digest('hex').slice(0, 16)}`;
  let title: string;
  if (cell.kind === 'verdict') {
    title = `Fleet recheck keeps reporting an overall ${cell.state} verdict`;
  } else if (cell.kind === 'section') {
    title = `Fleet recheck keeps failing the ${cell.label} section (${cell.state})`;
  } else {
    const shown = cell.label.length > 80 ? `${cell.label.slice(0, 79)}…` : cell.label;
    title = `Fleet recheck keeps recording missing reason '${shown}'`;
  }
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, rows, windowDays),
    area: 'fleet-recheck',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the fleet recheck verdict history's recurring
 * non-clean cells. Total: a withheld or unreadable log, another
 * repository or any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function recheckBacklogItems(opts: RecheckItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const now = opts.now ?? Date.now();
    let text: string | null;
    if (opts.logText !== undefined) {
      text = opts.logText;
    } else {
      const root = opts.rootDir ?? ashlrHome();
      const read = await readSource(join(root, 'fleet', 'recheck-log.jsonl'), RECHECK_LOG_MAX_BYTES, true);
      text = read.state === 'healthy' ? read.text : null;
    }
    if (text === null) return [];
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : RECHECK_WINDOW_MS;
    const fold = foldRecheckCells(text, { nowMs: now, windowMs });
    if (fold.cells.length === 0) return [];
    const windowDays = Math.max(1, Math.round(windowMs / 86_400_000));
    const limit = Math.max(1, Math.min(opts.limit ?? RECHECK_MAX_ITEMS, RECHECK_ITEM_HARD_MAX));
    return fold.cells.slice(0, limit).map((cell) => cellItem(cell, repo, fold.rows, windowDays));
  } catch {
    return [];
  }
}
