/**
 * Desktop change-request journal → self-improvement backlog items.
 *
 * The console's "Improve this screen" action has two arms: "Just flag it"
 * posts a friction flag (feedback.jsonl, folded by friction-flag-backlog.ts)
 * and typing a request posts to /api/verse/change-request, where
 * submitChangeRequest (src/core/verse/change-request.ts) screens the text
 * through triageFeedback, mints a deterministic UIREQ<12hex> id from the
 * normalized description+surface, writes an RQ-PHX-UIREQ<hash> drop job and
 * appends one status row — {v:1, id, jobId, surface, createdAt,
 * status:'queued'} — to change-requests.jsonl beside the flag journal
 * (changeRequestStatusPath() resolves it inside frictionFeedbackDir(),
 * ~/.ashrl/router, homedir()-relative and deliberately not $ASHLR_HOME).
 *
 * A queued row is only the intake receipt. What happens next lives in two
 * bounded joins the verse API already computes for its newest-20 display
 * (listChangeRequests): readDropJobFates folds leader/drop/ingested.tsv and
 * the done/ filename suffixes into 'ingested' | 'rejected' fates (a rejected
 * request never became a job at all — invisible to every jobs.jsonl feeder),
 * and readRequestPrs resolves each jobId's phantom PR url and state
 * (open | merged | closed) from the jobs-ledger tail and .publish receipts.
 * Until now that joined view was only ever rendered to a human on the
 * change-requests pane — a point-in-time answer, never a trend — so a
 * surface whose requests kept dying at ingest or whose PRs kept closing
 * unmerged produced no work item.
 *
 * changeRequestsBacklogItems carries the same journal and the same two
 * joins into discoverBacklog. It reads the status journal itself through
 * readLedgerTail's bounded no-follow tail (so malformed lines are counted,
 * not silently skipped the way the API's reader drops them), validates
 * every row against validStatusRow's contract, then folds fates and PR
 * states onto the rows exactly the way listChangeRequests does — the
 * backlog classifies requests the way the operator-facing pane does,
 * never a second opinion.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal, the drop-fate sources and the jobs-ledger
 *    tail are read through their bounded readers; nothing is written and
 *    no lock, process or network is touched. A missing or unreadable
 *    journal yields no items — unknown stays unknown — and a truncated
 *    tail folds the retained rows with the prompts stating the counts as
 *    lower bounds.
 *  - Rows count only under the writer's contract: v===1, the
 *    UIREQ[A-F0-9]{12} id shape, jobId exactly 'RQ-PHX-<id>', a surface
 *    inside the writer's /^[a-z][a-z0-9-]{0,63}$/ bound, a parseable
 *    createdAt and status 'queued' — the only status the writer emits.
 *    Malformed lines are counted, never guessed.
 *  - Requests do not expire: like the flag journal this is a durable
 *    intake queue with no TTL, so the fold covers every retained row.
 *    The fate and PR joins are count-bounded (the newest drop-job fates,
 *    a 2 MiB jobs-ledger tail, 64 KiB publish receipts), so an older
 *    request whose evidence aged out classifies 'unknown' — counted as
 *    coverage, never as a failure it cannot prove.
 *  - Recurrence is required: an adverse class emits only at
 *    CHANGE_REQUEST_MIN_CELL distinct request ids on one surface inside
 *    the retained journal — the same bar the machine-telemetry feeds
 *    apply, because a single rejected or closed-unmerged request can be
 *    a correct one-off verdict. Requests dedupe by content hash upstream,
 *    so distinct ids are distinct asks, not retries of one.
 *  - The evidence is this install's console journal and fleet runs
 *    directory: rows describe requests filed against this machine's
 *    Phantom console and carry no owner dimension beyond the fixed
 *    repo:'phantom' job literal, so items emit only when the backlog
 *    target's repository name is 'phantom' — the same last-segment rule
 *    the sibling fleet-evidence sources apply.
 *  - Every journal string is untrusted text or an opaque hash: surface
 *    names are pattern-bounded but still scrubbed and capped, request
 *    ids are sha256 prefixes that reveal nothing about the description,
 *    done-file rejection reasons are free text and are counted but never
 *    quoted, and cell identity hashes the raw surface+class so journal
 *    text never becomes an identifier.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readDropJobFates, type DropJobFate } from '../fleet/drop-job-fate.js';
import { resolveDropJobRoot } from '../fleet/drop-job-writer.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubPrivateText } from '../util/scrub.js';
import { changeRequestStatusPath, readRequestPrs, type ChangeRequestPr } from '../verse/change-request.js';

/** Items one call may emit; the cap bounds the open-ended surface×class set. */
export const CHANGE_REQUEST_BACKLOG_MAX_ITEMS = 10;
const CHANGE_REQUEST_ITEM_HARD_MAX = 25;
/**
 * Bounded tail of the single status journal. The writer appends one
 * ~150-byte row per accepted request and never rotates; requests are
 * rare deliberate human actions, so 4 MiB reads every realistic file
 * whole and `truncated` then means the file broke that bound.
 */
export const CHANGE_REQUEST_TAIL_BYTES = 4 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The writer's contract bounds: id UIREQ[A-F0-9]{12}, surface /^[a-z][a-z0-9-]{0,63}$/. */
const REQUEST_ID_RE = /^UIREQ[A-F0-9]{12}$/;
const SURFACE_RE = /^[a-z][a-z0-9-]{0,63}$/;
/** Distinct request ids one (surface, class) cell needs before it emits. */
export const CHANGE_REQUEST_MIN_CELL = 2;
/** The fleet's own repository label: request evidence is this install's console, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Example request ids quoted inside one prompt before the rest is summarized. */
const PROMPT_SAMPLES_MAX = 6;

export interface ChangeRequestItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: changeRequestStatusPath(), the writer's own resolver); tests only. */
  statusPath?: string;
  /** Runs root holding leader/drop and metrics/jobs.jsonl (default: resolveDropJobRoot()); tests only. */
  runsRoot?: string;
  /** Clock for fate age computation (default Date.now); tests only. */
  now?: () => number;
  /** Most items one call emits (default CHANGE_REQUEST_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** One validated status row: the writer's entry contract plus its parsed timestamp. */
export interface ChangeRequestRow {
  atMs: number;
  utcDay: string;
  /** The request id (UIREQ<12hex>), an opaque sha256 prefix — safe to quote. */
  id: string;
  /** The minted drop-job id (RQ-PHX-<id>), kept for the fate/PR joins. */
  jobId: string;
  surface: string;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pure: validate one parsed journal line against validStatusRow's contract —
 * every field appendStatusRow stamps, with the input bounds
 * parseFrictionFlag/changeRequestStatusPath enforce. Anything else is not
 * a request row. Unknown extra fields are tolerated so a writer that adds
 * metadata later does not invalidate its own history.
 */
export function parseChangeRequestEntry(value: unknown): ChangeRequestRow | null {
  if (!isRecord(value)) return null;
  if (value['v'] !== 1) return null;
  const id = value['id'];
  if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) return null;
  if (value['jobId'] !== `RQ-PHX-${id}`) return null;
  const surface = value['surface'];
  if (typeof surface !== 'string' || !SURFACE_RE.test(surface)) return null;
  const createdAt = value['createdAt'];
  const atMs = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(atMs)) return null;
  if (value['status'] !== 'queued') return null;
  return { atMs, utcDay: utcDayOf(atMs), id, jobId: `RQ-PHX-${id}`, surface };
}

/**
 * Pure: parse the journal's text into validated rows plus the count of
 * lines that were not on-contract entries — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseChangeRequestText(text: string): { rows: ChangeRequestRow[]; invalidRows: number } {
  const rows: ChangeRequestRow[] = [];
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
    const row = parseChangeRequestEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** The adverse outcome classes a request row can land in. */
export type ChangeRequestClass = 'rejected' | 'closed-unmerged';

/** Every class a row can classify into — the two adverse ones plus the context classes. */
export type ChangeRequestOutcome = ChangeRequestClass | 'merged' | 'open' | 'queued' | 'ingested' | 'unknown';

/**
 * Pure: classify one request row against its drop-job fate and PR state —
 * the same precedence listChangeRequests implies: a rejected ingest means
 * the request never became work; a recorded PR state is the strongest
 * terminal evidence; a still-queued prompt means intake has not drained;
 * an ingested fate with no PR evidence means the job ran and its outcome
 * belongs to the jobs-ledger feeders; anything else is unknown.
 */
export function classifyChangeRequest(
  row: ChangeRequestRow,
  fate: DropJobFate | null | undefined,
  pr: ChangeRequestPr | null | undefined,
): ChangeRequestOutcome {
  void row;
  if (fate?.fate === 'rejected') return 'rejected';
  if (pr?.state === 'closed') return 'closed-unmerged';
  if (pr?.state === 'merged') return 'merged';
  if (pr?.state === 'open') return 'open';
  if (fate?.fate === 'ingested' && fate.queued === true) return 'queued';
  if (fate?.fate === 'ingested') return 'ingested';
  return 'unknown';
}

/** One evidence cell's tally: every in-class request on one surface. */
export interface ChangeRequestCell {
  surface: string;
  klass: ChangeRequestClass;
  /** Distinct request ids inside the class — recurrence is the emit gate. */
  requests: number;
  /** Distinct UTC days those requests fall on. */
  days: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
  /** Example request ids (opaque hashes), capped at PROMPT_SAMPLES_MAX. */
  samples: string[];
  /** Resolved phantom PR urls for closed-unmerged rows (readRequestPrs already phantom-filters them), capped likewise. */
  prUrls: string[];
  /** True when more distinct requests existed than were kept. */
  sampleOverflow: boolean;
  /** Context tallies across the surface's other retained requests. */
  context: Record<Exclude<ChangeRequestOutcome, ChangeRequestClass>, number>;
}

/** Journal-recorded strings are untrusted text; scrub secrets and home paths, flatten, cap. */
function fieldText(value: string, max: number): string {
  return scrubPrivateText(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function surfaceText(surface: string): string {
  return fieldText(surface, 64) || 'unknown';
}

function addSample(cell: ChangeRequestCell, id: string): void {
  if (cell.samples.includes(id)) return;
  if (cell.samples.length >= PROMPT_SAMPLES_MAX) { cell.sampleOverflow = true; return; }
  cell.samples.push(id);
}

function addPrUrl(cell: ChangeRequestCell, url: string | null | undefined): void {
  if (typeof url !== 'string' || url === '' || cell.prUrls.includes(url)) return;
  if (cell.prUrls.length >= PROMPT_SAMPLES_MAX) return;
  cell.prUrls.push(url);
}

/**
 * Pure: fold classified rows into per-(surface, adverse-class) cells. Only
 * the two adverse classes emit; every other outcome lands in the surface
 * cells' context tallies so prompts can say what the rest of the surface's
 * requests did. Cells order by request count then latest record.
 */
export function foldChangeRequestEvidence(
  classified: readonly { row: ChangeRequestRow; outcome: ChangeRequestOutcome; prUrl?: string | null }[],
): { cells: ChangeRequestCell[]; records: number } {
  const cells = new Map<string, ChangeRequestCell>();
  const context = new Map<string, Record<Exclude<ChangeRequestOutcome, ChangeRequestClass>, number>>();
  const bumpContext = (surface: string, outcome: ChangeRequestOutcome): void => {
    if (outcome === 'rejected' || outcome === 'closed-unmerged') return;
    let tally = context.get(surface);
    if (tally === undefined) {
      tally = { merged: 0, open: 0, queued: 0, ingested: 0, unknown: 0 };
      context.set(surface, tally);
    }
    tally[outcome] += 1;
  };
  for (const { row, outcome, prUrl } of classified) {
    bumpContext(row.surface, outcome);
    if (outcome !== 'rejected' && outcome !== 'closed-unmerged') continue;
    const key = `${row.surface}${outcome}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        surface: row.surface, klass: outcome, requests: 0, days: new Set(),
        firstAtMs: Infinity, lastAtMs: -Infinity, samples: [], prUrls: [], sampleOverflow: false,
        context: { merged: 0, open: 0, queued: 0, ingested: 0, unknown: 0 },
      };
      cells.set(key, cell);
    }
    cell.requests += 1;
    cell.days.add(row.utcDay);
    cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
    addSample(cell, row.id);
    addPrUrl(cell, prUrl);
  }
  // Attach each surface's context tallies (computed over ALL its rows) to its cells.
  for (const cell of cells.values()) {
    const tally = context.get(cell.surface);
    if (tally !== undefined) cell.context = { ...tally };
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.requests >= CHANGE_REQUEST_MIN_CELL)
    .sort((a, b) => b.requests - a.requests || b.lastAtMs - a.lastAtMs || a.surface.localeCompare(b.surface) || a.klass.localeCompare(b.klass));
  return { cells: recurring, records: classified.length };
}

/** The evidence pointers every prompt shares; the writer, its joins and its queue contract are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is change-requests.jsonl inside the console feedback directory (~/.ashlr/router/change-requests.jsonl — changeRequestStatusPath() in src/core/verse/change-request.ts resolves it through frictionFeedbackDir(), honoring $HOME but deliberately not $ASHLR_HOME) — one append-only JSONL file with no rotation and no TTL. submitChangeRequest is called only from handleChangeRequestApi inside src/core/verse/change-request-api.ts, the POST /api/verse/change-request handler the console\'s Improve this screen request box reaches after the mutation-token and dispatch gates; each accepted request mints UIREQ<sha256[:12]> from the normalized description+surface, writes an RQ-PHX-UIREQ<hash> drop job through writeDropJob and appends one {v:1, id, jobId, surface, createdAt, status:\'queued\'} status row — refused, deferred and duplicate submissions write nothing. The lifecycle join is the same one listChangeRequests computes for the newest-20 pane: readDropJobFates (src/core/fleet/drop-job-fate.ts) folds leader/drop/ingested.tsv and the done/ filename suffixes into ingested|rejected fates, and readRequestPrs resolves each jobId\'s phantom PR url and open|merged|closed state from the metrics/jobs.jsonl tail and <jobId>.publish receipts. Until this feed that joined view was only ever a point-in-time pane — request-level deaths never became work.';

const NO_CHANGE = 'If the requests describe behavior already fixed on master, a renamed or removed surface, requests the fleet correctly refused or that closed for good reason, pinned ops machinery this repo must not rewrite, or something outside this repository — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncated: boolean, invalidRows: number, unknowns: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  if (unknowns > 0) notes.push(`${unknowns} retained request(s) had no fate or PR evidence inside the bounded joins and count as unknown, not failures`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function samplesText(cell: ChangeRequestCell): string {
  const parts: string[] = [];
  if (cell.samples.length > 0) {
    parts.push(`Request ids: ${cell.samples.join(', ')}${cell.sampleOverflow ? ', …and more' : ''}.`);
  } else {
    parts.push('no request ids were recorded');
  }
  if (cell.prUrls.length > 0) parts.push(`Closed-unmerged PRs: ${cell.prUrls.join(', ')}.`);
  return parts.join(' ');
}

function contextText(cell: ChangeRequestCell): string {
  const c = cell.context;
  const parts: string[] = [];
  if (c.merged > 0) parts.push(`${c.merged} merged`);
  if (c.open > 0) parts.push(`${c.open} open`);
  if (c.queued > 0) parts.push(`${c.queued} still queued`);
  if (c.ingested > 0) parts.push(`${c.ingested} ingested (outcome owned by the jobs-ledger feeds)`);
  if (c.unknown > 0) parts.push(`${c.unknown} unknown (no fate/PR evidence in the bounded joins)`);
  return parts.length === 0 ? '' : ` The surface's other retained requests: ${parts.join(', ')}.`;
}

const CLASS_TEXT: Record<ChangeRequestClass, {
  title: (surface: string, n: number) => string;
  lead: (surface: string, n: number, days: number) => string;
  hunt: string;
}> = {
  rejected: {
    title: (surface: string, n: number) => `Desktop change requests on '${surface}' keep dying at drop ingest — ${n} rejected`,
    lead: (surface: string, n: number, days: number) =>
      `Phantom's desktop console keeps collecting typed change requests on '${surface}' that the drop ingester rejects before they become work — ${n} rejected request(s) across ${days} distinct UTC day(s) inside the retained journal.`,
    hunt: `Each row is one screened user request (triageFeedback already refused unsafe text upstream) whose RQ-PHX-UIREQ drop job the ingester declined — the done/ filename's reason suffix is recorded but never quoted because it is free text. Trace the example request ids: the status row gives jobId RQ-PHX-<id>, and readDropJobFates maps the id to its rejected fate and reason class. Check whether rejections cluster on one cause — a request shape the ingester's validator refuses (validateDropJob in src/core/fleet/drop-job-writer.ts), a lane/tier the request body pins that intake rejects, requests too thin or too broad for a work-tier job, or a dedupe the UIREQ hash misses. Fix the cause in this repository — the request-body template in requestBody (src/core/verse/change-request.ts), the drop-job spec it mints, or the ingester contract the fleet owns — rather than muting the evidence.`,
  },
  'closed-unmerged': {
    title: (surface: string, n: number) => `Desktop change requests on '${surface}' keep closing unmerged — ${n} PR(s)`,
    lead: (surface: string, n: number, days: number) =>
      `Phantom's desktop console keeps collecting typed change requests on '${surface}' whose fleet PRs close without merging — ${n} closed-unmerged request(s) across ${days} distinct UTC day(s) inside the retained journal.`,
    hunt: `Each row is one user request whose RQ-PHX-UIREQ job reached a phantom PR that then closed unmerged — the request was attempted and did not land. Trace the example request ids through the jobs ledger (metrics/jobs.jsonl rows for RQ-PHX-<id>) and the PR urls readRequestPrs resolved, then decide which side is broken: the request itself was unclear or out of scope for a work-tier job (the requestBody prompt in src/core/verse/change-request.ts), the fleet machinery failed it (a failure another sibling feed already names — lane health, precheck declines, review blocks), or the PR was correctly closed as superseded or abandoned. Check whether closes cluster on one lane, one prompt shape or one reviewer outcome, and whether the request template should screen or reshape what it asks for. Fix what lives in this repository; if the closes were correct verdicts on bad requests — report no-change and name the evidence.`,
  },
};

function requestCountText(cell: ChangeRequestCell): string {
  return `${cell.requests} request${cell.requests === 1 ? '' : 's'} across ${cell.days.size} UTC day${cell.days.size === 1 ? '' : 's'}`;
}

function cellPrompt(cell: ChangeRequestCell, truncated: boolean, invalidRows: number): string {
  const surface = surfaceText(cell.surface);
  const text = CLASS_TEXT[cell.klass];
  const unknowns = cell.context.unknown;
  return [
    text.lead(surface, cell.requests, cell.days.size),
    '',
    `Every row in the journal is a deliberate request: an authorized console user typed a change request on the '${surface}' surface, it passed triageFeedback screening, and a drop job was minted for it. ${requestCountText(cell)}.${spanText(cell.firstAtMs, cell.lastAtMs)}${contextText(cell)}${coverageNote(truncated, invalidRows, unknowns)}`,
    '',
    samplesText(cell),
    '',
    EVIDENCE,
    '',
    text.hunt,
    '',
    NO_CHANGE,
  ].join('\n');
}

function cellTitle(cell: ChangeRequestCell): string {
  return CLASS_TEXT[cell.klass].title(surfaceText(cell.surface), cell.requests).slice(0, MAX_TITLE_CHARS);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function changeRequestItem(cell: ChangeRequestCell, repo: string, truncated: boolean, invalidRows: number): CloudBacklogItem {
  return {
    id: `change-request-${sha(`change-request:${cell.surface}:${cell.klass}`)}`,
    title: cellTitle(cell),
    prompt: cellPrompt(cell, truncated, invalidRows),
    area: 'ui-change-requests',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the desktop change-request journal's recurring adverse
 * outcomes. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function changeRequestsBacklogItems(opts: ChangeRequestItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const statusPath = opts.statusPath ?? changeRequestStatusPath();
    if (typeof statusPath !== 'string' || statusPath === '') return [];
    const read = await readLedgerTail(statusPath, CHANGE_REQUEST_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const parsed = parseChangeRequestText(read.text);
    if (parsed.rows.length === 0) return [];

    const root = resolveDropJobRoot(opts.runsRoot);
    const now = opts.now ?? Date.now;
    const [fates, prs] = await Promise.all([
      readDropJobFates({ runsRoot: root, limit: 50, now }),
      readRequestPrs(root, new Set(parsed.rows.map((row) => row.jobId))),
    ]);
    const fatesById = new Map(fates.fates.map((fate) => [fate.id, fate]));

    const classified = parsed.rows.map((row) => {
      const pr = prs.get(row.jobId);
      return { row, outcome: classifyChangeRequest(row, fatesById.get(row.id), pr), prUrl: pr?.url ?? null };
    });
    const folded = foldChangeRequestEvidence(classified);
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(changeRequestItem(cell, repo, read.truncated, parsed.invalidRows));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? CHANGE_REQUEST_BACKLOG_MAX_ITEMS, CHANGE_REQUEST_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
