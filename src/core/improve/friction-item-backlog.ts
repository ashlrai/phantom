/**
 * Friction-ledger seam → self-improvement backlog items.
 *
 * ~/.ashlr/friction-ledger.jsonl is the friction-ledger seam
 * (src/core/fleet/friction-ledger.ts): upsertFrictionItems merges
 * writer-supplied FrictionInput rows — today absorbNoopChurn folding
 * queue/noop-streak.json DONE-NOOP streaks into 'noop-streak:<job>'
 * items on every collectFrictionTop read (`phm select` non-dry passes
 * and `phm fleet planner-brief`) — last row per id wins, closed items
 * never reopen, and the file is rewritten atomically from already
 * validated items. The only close path is the pick grader's 7d signal:
 * runPickGrader (reached through syncPickGrades inside `phm select`)
 * closes an item only when a pick carrying its friction_id grades
 * realized >= 0.5 at the 7-day window.
 *
 * Until now the ledger's only readers were those same selection
 * surfaces — `phm select`'s friction top and the planner brief's
 * frictionTop — current friction ranking for a human or planner pass,
 * never a trend. So friction that stays open for weeks, items no
 * funded pick ever links (the grader's close path can never reach
 * them), and ledger-integrity failures produced no autonomous work.
 * frictionItemBacklogItems carries the same bounded read into
 * discoverBacklog.
 *
 * Three evidence axes, all anchored to the writer's own contract —
 * readFrictionLedger enforces FRICTION_MAX_BYTES, parses every line
 * and validates each row as a FrictionItem, so the fold sees only
 * records the contract admits plus its rejected count:
 *   - persisted open items: per-source cells of items whose openedAt
 *     is at least FRICTION_ITEM_STALE_MS old — the grader's own 7-day
 *     close horizon. An item still open past it either records drag
 *     the fleet never fixed or an item no funded pick can close;
 *     both are work, and the prompt names both hypotheses.
 *   - ledger oversize: the file exceeds FRICTION_MAX_BYTES, which
 *     readFrictionLedger answers with zero items — every reader
 *     (`phm select`, the planner brief, the grader's closes) sees an
 *     empty ledger while the bytes sit on disk. The writer bounds
 *     rows by count (FRICTION_MAX_ITEMS) but never by bytes, so a
 *     full ledger of long fields can outgrow its own read bound.
 *   - rejected rows: within-bound files still reporting rejected > 0
 *     carry lines the validated reader refused. writeLedger only
 *     ever rewrites the whole file from parsed items, so refused
 *     rows cannot come from the writer — they mean an external
 *     append, a torn write or on-disk corruption.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through readFrictionLedger —
 *    the seam's own bounded validated reader — plus one statSync for
 *    the oversize verdict the reader folds into its rejected
 *    sentinel. Nothing is written and no process is inspected.
 *  - Missing or unreadable evidence yields no items. A missing ledger
 *     is the seam's normal state before the first absorbed streak —
 *     a clean first run — and contributes nothing rather than an
 *     error.
 *  - Items emit only for the fleet's own repository: the ledger is
 *     this install's friction seam and describes this install's
 *     machinery; the backlog target gate is the same last-segment
 *     'phantom' rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Every id is a stable string keyed on the
 *     cell identity (source name, or the integrity axis), so a
 *     refresh re-derives the same ids and appendUserBacklogItems
 *     adds only what is new; shifted tallies do not spawn twin items
 *     and a quiet window stops re-adding.
 *  - Quoted fields are the writer's own bounded shapes: item titles
 *     are already control-stripped and capped at 160 chars by
 *     parseItem, and this fold flattens whitespace, caps examples and
 *     never quotes detail text (free-form evidence prose).
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  FRICTION_MAX_BYTES,
  frictionLedgerPath,
  readFrictionLedger,
  type FrictionItem,
} from '../fleet/friction-ledger.js';

/** Items one call may emit; per-source cells are bounded by writer-supplied source diversity. */
export const FRICTION_ITEM_MAX_ITEMS = 10;
const FRICTION_ITEM_HARD_MAX = 25;
/**
 * An open item counts as persisted at this age — the pick grader's own
 * 7-day close horizon (GRADE_WINDOWS['7d'] in pick-grader.ts). Younger
 * open items are friction the grading window has not finished judging.
 */
export const FRICTION_ITEM_STALE_MS = 7 * 24 * 3_600_000;
/** Example item titles quoted per cell inside one prompt. */
const MAX_EXAMPLE_ITEMS = 5;
/** Per-title quote cap inside a prompt (the writer already caps titles at 160). */
const MAX_EXAMPLE_TITLE_CHARS = 120;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: friction-seam evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface FrictionItemBacklogItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** OS home the default ledger path resolves under (default: os.homedir()); the seam ignores ASHLR_HOME. */
  homeDir?: string;
  /** Ledger path override (default: frictionLedgerPath(homeDir) — ~/.ashlr/friction-ledger.jsonl). */
  ledgerPath?: string;
  /** Age in ms an open item must reach before it counts as persisted (default FRICTION_ITEM_STALE_MS). */
  staleMs?: number;
  /** Most items one call emits (default FRICTION_ITEM_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring item ages (default: now). */
  now?: Date;
}

/** One persisted-open cell: the open items one writer source has kept past the grading horizon. */
export interface FrictionItemCell {
  /** The writer-supplied source label ('noop-streak', a FRICTION-2 writer tag, ...). */
  source: string;
  /** Open items from this source aged at least staleMs — the persisted count. */
  stale: number;
  /** All currently open items from this source, persisted or not. */
  open: number;
  /** Highest recorded score across the source's open items. */
  maxScore: number;
  /** ISO bounds of the stale items' openedAt stamps; null when none parsed (the contract requires parseable stamps, so normally set). */
  oldestOpenedAt: string | null;
  newestOpenedAt: string | null;
  /** Up to three distinct repo labels the open items carry. */
  repos: string[];
  /** Up to MAX_EXAMPLE_ITEMS prompt-safe item titles. */
  examples: string[];
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

// eslint-disable-next-line no-control-regex -- ledger text stays one printable token per cell key.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * The writer length-checks `source` but never strips it, so a corrupt or
 * hand-written row could carry control characters into titles and prompts.
 * Flatten to one printable token, capped at the writer's own 64-char bound;
 * a source that flattens to nothing keys as '(blank)' rather than vanishing.
 */
function flattenSource(source: string): string {
  const flat = source.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return flat === '' ? '(blank)' : flat;
}

function flattenTitle(title: string): string {
  return title.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_EXAMPLE_TITLE_CHARS);
}

/**
 * Pure: fold validated FrictionItem rows into per-source persisted-open
 * cells. Only status 'open' items count — a closed item is resolved
 * evidence, not drag. `stale` requires openedAt at least staleMs old;
 * items whose stamp cannot be placed (the writer's contract makes this
 * unreachable, but a hand-built row could) never count as stale and
 * still count toward `open`.
 */
export function foldFrictionItemCells(
  items: readonly FrictionItem[],
  nowMs: number,
  staleMs: number,
): FrictionItemCell[] {
  const cells = new Map<string, {
    source: string;
    stale: number;
    open: number;
    maxScore: number;
    oldestMs: number | null;
    newestMs: number | null;
    repos: Set<string>;
    examples: string[];
  }>();
  for (const item of items) {
    if (item.status !== 'open') continue;
    const source = flattenSource(item.source);
    const openedMs = Date.parse(item.openedAt);
    const stale = Number.isFinite(openedMs) && nowMs - openedMs >= staleMs;
    let cell = cells.get(source);
    if (cell === undefined) {
      cell = { source, stale: 0, open: 0, maxScore: 0,
        oldestMs: null, newestMs: null, repos: new Set(), examples: [] };
      cells.set(source, cell);
    }
    cell.open += 1;
    cell.maxScore = Math.max(cell.maxScore, item.score);
    if (item.repo !== '') cell.repos.add(item.repo);
    if (cell.examples.length < MAX_EXAMPLE_ITEMS) {
      const title = flattenTitle(item.title);
      if (title !== '' && !cell.examples.includes(title)) cell.examples.push(title);
    }
    if (!stale || !Number.isFinite(openedMs)) continue;
    cell.stale += 1;
    cell.oldestMs = cell.oldestMs === null ? openedMs : Math.min(cell.oldestMs, openedMs);
    cell.newestMs = cell.newestMs === null ? openedMs : Math.max(cell.newestMs, openedMs);
  }
  return [...cells.values()]
    .filter((cell) => cell.stale > 0)
    .map((cell) => ({
      source: cell.source,
      stale: cell.stale,
      open: cell.open,
      maxScore: cell.maxScore,
      oldestOpenedAt: cell.oldestMs === null ? null : new Date(cell.oldestMs).toISOString(),
      newestOpenedAt: cell.newestMs === null ? null : new Date(cell.newestMs).toISOString(),
      repos: [...cell.repos].slice(0, 3),
      examples: cell.examples,
    }))
    .sort((a, b) => b.stale - a.stale
      || (a.oldestOpenedAt ?? '').localeCompare(b.oldestOpenedAt ?? '')
      || a.source.localeCompare(b.source));
}

const NO_CHANGE = 'If the window has rolled forward, the items closed or stopped re-absorbing, the recorded friction traces to deliberate operator state or an owner-only cause — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the seam contract and the folding commands are named so the session can reproduce the read. */
const EVIDENCE = 'The evidence is friction-ledger.jsonl under the Phantom state directory (~/.ashlr — frictionLedgerPath in src/core/fleet/friction-ledger.ts resolves homedir()/.ashlr and ignores ASHLR_HOME): FrictionItem rows {id, title, detail, score, repo, source, status, openedAt, closedAt?, closeReason?} appended by upsertFrictionItems — today only absorbNoopChurn folds queue/noop-streak.json DONE-NOOP streaks into \'noop-streak:<job>\' items, on collectFrictionTop reads inside `phm select` non-dry passes and `phm fleet planner-brief`. readFrictionLedger is the seam\'s own bounded validated reader (FRICTION_MAX_BYTES cap, last row per id wins, closed items never reopen); the only close path is runPickGrader\'s 7d grade >= 0.5 on a pick carrying the item\'s friction_id, inside `phm select`\'s syncPickGrades pass.';

function seenText(cell: FrictionItemCell): string {
  if (cell.oldestOpenedAt === null || cell.newestOpenedAt === null) return '';
  return cell.oldestOpenedAt === cell.newestOpenedAt
    ? ` Oldest persisted item opened ${cell.oldestOpenedAt}.`
    : ` Persisted items opened ${cell.oldestOpenedAt} through ${cell.newestOpenedAt}.`;
}

function reposText(cell: FrictionItemCell): string {
  return cell.repos.length === 0 ? '' : ` Recorded repos: ${cell.repos.join(', ')}.`;
}

function examplesText(cell: FrictionItemCell): string {
  return cell.examples.length === 0 ? '' : ` Example items: ${cell.examples.map((t) => `"${t}"`).join('; ')}.`;
}

function stalePrompt(cell: FrictionItemCell): string {
  return [
    `Phantom's friction ledger keeps ${cell.stale} open item(s) from source '${cell.source}' past the 7-day grading horizon — the self-improvement work this backlog exists for.`,
    '',
    `Each row is the seam's own recorded friction: ${cell.stale} of this source's ${cell.open} currently open item(s) have been open at least seven days — longer than the window the pick grader's 7d grade gets to close them. An item still open past that horizon either records drag the fleet never fixed, or one no funded pick ever linked so the grader's close path cannot reach it.${seenText(cell)}${reposText(cell)}${examplesText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which side owns the cause: whether the recorded friction still reproduces — the machinery or queue path producing it lives in this repository (the noop-streak producer is the queue restocker's DONE-NOOP retirement and park cycle; other sources name their own writer tag) — whether the items lack funded picks carrying their friction_id so grading can never close them (the selector pick/friction link in this repository's pick path), or whether \`phm select\` passes have stopped running so absorption and grading both stalled. Fix what lives here; if the friction resolved without a close, the items' premises are stale, or the cause is owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function oversizePrompt(byteSize: number): string {
  return [
    `Phantom's friction ledger is ${byteSize} bytes — past the seam's own ${FRICTION_MAX_BYTES}-byte read bound — so every reader sees an empty ledger — the self-improvement work this backlog exists for.`,
    '',
    `readFrictionLedger (src/core/fleet/friction-ledger.ts) refuses any file larger than FRICTION_MAX_BYTES outright, returning zero items — while writeLedger bounds its output by row count (FRICTION_MAX_ITEMS) but never by bytes, so a full ledger of long titles and details can produce a file its own reader refuses. While oversized, \`phm select\`'s friction top, \`phm fleet planner-brief\`'s frictionTop and the pick grader's 7d closes all read an empty ledger: recorded friction is invisible and open items can never close.`,
    '',
    EVIDENCE,
    '',
    `Find which side owns the cause: whether writeLedger should bound its emitted bytes (not just row count) so it can never produce a file its own reader refuses, whether FRICTION_MAX_BYTES is stale against the row cap and field bounds, or whether the file grew through rows the writer never intended. Fix what lives here in src/core/fleet/friction-ledger.ts and its callers' assumptions. If the file is within bound now or grew through an authorized path — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function rejectedPrompt(rejected: number, items: number): string {
  return [
    `Phantom's friction ledger carried ${rejected} row(s) the validated reader refused on the last read — the self-improvement work this backlog exists for.`,
    '',
    `readFrictionLedger parses each line as JSON and validates it as a FrictionItem (id shape, bounded title/detail, finite score, open|closed status, parseable openedAt); refused rows are counted as rejected and dropped, and ${items} item(s) still parsed. The writer only ever rewrites the whole file atomically from already-validated items, so refused rows cannot come from writeLedger — they mean an external append, a torn write or on-disk corruption.`,
    '',
    EVIDENCE,
    '',
    `Find which side owns the cause: whether a second writer or a manual edit appended outside writeLedger's contract, whether the file was corrupted, or whether parseItem's contract drifted from what a legitimate producer now emits (the row shape lives only in this repository — a producer writing a field the validator rejects is a bug here). Fix what lives here; if the refused rows were transient and the ledger now reads clean — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function frictionItem(entry: {
  id: string; title: string; prompt: string;
}): CloudBacklogItem {
  return { id: entry.id, title: entry.title.slice(0, MAX_TITLE_CHARS), prompt: entry.prompt, area: 'friction-items', priority: 3 };
}

function itemId(key: string): string {
  return `fleet-friction-items-${createHash('sha256').update(`friction-items:${key}`).digest('hex').slice(0, 16)}`;
}

/**
 * Backlog items for the friction-ledger seam's persisted-open cells and
 * integrity failures. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function frictionItemBacklogItems(opts: FrictionItemBacklogItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const ledgerPath = opts.ledgerPath ?? frictionLedgerPath(home);
    // The oversize verdict the reader folds into its rejected sentinel:
    // stat once so a >FRICTION_MAX_BYTES file reports as oversize, never
    // as "one rejected row". A stat failure means the reader's own empty
    // result stands and no integrity cell can be proven.
    let byteSize: number | null = null;
    try { byteSize = statSync(ledgerPath).size; } catch { byteSize = null; }
    const { items, rejected } = readFrictionLedger(ledgerPath);
    const nowMs = (opts.now ?? new Date()).getTime();
    const staleMs = opts.staleMs ?? FRICTION_ITEM_STALE_MS;
    const cells = foldFrictionItemCells(items, nowMs, staleMs);
    const limit = Math.max(1, Math.min(opts.limit ?? FRICTION_ITEM_MAX_ITEMS, FRICTION_ITEM_HARD_MAX));
    const out: CloudBacklogItem[] = [];
    const withRepo = (item: CloudBacklogItem): CloudBacklogItem =>
      CLOUD_REPO_PATTERN.test(repo) ? { ...item, repo } : item;
    if (byteSize !== null && byteSize > FRICTION_MAX_BYTES) {
      out.push(withRepo(frictionItem({
        id: itemId('oversize'),
        title: `Friction ledger exceeds its own read bound — every reader sees an empty ledger`,
        prompt: oversizePrompt(byteSize),
      })));
    } else if (rejected > 0) {
      out.push(withRepo(frictionItem({
        id: itemId('rejected'),
        title: `Friction ledger carries rows the validated reader refuses`,
        prompt: rejectedPrompt(rejected, items.length),
      })));
    }
    for (const cell of cells.slice(0, Math.max(0, limit - out.length))) {
      out.push(withRepo(frictionItem({
        id: itemId(`stale:${cell.source}`),
        title: `Friction items from '${cell.source}' stay open past the 7-day grading horizon`,
        prompt: stalePrompt(cell),
      })));
    }
    return out;
  } catch {
    return [];
  }
}
