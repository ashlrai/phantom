/**
 * Incident pipeline ledger recurring evidence → self-improvement backlog items.
 *
 * `phm incident report` (src/cli/incident.ts → src/core/incident/pipeline.ts)
 * turns a production signal — an error, a log-pattern anomaly or a bug
 * notice — into one bounded READY queue job: the signal is classified,
 * fingerprint-deduplicated against open incidents, rate limited per repo
 * and fleet-wide, and routed by severity (sev1 → P0 frontier, sev2 → P1
 * mid, sev3 → P2 fast, sev4 recorded only). The pipeline's whole state is
 * one JSON document, <runs>/incidents/incidents.v1.json —
 * `{ schema: 'incident.v1', entries, admissions }` — rewritten under
 * incidents.v1.lock on every ingest and receipt pass. Each entry keeps
 * the fingerprint, its latest jobId (`INC-…`), attempt, repo, severity,
 * kind, source, title, firstSeen/lastSeen, the cumulative sighting count
 * and receiptedAt once its fix job lands DONE.
 *
 * Until now the ledger's only readers were the pipeline's own dedup and
 * receipt passes — `phm incident` exposes just `report` and `receipts`,
 * no list or report verb — so three adverse conditions never became
 * work:
 *
 *  - Re-opened incidents: `attempt` only climbs after the previous fix
 *    job closed (the pipeline returns 'duplicate' while it is still
 *    active), so attempt ≥ 2 is the pipeline's own recorded verdict that
 *    the same production signal came back after its fix ended — a
 *    recurrence the 24h reopen window labels a regression. A fingerprint
 *    burning attempt after attempt means the queue-level fix loop is not
 *    converging on root cause.
 *  - Aged critical incidents with no completion receipt: a sev1/sev2
 *    entry first seen over a day ago, still being sighted inside the
 *    last two days, and never receipted — the ledger's record that no
 *    fix job has been confirmed DONE for it. The receipt pass is a
 *    manual verb, so absence is reported as "no receipt recorded" and
 *    the prompt sends the agent to the queue job itself, never asserts
 *    failure.
 *  - Contract-drifted entries: rows inside `entries` that fail the
 *    writer's own field contract — evidence the ledger was hand-edited
 *    or written by a different schema version, which the pipeline's
 *    dedup then silently mis-reads.
 *
 * incidentLedgerBacklogItems carries the same document into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the branch-gardener, runs-history,
 * installs-journal and sibling sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The state file is read whole through readSource's
 *    byte-capped no-follow path — it is one JSON document, so a torn or
 *    over-cap read cannot be partially trusted and yields no items
 *    rather than a guessed parse. Missing, degraded or foreign-schema
 *    documents read as no evidence. Nothing is written and no network
 *    is touched.
 *  - Repo matching is exact owner/repo, case-insensitive, plus the
 *    pipeline's bare-name form (`phantom`) matching the target's own
 *    name segment — the signal validator admits both spellings and the
 *    ledger is this install's own. Rows naming another owner/repo never
 *    fold onto this target.
 *  - Recurring means recorded. The window anchors on `lastSeen` — the
 *    pipeline refreshes it on every sighting including duplicates —
 *    inside INCIDENT_LEDGER_WINDOW_MS plus the sibling feeds' future
 *    skew. A regressed cell emits at two re-opened fingerprints or one
 *    fingerprint on its fourth attempt; a critical-open cell emits on
 *    one aged un-receipted sev1 or two aged un-receipted sev2s still
 *    sighted inside the last INCIDENT_LEDGER_LIVE_MS; drifted rows emit
 *    the unparsed cell at INCIDENT_LEDGER_UNPARSED_MIN, install-wide so
 *    it lands only on the fleet's own repository.
 *  - Unknown stays unknown. Malformed entries are counted, never
 *    guessed; jobIds, titles and sources are scrubbed, flattened and
 *    capped before they reach a prompt; counts are quoted only as
 *    recorded and receiptedAt absence is phrased as missing evidence,
 *    not asserted breakage.
 *  - Dedup is downstream. Item ids hash the bucket + repository identity
 *    (never the counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: it names the
 *    ledger file, pipeline.ts and the `phm incident` verbs, quotes the
 *    recorded fields, and ends with the usual no-change escape when the
 *    window has rolled forward, the queue jobs have since landed, or
 *    the cause is owner-only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the repo's bucket set is closed at three. */
export const INCIDENT_LEDGER_MAX_ITEMS = 8;
const INCIDENT_LEDGER_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const INCIDENT_LEDGER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Future-skew ceiling on ledger timestamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift: an entry stamped
 * further ahead than the evaluation time is corrupt or replayed
 * evidence and never reaches a tally.
 */
export const INCIDENT_LEDGER_FUTURE_SKEW_MS = 60_000;
/**
 * Whole-document byte cap for incidents.v1.json via readSource's
 * non-tail path — an over-cap state file reads 'degraded' and yields no
 * items. Entries run a few hundred bytes each, so 4 MiB is thousands of
 * fingerprints, many times any realistic ledger.
 */
export const INCIDENT_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
/** Distinct re-opened fingerprints the regressed cell needs… */
export const INCIDENT_LEDGER_REGRESSED_MIN_ENTRIES = 2;
/** …or the single-fingerprint bar: this attempt count means the fix loop already failed three times. */
export const INCIDENT_LEDGER_REGRESSED_MIN_ATTEMPT = 4;
/** How long a critical entry must sit un-receipted before it counts as aged… */
export const INCIDENT_LEDGER_CRITICAL_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** …and still be sighted this recently for the unresolved claim to hold. */
export const INCIDENT_LEDGER_LIVE_MS = 48 * 60 * 60 * 1000;
/** Contract-drifted entries the unparsed cell needs before it emits. */
export const INCIDENT_LEDGER_UNPARSED_MIN = 3;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Incident rows quoted inside one prompt before the remainder is summarized. */
const PROMPT_ROWS_MAX = 6;
/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
const FIELD_MAX = 120;
/** The ledger's path inside the fleet runs dir (pipeline.ts defaultDir() + filename). */
const INCIDENT_LEDGER_RELATIVE = join('incidents', 'incidents.v1.json');
const LEDGER_SCHEMA = 'incident.v1';
/** The pipeline's repo validator, duplicated to keep this feed's Tier-1 import closure light. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const SEVERITIES = new Set(['sev1', 'sev2', 'sev3', 'sev4']);
const KINDS = new Set(['error', 'log-anomaly', 'bug-notice']);
const TARGET_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
/** pipeline.ts buildJob ids: INC-<12-hex fingerprint | 24-hex fingerprint+revision hash>(-<attempt>). */
const JOB_ID = /^INC-(?:[a-f0-9]{12}|[a-f0-9]{24})(?:-\d+)?$/;
/** The fleet's own repository label: ledger drift is install-wide evidence, never another target's. */
const FLEET_REPO_NAME = 'phantom';

type Bucket = 'regressed' | 'critical-open' | 'unparsed';

export interface IncidentLedgerItemsOptions {
  /** Backlog target in owner/name form; ledger rows must name the same repository (or its bare name). */
  repo: string;
  /** Ledger override (default: <runsDir>/incidents/incidents.v1.json). */
  ledgerPath?: string;
  /** Runs dir for the ledger default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default INCIDENT_LEDGER_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated incidents.v1.json entry, timestamps resolved to epoch ms. */
export interface IncidentLedgerRow {
  fingerprint: string;
  jobId: string;
  attempt: number;
  repo: string;
  severity: string;
  kind: string;
  source: string;
  title: string;
  firstSeenMs: number;
  lastSeenMs: number;
  count: number;
  receiptedAtMs: number | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const parseMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Pure: validate one raw `entries[]` row against the writer's contract
 * (pipeline.ts IncidentEntry). Returns null on any contract failure —
 * the caller counts those as drifted evidence, never guesses.
 */
function parseIncidentRow(value: unknown): IncidentLedgerRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const fingerprint = r['fingerprint'];
  const jobId = r['jobId'];
  const attempt = r['attempt'];
  const repo = r['repo'];
  const severity = r['severity'];
  const kind = r['kind'];
  const source = r['source'];
  const title = r['title'];
  const firstSeenMs = parseMs(r['firstSeen']);
  const lastSeenMs = parseMs(r['lastSeen']);
  const count = r['count'];
  const receiptedRaw = r['receiptedAt'];
  const targetRevision = r['targetRevision'];
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{12}$/.test(fingerprint)) return null;
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return null;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) return null;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) return null;
  if (typeof severity !== 'string' || !SEVERITIES.has(severity)) return null;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (typeof source !== 'string' || source === '') return null;
  if (typeof title !== 'string' || title === '') return null;
  if (firstSeenMs === null || lastSeenMs === null) return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return null;
  if (receiptedRaw !== undefined && receiptedRaw !== null && parseMs(receiptedRaw) === null) return null;
  if (targetRevision !== undefined && targetRevision !== null &&
    (typeof targetRevision !== 'string' || !TARGET_REVISION.test(targetRevision))) return null;
  const receiptedAtMs = receiptedRaw === undefined || receiptedRaw === null ? null : parseMs(receiptedRaw);
  return {
    fingerprint,
    jobId,
    attempt,
    repo: repo.toLowerCase(),
    severity,
    kind,
    source,
    title,
    firstSeenMs,
    lastSeenMs,
    count,
    receiptedAtMs,
  };
}

export interface ParsedIncidentLedger {
  /** Contract-valid entries. */
  rows: IncidentLedgerRow[];
  /** Entries that failed the writer's field contract. */
  drifted: number;
}

/**
 * Pure: parse incidents.v1.json text into validated rows. A document that
 * is not the pipeline's own schema yields no rows and no drift count —
 * foreign or corrupt state is no evidence, not a partial guess.
 */
export function parseIncidentLedger(text: string): ParsedIncidentLedger {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { rows: [], drifted: 0 };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { rows: [], drifted: 0 };
  const doc = value as Record<string, unknown>;
  if (doc['schema'] !== LEDGER_SCHEMA) return { rows: [], drifted: 0 };
  const entries = doc['entries'];
  const admissions = doc['admissions'];
  if (!Array.isArray(entries) || !Array.isArray(admissions)) return { rows: [], drifted: 0 };
  const rows: IncidentLedgerRow[] = [];
  let drifted = 0;
  for (const raw of entries) {
    const row = parseIncidentRow(raw);
    if (row === null) drifted += 1;
    else rows.push(row);
  }
  return { rows, drifted };
}

/** The tallies one repository's windowed ledger rows produce. */
export interface IncidentLedgerFold {
  /** Windowed rows naming the target repository. */
  rows: IncidentLedgerRow[];
  /** Rows the pipeline re-opened after a closed fix (attempt ≥ 2). */
  regressed: IncidentLedgerRow[];
  /** Σ(attempt − 1) across regressed rows — total recorded re-openings. */
  regressedExcess: number;
  /** Highest attempt any windowed row reached. */
  maxAttempt: number;
  /** Aged, still-live sev1 rows with no completion receipt. */
  sev1Open: IncidentLedgerRow[];
  /** Aged, still-live sev2 rows with no completion receipt. */
  sev2Open: IncidentLedgerRow[];
  /** Distinct UTC days any windowed row was last sighted on. */
  sightingDays: Set<string>;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: fold validated rows for one repository into the cell tallies.
 * Rows outside the window — last sighting before its start or past the
 * evaluation time plus the sibling feeds' future skew — or naming
 * another repository contribute nothing. The critical-open split applies
 * the age and liveness bars here so the emit decision stays a single
 * comparison per severity.
 */
export function foldIncidentLedger(
  rows: readonly IncidentLedgerRow[],
  repo: string,
  nowMs: number,
  windowMs: number = INCIDENT_LEDGER_WINDOW_MS,
): IncidentLedgerFold {
  const target = repo.toLowerCase();
  const targetName = fleetRepoName(repo);
  const windowStart = nowMs - windowMs;
  const until = nowMs + INCIDENT_LEDGER_FUTURE_SKEW_MS;
  const liveSince = nowMs - INCIDENT_LEDGER_LIVE_MS;
  const agedBefore = nowMs - INCIDENT_LEDGER_CRITICAL_MIN_AGE_MS;
  const fold: IncidentLedgerFold = {
    rows: [],
    regressed: [],
    regressedExcess: 0,
    maxAttempt: 0,
    sev1Open: [],
    sev2Open: [],
    sightingDays: new Set(),
  };
  for (const row of rows) {
    if (row.lastSeenMs < windowStart || row.lastSeenMs > until) continue;
    if (row.repo !== target && row.repo !== targetName) continue;
    fold.rows.push(row);
    fold.sightingDays.add(utcDayOf(row.lastSeenMs));
    if (row.attempt >= 2) {
      fold.regressed.push(row);
      fold.regressedExcess += row.attempt - 1;
    }
    fold.maxAttempt = Math.max(fold.maxAttempt, row.attempt);
    if (row.receiptedAtMs !== null) continue;
    if (row.firstSeenMs > agedBefore || row.lastSeenMs < liveSince) continue;
    if (row.severity === 'sev1') fold.sev1Open.push(row);
    else if (row.severity === 'sev2') fold.sev2Open.push(row);
  }
  const byRecency = (a: IncidentLedgerRow, b: IncidentLedgerRow): number =>
    b.lastSeenMs - a.lastSeenMs || b.attempt - a.attempt || a.fingerprint.localeCompare(b.fingerprint);
  fold.regressed.sort(byRecency);
  fold.sev1Open.sort(byRecency);
  fold.sev2Open.sort(byRecency);
  return fold;
}

const WINDOW_DAYS = Math.round(INCIDENT_LEDGER_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the named INC-* queue jobs have since landed DONE (check `phm queue show <jobId>` and `phm incident receipts`), the signals stopped recurring, the fingerprints were retired by a landed fix, or the cause is owner-only (credentials, billing, a protected gate, pinned ops machinery or the reporting monitor itself) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is incidents/incidents.v1.json under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), rewritten by the incident pipeline (src/core/incident/pipeline.ts, driven by `phm incident report` and `phm incident receipts`) on every ingest and receipt pass; each entry is one fingerprint\'s latest attempt — jobId, attempt, repo, severity, kind, source, title, firstSeen/lastSeen, cumulative count and receiptedAt.';

/** One row's prompt fragment: scrubbed fields only, never raw ledger text. */
function rowText(row: IncidentLedgerRow): string {
  return `'${fieldText(row.title)}' (job ${fieldText(row.jobId, 40)}, ${row.severity}/${row.kind}, attempt ${row.attempt}, seen ${row.count}x over ${daySpan(row.firstSeenMs, row.lastSeenMs)} day(s), source ${fieldText(row.source, 60)})`;
}

function regressedPrompt(fold: IncidentLedgerFold, repo: string): string {
  const shown = fold.regressed.slice(0, PROMPT_ROWS_MAX).map(rowText);
  const rest = fold.regressed.length > shown.length ? `, and ${fold.regressed.length - shown.length} more` : '';
  const days = fold.sightingDays.size;
  return [
    `Phantom's incident pipeline keeps re-opening the same production signals on ${repo} — incidents whose fix jobs already closed came back, the self-improvement work this backlog exists for.`,
    '',
    `${fold.regressed.length} fingerprint(s) recorded attempt ≥ 2 inside the ${WINDOW_DAYS}-day ledger window — ${fold.regressedExcess} recorded re-opening(s) in total, highest attempt ${fold.maxAttempt}; last sightings span ${days} distinct UTC day(s). The window saw ${fold.rows.length} ledger row(s) for the repository. Re-opened signals: ${shown.join('; ')}${rest}.`,
    '',
    EVIDENCE,
    '',
    `attempt only climbs when the pipeline finds the previous INC-* job closed — DONE or failed — and the same fingerprint + target revision reports again, so each re-opening is a fix that did not hold. For each named job check \`phm queue show <jobId>\` and the job's PR: did the fix land and the signal genuinely recur (a regression — the root cause was missed or the fix was partial), or did the job fail, get re-cut, or close without a merged fix (a pipeline gap — the incident loop spent attempts without converging)? Recurring fingerprints across many attempts point at the fix loop itself: the job scope quotes the raw signal and asks for root cause, so check whether src/core/incident/pipeline.ts's buildJob scope/acceptance gives the fixer enough to find it, whether severity escalation on failed jobs (ingestSignal's isFailedJob path) is routing retries to the right tier, and whether the 24h reopenWindowMs in DEFAULT_LIMITS matches how fast these signals actually recur. If the re-openings were one-off bursts the queue already absorbed, or every named job landed a fix that held — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function criticalOpenPrompt(fold: IncidentLedgerFold, repo: string): string {
  const open = [...fold.sev1Open, ...fold.sev2Open].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  const shown = open.slice(0, PROMPT_ROWS_MAX).map(rowText);
  const rest = open.length > shown.length ? `, and ${open.length - shown.length} more` : '';
  const sev1 = fold.sev1Open.length;
  const sev2 = fold.sev2Open.length;
  return [
    `Phantom's incident ledger records ${sev1} sev1 and ${sev2} sev2 incident(s) on ${repo} first seen over a day ago, still being sighted, with no completion receipt — critical production signals whose fix outcome the pipeline never confirmed.`,
    '',
    `Inside the ${WINDOW_DAYS}-day window, ${open.length} aged critical row(s) carry no receiptedAt and were last sighted inside the last ${Math.round(INCIDENT_LEDGER_LIVE_MS / 3_600_000)} hours: ${shown.join('; ')}${rest}. A receipt is written only when the entry's INC-* job reaches DONE and \`phm incident receipts\` runs, so missing evidence means one of: the job is still queued or claimed, it failed or was abandoned, it landed but receipts were never run, or the signal is a false positive the severity classifier over-rated.`,
    '',
    EVIDENCE,
    '',
    `For each named job run \`phm queue show <jobId>\` and settle which case it is. A DONE job with no receipt means the manual receipts pass is not being run — check whether anything schedules \`phm incident receipts\` (nothing in this repository does today) and whether the pipeline should receipt inline on DONE instead. A failed or abandoned sev1/sev2 job means the severity→lane routing (ROUTES in pipeline.ts: sev1 P0 frontier, sev2 P1 mid) is not reaching an executor — check the queue's claim path for those priorities. A job still READY after a day at P0/P1 means dispatch is not draining critical work. If every named job has since landed and receipted, or the signals stopped — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unparsedPrompt(drifted: number): string {
  return [
    `Phantom's incident ledger (incidents.v1.json) holds ${drifted} entr${drifted === 1 ? 'y' : 'ies'} that fail the pipeline's own field contract — state the incident pipeline's dedup and severity logic silently mis-reads.`,
    '',
    `${drifted} row(s) inside the entries array could not be validated against IncidentEntry's contract (pipeline.ts): fingerprint, jobId, attempt, repo, severity, kind, source, title, firstSeen/lastSeen, count and optional receiptedAt/targetRevision. The document itself parsed as schema 'incident.v1', so the drift is per-row — a hand edit, a partial write, or a schema change the parser predates.`,
    '',
    EVIDENCE,
    '',
    `The ledger is written whole under incidents.v1.lock by withLedger (pipeline.ts), so per-row drift means the file was edited outside the pipeline or written by a different version. Diff the drifted rows against IncidentEntry: if this repository's writer changed shape, update parseIncidentRow's contract in src/core/improve/incident-ledger-backlog.ts and pipeline.ts together; if the rows are foreign, the honest fix is quarantining or regenerating the ledger — never hand-repairing incident state. Check \`phm incident report --kind error --repo <repo> --message 'ledger drift probe' --json\` on a scratch --dir first to confirm the writer still round-trips. If the file has since been rewritten clean — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(bucket: Bucket, repo: string): string {
  const hash = createHash('sha256').update(`incident-ledger:${bucket}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `incident-ledger-${bucket}-${hash}`;
}

function makeItem(bucket: Bucket, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(bucket, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'incident-ledger',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the incident pipeline ledger's recurring re-opened
 * incidents, aged un-receipted criticals and contract-drifted rows on
 * `repo`. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function incidentLedgerBacklogItems(opts: IncidentLedgerItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const ledgerPath = opts.ledgerPath ?? join(runsDir, INCIDENT_LEDGER_RELATIVE);
    const read = await readSource(ledgerPath, INCIDENT_LEDGER_MAX_BYTES, false);
    if (read.state !== 'healthy') return [];
    const parsed = parseIncidentLedger(read.text);
    if (parsed.rows.length === 0 && parsed.drifted === 0) return [];
    const fold = foldIncidentLedger(parsed.rows, repo, nowMs);

    const candidates: CloudBacklogItem[] = [];
    const regressedBar = fold.regressed.length >= INCIDENT_LEDGER_REGRESSED_MIN_ENTRIES ||
      fold.maxAttempt >= INCIDENT_LEDGER_REGRESSED_MIN_ATTEMPT;
    if (regressedBar && fold.regressed.length > 0) {
      candidates.push(makeItem(
        'regressed',
        repo,
        `${fold.regressed.length} incident(s) keep re-opening on ${repo}`,
        regressedPrompt(fold, repo),
      ));
    }
    if (fold.sev1Open.length >= 1 || fold.sev2Open.length >= 2) {
      candidates.push(makeItem(
        'critical-open',
        repo,
        `${fold.sev1Open.length + fold.sev2Open.length} critical incident(s) unconfirmed on ${repo}`,
        criticalOpenPrompt(fold, repo),
      ));
    }
    if (parsed.drifted >= INCIDENT_LEDGER_UNPARSED_MIN && fleetRepoName(repo) === FLEET_REPO_NAME) {
      candidates.push(makeItem(
        'unparsed',
        repo,
        `Incident ledger holds ${parsed.drifted} drifted row(s)`,
        unparsedPrompt(parsed.drifted),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? INCIDENT_LEDGER_MAX_ITEMS, INCIDENT_LEDGER_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
