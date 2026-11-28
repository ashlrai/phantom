/**
 * ~/.ashlr/fleet/resolution-witnesses.jsonl resolution-witness ledger →
 * self-improvement backlog items.
 *
 * The daemon's resolution observer
 * (src/core/daemon/resolution-observer-child.ts →
 * src/core/fleet/resolution-observer.ts) watches each enabled scanner's
 * 'present' observations and, when a previously flagged objective later
 * reads 'absent' with both post-state and observation digests verified,
 * records one advisory witness through recordResolutionWitness in
 * src/core/fleet/resolution-witness-ledger.ts — appending one row to
 * this append-only file under ~/.ashlr/fleet/:
 *
 *   { schemaVersion: 1, decision: 'no-change-required', repo: <abs path>,
 *     scannerId, scannerRevision, itemId, objectiveHash, observerRunId,
 *     postStateBaseDigest, observationBaseDigest,
 *     resolutionKind: 'merge-contract-satisfied', resolutionDigest,
 *     witnessAttestation, decidedAt: <canonical ISO-8601> }
 *
 * A witness is the machinery's own receipt that a scanner-flagged
 * objective resolved itself — the merge-verify-contract scanner's flagged
 * items confirming absent without fleet intervention. The ledger's own
 * header says it "deliberately has no lifecycle, proposal, verification,
 * or merge consumer": until now its only reader was
 * readResolutionWitnesses, a point-in-time inspection API nobody folds
 * into work. A scanner whose 'present' verdicts keep self-resolving
 * across days is detection noise or transient-state capture worth
 * reviewing — resolutionWitnessBacklogItems carries the ledger into
 * discoverBacklog:
 *
 *  - witness-recurring cells per (scannerId, scannerRevision): one cell
 *    per scanner build, so a scanner revision bump restarts the count
 *    and shows whether a retune actually reduced self-resolutions.
 *  - corrupt-lines cells: rows failing the writer's record contract —
 *    torn appends, foreign writers, schema drift the ledger's own
 *    reader silently skips — count once they recur inside the retained
 *    tail.
 *  - The read is the writer's own bounded tail discipline applied
 *    read-only: readLedgerTail keeps the newest bytes with the same
 *    symlink and file-type refusals every other ledger read applies; a
 *    cut first line is dropped, never guessed, and a truncated tail is
 *    stated as a lower bound in the prompt.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through the bounded tail; the
 *    writer's own reader (readResolutionWitnesses) is NOT used because
 *    it creates the private directories, takes the store lock and mints
 *    the provenance key — none of which a discovery read may do. No
 *    lock, process or network is touched here; a missing, unreadable or
 *    non-file ledger yields no items.
 *  - Rows count only under the writer's contract, re-validated field by
 *    field: schemaVersion 1, decision 'no-change-required', an absolute
 *    repo path, the scannerId/itemId/observerRunId shapes, a safe
 *    scannerRevision, sha256 digests, resolutionKind
 *    'merge-contract-satisfied' and a canonical ISO decidedAt. The
 *    resolutionDigest is recomputed with the writer's own pure
 *    resolutionWitnessDigest and must match — it binds every semantic
 *    field, so a row whose declared fields were edited after the fact
 *    fails here. witnessAttestation is an HMAC under the install's
 *    provenance key, which a read-only fold must never mint, so it is
 *    not re-verified here; attestation adjudication stays with
 *    readResolutionWitnesses, the ledger's own reader. Malformed lines
 *    and digest mismatches are counted, never guessed.
 *  - Rows dedupe the way the writer's reader dedupes: by
 *    resolutionDigest. The digest covers every semantic field (the
 *    writer's exactFingerprint excludes only decidedAt and
 *    witnessAttestation), so a repeated digest is a replay of the same
 *    observation — it counts once, at its first retained position, and
 *    never double-counts across days.
 *  - Recurring means recorded across days: a cell emits at
 *    RESOLUTION_WITNESS_MIN_ROWS adverse rows across
 *    RESOLUTION_WITNESS_MIN_DAYS distinct UTC days inside the window —
 *    the same recurrence bar the sibling fleet-evidence folds apply.
 *  - The ledger describes this install's observer and scanners — the
 *    machinery lives in this repository — so like the custody,
 *    self-tick, local-gate, delivery-receipts, comms-run and
 *    installs feeds, items emit only when the backlog's repo name is
 *    the fleet's own; another repository inherits nothing.
 *  - Witness repo values are absolute checkout paths that can embed a
 *    home directory or username: prompts quote only their basename,
 *    bounded, and itemIds/objectiveHashes/observerRunIds stay counts —
 *    never raw handles or paths.
 *  - Dedup is downstream. The item id hashes the cell identity
 *    (scannerId + scannerRevision + repository — never the counts), so
 *    a refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, and the brief names the writer, its callers and
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { resolutionWitnessDigest } from '../fleet/resolution-witness-ledger.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the cell space is scanners × revisions plus corrupt-lines. */
export const RESOLUTION_WITNESS_BACKLOG_MAX_ITEMS = 8;
const RESOLUTION_WITNESS_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const RESOLUTION_WITNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on decidedAt stamps, the sibling folds' clock-drift tolerance. */
const RESOLUTION_WITNESS_FUTURE_SKEW_MS = 60_000;
/** Witness rows a cell needs inside the window before its recurrence counts. */
export const RESOLUTION_WITNESS_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const RESOLUTION_WITNESS_MIN_DAYS = 2;
/** Contract-failing lines the corrupt cell needs inside the retained tail. */
export const RESOLUTION_WITNESS_MIN_CORRUPT = 3;
/** The fleet's own repository label: the ledger describes this install's scanners, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The ledger's own bounds, duplicated for the same closure reason the sibling folds duplicate theirs. */
const SHA256_RE = /^[a-f0-9]{64}$/;
const SCANNER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OBSERVER_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
/** Repo path bound mirrored from the writer's safeRepo. */
const MAX_REPO_CHARS = 1_024;
/**
 * Bounded tail read. The ledger caps at 16 MiB / 25k rows; witnesses are
 * rare (one per self-resolved flagged objective) so a 1 MiB window
 * holds far more than a week of rows on any realistic install, and a
 * truncated tail is stated as a lower bound rather than silently read
 * as complete.
 */
export const RESOLUTION_WITNESS_TAIL_BYTES = 1024 * 1024;

export interface ResolutionWitnessItemsOptions {
  /** Backlog target in owner/name form; the ledger describes the fleet install only. */
  repo: string;
  /** Ledger override (default: join(homeDir, '.ashlr', 'fleet', 'resolution-witnesses.jsonl')). */
  ledgerPath?: string;
  /** Home for the ledger default; mirrors resolutionWitnessLedgerPath's homedir() base. */
  homeDir?: string;
  /** Most items one call emits (default RESOLUTION_WITNESS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated ledger row, reduced to what the fold counts and quotes. */
export interface ResolutionWitnessRow {
  scannerId: string;
  scannerRevision: number;
  /** Basename of the witnessed repo's absolute path — never the full path (it can embed a home dir). */
  repoName: string;
  /** Distinct-objective identity (objectiveHash), counted never quoted. */
  objectiveHash: string;
  /** Window position. */
  atMs: number;
  utcDay: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const noControlCharacters = (value: string): boolean =>
  ![...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

/**
 * Pure: validate one parsed ledger line against the writer's record
 * contract — recordResolutionWitnesses emits the fixed ResolutionWitness
 * schema: schemaVersion 1, decision 'no-change-required', an absolute
 * bounded repo path, the scannerId/itemId/observerRunId shapes, a safe
 * scannerRevision ≥ 1, sha256 digests, resolutionKind
 * 'merge-contract-satisfied' and a canonical ISO decidedAt. The
 * resolutionDigest must recompute under the writer's own pure
 * resolutionWitnessDigest — it binds every semantic field, so a row
 * whose declared fields were edited after the fact fails here. Extra
 * fields are ignored for forward compatibility; witnessAttestation is
 * deliberately not re-verified (its HMAC key is never minted by a
 * read-only fold — see the module header). Anything else is not a
 * ledger row.
 */
export function parseResolutionWitnessJournalEntry(value: unknown): ResolutionWitnessRow | null {
  if (!isRecord(value)) return null;
  if (value['schemaVersion'] !== undefined && value['schemaVersion'] !== 1) return null;
  if (value['decision'] !== undefined && value['decision'] !== 'no-change-required') return null;
  const repo = value['repo'];
  if (typeof repo !== 'string' || repo.length < 1 || repo.length > MAX_REPO_CHARS || !noControlCharacters(repo)) return null;
  let repoCanonical: string;
  try {
    repoCanonical = resolve(repo);
  } catch {
    return null;
  }
  if (!isAbsolute(repoCanonical) || repoCanonical.length > MAX_REPO_CHARS) return null;
  const scannerId = value['scannerId'];
  if (typeof scannerId !== 'string' || !SCANNER_ID_RE.test(scannerId)) return null;
  const scannerRevision = value['scannerRevision'];
  if (!Number.isSafeInteger(scannerRevision) || Number(scannerRevision) < 1) return null;
  const itemId = value['itemId'];
  if (typeof itemId !== 'string' || itemId.length < 1 || itemId.length > 240 || !noControlCharacters(itemId)) return null;
  const objectiveHash = value['objectiveHash'];
  if (typeof objectiveHash !== 'string' || !SHA256_RE.test(objectiveHash)) return null;
  const observerRunId = value['observerRunId'];
  if (typeof observerRunId !== 'string' || !OBSERVER_RUN_ID_RE.test(observerRunId)) return null;
  for (const key of ['postStateBaseDigest', 'observationBaseDigest'] as const) {
    const digest = value[key];
    if (typeof digest !== 'string' || !SHA256_RE.test(digest)) return null;
  }
  if (value['resolutionKind'] !== 'merge-contract-satisfied') return null;
  if (!canonicalTimestamp(value['decidedAt'])) return null;
  const resolutionDigest = value['resolutionDigest'];
  if (typeof resolutionDigest !== 'string' || !SHA256_RE.test(resolutionDigest)) return null;
  const expected = resolutionWitnessDigest({
    decision: 'no-change-required',
    repo: repoCanonical,
    scannerId,
    scannerRevision: scannerRevision as number,
    itemId,
    objectiveHash,
    observerRunId,
    postStateBaseDigest: value['postStateBaseDigest'] as string,
    observationBaseDigest: value['observationBaseDigest'] as string,
    resolutionKind: 'merge-contract-satisfied',
  });
  if (resolutionDigest !== expected) return null;
  const atMs = Date.parse(value['decidedAt'] as string);
  return {
    scannerId,
    scannerRevision: scannerRevision as number,
    repoName: basename(repoCanonical),
    objectiveHash,
    atMs,
    utcDay: utcDayOf(atMs),
  };
}

/**
 * Pure: parse one ledger file's text into deduped validated rows plus
 * the count of lines that were not on-contract records — malformed JSON
 * and off-contract rows (including resolutionDigest mismatches) are
 * counted, never guessed. Dedup mirrors the writer's own reader: the
 * first row per resolutionDigest wins; the digest covers every semantic
 * field, so a repeat is a replay of the same observation and counts
 * once — replays are tallied for context, never as signal.
 */
export function parseResolutionWitnessJournal(text: string): {
  rows: ResolutionWitnessRow[];
  invalidRows: number;
  replayedRows: number;
} {
  const byDigest = new Map<string, ResolutionWitnessRow>();
  let invalidRows = 0;
  let replayedRows = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseResolutionWitnessJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    const digest = isRecord(value) && typeof value['resolutionDigest'] === 'string'
      ? value['resolutionDigest']
      : '';
    if (byDigest.has(digest)) { replayedRows += 1; continue; }
    byDigest.set(digest, row);
  }
  return { rows: [...byDigest.values()], invalidRows, replayedRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the ledger tail
// ---------------------------------------------------------------------------

export interface ResolutionWitnessFold {
  /** In-window on-contract rows — the share/context denominator. */
  rows: number;
  /** In-window rows grouped per (scannerId, scannerRevision) cell. */
  cells: Map<string, {
    scannerId: string;
    scannerRevision: number;
    rows: number;
    days: Set<string>;
    objectives: Set<string>;
    repos: Set<string>;
    firstMs: number;
    lastMs: number;
  }>;
  /** On-contract rows outside the window. */
  outsideWindow: number;
  /** Non-blank lines the writer's contract rejected. */
  invalidRows: number;
  /** Same-digest replay rows collapsed by dedup — context only. */
  replayedRows: number;
}

/**
 * Pure: fold ledger text into the witness evidence. Only decidedAt rows
 * inside the window join cells; cell keys are scannerId + scannerRevision
 * so a scanner retune restarts the recurrence count on its own build.
 */
export function foldResolutionWitnessRows(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): ResolutionWitnessFold {
  const parsed = parseResolutionWitnessJournal(text);
  const fold: ResolutionWitnessFold = {
    rows: 0, cells: new Map(), outsideWindow: 0,
    invalidRows: parsed.invalidRows, replayedRows: parsed.replayedRows,
  };
  const windowMs = opts.windowMs ?? RESOLUTION_WITNESS_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + RESOLUTION_WITNESS_FUTURE_SKEW_MS;

  for (const row of parsed.rows) {
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    fold.rows += 1;
    const key = `${row.scannerId} ${row.scannerRevision}`;
    let cell = fold.cells.get(key);
    if (cell === undefined) {
      cell = {
        scannerId: row.scannerId, scannerRevision: row.scannerRevision,
        rows: 0, days: new Set(), objectives: new Set(), repos: new Set(),
        firstMs: row.atMs, lastMs: row.atMs,
      };
      fold.cells.set(key, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.objectives.add(row.objectiveHash);
    cell.repos.add(row.repoName);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface ResolutionWitnessCell {
  scannerId: string;
  scannerRevision: number;
  /** In-window witness rows. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** Distinct objectives the witnesses cover. */
  objectives: number;
  /** Distinct repo basenames the witnesses cover (bounded quote). */
  repos: string[];
  /** In-window on-contract rows overall — the context denominator. */
  records: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

const isoOrNull = (ms: number): string | null => new Date(ms).toISOString();

/**
 * Pure: recurring cells — a (scannerId, scannerRevision) cell emits at
 * the row and day bars. Sorted by rows desc, then scannerId/revision for
 * a stable order.
 */
export function resolutionWitnessCells(fold: ResolutionWitnessFold, lowerBound = false): ResolutionWitnessCell[] {
  const cells: ResolutionWitnessCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < RESOLUTION_WITNESS_MIN_ROWS) continue;
    if (cell.days.size < RESOLUTION_WITNESS_MIN_DAYS) continue;
    cells.push({
      scannerId: cell.scannerId,
      scannerRevision: cell.scannerRevision,
      rows: cell.rows,
      days: [...cell.days].sort(),
      objectives: cell.objectives.size,
      repos: [...cell.repos].sort().slice(0, 4),
      records: fold.rows,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) =>
    b.rows - a.rows || a.scannerId.localeCompare(b.scannerId) || a.scannerRevision - b.scannerRevision);
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/fleet/resolution-witnesses.jsonl — resolutionWitnessLedgerPath in src/core/fleet/resolution-witness-ledger.ts resolves it under the install home. recordResolutionWitness appends one ResolutionWitness row per objective the daemon\'s resolution observer (src/core/daemon/resolution-observer-child.ts → src/core/fleet/resolution-observer.ts) watched a scanner flag \'present\' and later confirm \'absent\' with verified post-state and observation digests — decision \'no-change-required\', resolutionKind \'merge-contract-satisfied\'. The ledger deliberately has no lifecycle, proposal, verification or merge consumer: until this feed its only reader was readResolutionWitnesses, a point-in-time inspection API that creates the private directories, takes the store lock and mints the provenance key — none of which a read-only discovery fold may do, so this fold re-validates the writer\'s record contract field by field and recomputes resolutionDigest with the writer\'s own pure resolutionWitnessDigest; witnessAttestation stays unverified here and same-digest rows dedupe as replays exactly as the writer\'s reader treats them.';

const REPRO = 'Reproduce the fold by reading ~/.ashlr/fleet/resolution-witnesses.jsonl directly, keeping on-contract rows ({schemaVersion 1, decision \'no-change-required\', absolute repo, scannerId/itemId/observerRunId shapes, safe scannerRevision, sha256 digests, resolutionKind \'merge-contract-satisfied\', canonical ISO decidedAt, resolutionDigest recomputed under resolutionWitnessDigest}) deduped by resolutionDigest, whose decidedAt lands inside the window, grouped by (scannerId, scannerRevision) across distinct UTC days, and treating lines failing the contract as counted invalid evidence. The writer and its observer are src/core/fleet/resolution-witness-ledger.ts and src/core/fleet/resolution-observer.ts.';

const NO_CHANGE = 'If the window has rolled forward, the witnesses record objectives that were genuinely fixed between observations (the machinery working as designed), the scanner revision that produced them is already superseded on the default branch, or this checkout is not the fleet install the ledger describes — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: ResolutionWitnessCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: ResolutionWitnessCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const reposText = (cell: ResolutionWitnessCell): string =>
  cell.repos.length === 0 ? '' : ` across checkout(s) ${cell.repos.join(', ')}`;

const WINDOW_DAYS = Math.round(RESOLUTION_WITNESS_WINDOW_MS / 86_400_000);

function resolutionWitnessItem(cell: ResolutionWitnessCell, repo: string): CloudBacklogItem {
  const id = `resolution-witness-${cell.scannerId}-r${cell.scannerRevision}-${createHash('sha256').update(`resolution-witness:${repo.trim().toLowerCase()}:${cell.scannerId}:${cell.scannerRevision}`).digest('hex').slice(0, 16)}`;
  const prompt = [
    `Phantom's resolution-witness ledger keeps recording self-resolved scanner flags — ${cell.rows} witness(es) for scanner '${cell.scannerId}' revision ${cell.scannerRevision}${reposText(cell)} across ${cell.objectives} distinct objective(s) and ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each witness is one objective the scanner flagged 'present' that later read 'absent' with verified digests and needed no fleet intervention — the observer recorded decision 'no-change-required' / resolutionKind 'merge-contract-satisfied'. A scanner whose positive verdicts keep self-resolving at this rate is either capturing transient states its 'present' detection should not flag, or its detection criteria are loose enough to produce findings that resolve on their own — either way the flag stream is noise the fleet pays to observe.${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why scanner '${cell.scannerId}' revision ${cell.scannerRevision} keeps producing 'present' observations that self-resolve into merge-contract-satisfied witnesses: read the scanner's detection criteria and the resolution observer's present→absent transition (src/core/fleet/resolution-observer.ts and the scanner it wraps), and determine whether the flagged states are genuinely transient (observation windows, ordering, or digest bases that flip without a real fix) or whether the scanner's 'present' verdict is too eager. If a scanner revision already superseded this build on the default branch, say so rather than re-litigating the old criteria. The scanner machinery is this repository's own; owner channels and approvals stay untouched.`,
    '',
    `If the window has rolled forward, the witnesses record objectives that were genuinely fixed between observations (the machinery working as designed), the scanner revision that produced them is already superseded on the default branch, or this checkout is not the fleet install the ledger describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: `Resolution witnesses: scanner '${cell.scannerId}' r${cell.scannerRevision} keeps self-resolving`.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `resolution-witness-${cell.scannerId}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function resolutionWitnessCorruptItem(invalidRows: number, repo: string): CloudBacklogItem {
  const id = `resolution-witness-corrupt-${createHash('sha256').update(`resolution-witness-corrupt:${repo.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`;
  const prompt = [
    `Phantom's resolution-witness ledger keeps accumulating rows its own reader cannot trust — ${invalidRows} line(s) failing the writer's record contract inside the retained tail, the self-improvement work this backlog exists for.`,
    '',
    `Every witness row is supposed to be written by recordResolutionWitness under the fixed ResolutionWitness schema with a recomputed resolutionDigest; lines that fail that contract — malformed JSON, off-contract fields, digest mismatches — mean torn appends, a foreign writer, or schema drift the ledger's reader (readResolutionWitnesses) silently skips while reporting the ledger degraded. Recurring contract failures mean the evidence stream itself is degrading.`,
    '',
    EVIDENCE,
    '',
    `Find what keeps writing contract-failing rows to ~/.ashlr/fleet/resolution-witnesses.jsonl: check for torn appends (the writer appends with O_APPEND under a store lock — a crash mid-write leaves a partial last line the reader counts invalid), foreign or hand edits, and schema drift between the writer's ResolutionWitness shape and what readers validate. If the failures are a single torn tail line from one crash, report no-change — the next clean append supersedes it. The ledger machinery is this repository's own.`,
    '',
    `If the window has rolled forward, the retained tail now parses clean, the corrupt rows were a one-off torn append already superseded, or this checkout is not the fleet install the ledger describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: 'Resolution witnesses: ledger rows keep failing the writer contract'.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'resolution-witness-corrupt',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the resolution-witness ledger's recurring
 * self-resolved scanner flags and contract failures, worst cell first.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function resolutionWitnessBacklogItems(opts: ResolutionWitnessItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || (repo.split('/').pop() ?? repo).trim().toLowerCase() !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const ledgerPath = opts.ledgerPath ?? join(home, '.ashlr', 'fleet', 'resolution-witnesses.jsonl');
    const read = await readLedgerTail(ledgerPath, RESOLUTION_WITNESS_TAIL_BYTES);
    // Healthy-only evidence bar: a missing, unreadable or non-file ledger
    // is unknown, never a guessed tally — the same rule the sibling
    // sources apply to their own degraded corpora.
    if (read.state !== 'read' || read.text.trim() === '') return [];
    const fold = foldResolutionWitnessRows(read.text, { nowMs: (opts.now ?? new Date()).getTime() });
    if (fold.rows === 0 && fold.invalidRows < RESOLUTION_WITNESS_MIN_CORRUPT) return [];
    const lowerBound = read.truncated;
    const limit = Math.max(1, Math.min(opts.limit ?? RESOLUTION_WITNESS_BACKLOG_MAX_ITEMS, RESOLUTION_WITNESS_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const cell of resolutionWitnessCells(fold, lowerBound)) {
      if (items.length >= limit) break;
      items.push(resolutionWitnessItem(cell, repo));
    }
    if (fold.invalidRows >= RESOLUTION_WITNESS_MIN_CORRUPT && items.length < limit) {
      items.push(resolutionWitnessCorruptItem(fold.invalidRows, repo));
    }
    return items;
  } catch {
    return [];
  }
}
