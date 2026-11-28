/**
 * Scheduled steward disk-guardrail journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `phm steward schedule [--install] [--apply]` (src/cli/steward.ts →
 * stewardSchedule in src/core/steward/schedule.ts) installs a per-user
 * launchd agent (macOS) or systemd user timer (Linux) that runs
 * `phm steward disk [--apply] --json` daily and appends the command's
 * stdout AND stderr to ~/.ashlr/logs/steward.jsonl under the user's
 * home. Each run prints one pretty-printed StewardReport document —
 * runSteward (src/core/steward/disk.ts) measuring the allowlisted
 * agent-log roots (codex-sessions, codex-log, claude-projects,
 * ashlr-logs, ashlr-runs by default) against each root's retentionDays
 * and quotaMB: per root {id, path, exists, files, bytes, quotaBytes,
 * overQuota, reclaimable:{files,bytes}, action, nativeHint?} plus
 * totalBytes, reclaimableBytes and the deleted/archived totals an
 * --apply run recorded.
 *
 * Until now the journal had no reader at all: the report's only other
 * surfaces are `phm steward disk`'s own stdout (a report someone had
 * to run) and improve/loop.ts's live runSteward proposals (a
 * point-in-time gather, never the recorded series). A root that keeps
 * reporting overQuota — retention and quota that never converge, or a
 * report-only install whose measurement nobody ever sees — sat in an
 * append-only file nobody folded, never work. The sibling
 * disk-backlog fold covers host disk pressure and disk-sweep-backlog
 * covers the fleet sweep's own outcomes; this feed covers the
 * agent-log guardrail's recurring verdicts.
 *
 * stewardBacklogItems carries the journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling disk sources beside it.
 *
 * One evidence axis, anchored to the writer's own document contract:
 * a root id whose overQuota verdict holds on the newest
 * STEWARD_MIN_RUNS consecutive valid reports — the maintenance has
 * recorded the same root over quota on every completed run in the
 * retained tail and never brought it back under. The streak's
 * applied/report-only mix, the newest bytes-vs-quota measurement, the
 * newest reclaimable tally and the streak's deleted/archived totals
 * ride in the prompt so the session can tell "deletes happen but the
 * root regrows" from "nothing is eligible to reclaim" from "report-only
 * runs never touch it".
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail read (1 MiB); documents are validated
 *    against the writer's logged shape — boolean applied, a roots
 *    array of {id, path, exists, files, bytes, quotaBytes, overQuota,
 *    reclaimable, action} rows inside the writer's closed
 *    delete/archive/report vocabulary, non-negative finite byte
 *    figures, safe-integer file counts, and the deleted/archived
 *    totals. Malformed documents, off-contract rows and non-document
 *    lines count as coverage, never guessed; nothing is written and
 *    no process is inspected.
 *  - Documents carry no timestamp. StewardReport has no `at` field and
 *    the unit appends whatever the command printed, so recurrence is
 *    measured in recorded runs — the consecutive suffix of valid
 *    reports — never in days. Prompts say "consecutive recorded runs";
 *    a host whose unit fires more often than daily still produces one
 *    document per run and the count stays honest.
 *  - Document framing is unambiguous. The writer's
 *    JSON.stringify(report, null, 2) puts the document's braces alone
 *    on column 0 — nested braces are always indented and JSON strings
 *    never contain literal newlines — so a column-0 `{` opens a
 *    document, a column-0 `}` closes it, and a column-0 `{` seen
 *    inside one means the previous document was abandoned mid-write
 *    (counted as abandonedDocs). An unterminated document at the tail
 *    is a torn final fragment (openTail), never a run. Lines outside
 *    documents — stderr noise between reports — count as strayLines.
 *  - Missing or unreadable evidence yields no items. A missing,
 *    non-file or unreadable journal is the writer's normal state —
 *    the schedule is opt-in --install — and contributes nothing
 *    rather than an error.
 *  - Recurring means recorded. A root emits only while its overQuota
 *    verdict holds on every one of the newest STEWARD_MIN_RUNS valid
 *    reports that measured it: a root absent from a report or back
 *    under quota breaks the streak, an invalid document between two
 *    valid ones does not (it is not a completed run's verdict), and a
 *    truncated tail is stated as a lower bound.
 *  - Report-only is evidence, not a defect of the fold. An
 *    applied:false streak means the unit was installed without
 *    --apply: overQuota persistence is the designed measurement, but
 *    nobody reads the journal, so the recurring verdict still earns a
 *    retune-or-install item — the prompt splits the two cases on the
 *    recorded applied flag.
 *  - The evidence carries no repository dimension — it describes this
 *    install's host and agent-log roots. Items therefore emit only
 *    when the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Each id embeds a stable hash of the root id
 *    (never counts or measurements), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; shifted
 *    tallies do not spawn twin items and a recovered root stops
 *    emitting.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, root ids pass through the id-safe
 *    fragment rule, absolute paths and vendor details stay out of the
 *    item (the journal path and the policy file are named instead),
 *    and the brief names `phm steward disk --json`, the journal and
 *    the sibling disk items — with the usual no-change escape when
 *    the streak has rolled forward or the cause is owner-side.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the default policy names five roots and custom policies stay small. */
export const STEWARD_MAX_ITEMS = 8;
const STEWARD_ITEM_HARD_MAX = 25;
/**
 * Bounded tail of the journal. Documents run a few KiB each, so 1 MiB
 * covers hundreds of daily runs — far past any streak this feed
 * emits; a contract-violating larger file still folds its newest
 * documents flagged as a lower bound.
 */
export const STEWARD_TAIL_BYTES = 1024 * 1024;
/** Consecutive valid reports an over-quota root needs before it counts as recurring. */
export const STEWARD_MIN_RUNS = 3;
/** The writer's closed root-action vocabulary (StewardAction in src/core/steward/disk.ts). */
const ACTION_VOCABULARY = new Set(['delete', 'archive', 'report']);
/** The fleet's own repository label: steward evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;

export interface StewardItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home the journal resolves under (default: os.homedir()); the unit writes <home>/.ashlr/logs/steward.jsonl. */
  homeDir?: string;
  /** Journal path override (default: <homeDir>/.ashlr/logs/steward.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default STEWARD_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** One validated root row inside a journaled steward report. */
export interface StewardRootReport {
  /** The policy root id ('codex-sessions', 'claude-projects', …) — the item's identity, never the path. */
  id: string;
  /** The writer's closed action vocabulary. */
  action: 'delete' | 'archive' | 'report';
  exists: boolean;
  files: number;
  bytes: number;
  quotaBytes: number;
  overQuota: boolean;
  reclaimableFiles: number;
  reclaimableBytes: number;
}

/** One validated steward.jsonl document: a completed `phm steward disk --json` run's report. */
export interface StewardRunReport {
  /** Whether the run was --apply; false is the report-only install's designed measurement. */
  applied: boolean;
  roots: StewardRootReport[];
  totalBytes: number;
  reclaimableBytes: number;
  deletedFiles: number;
  deletedBytes: number;
  archivedFiles: number;
  archivedBytes: number;
}

/** Journal coverage the prompts state: what the bounded read and document parse actually saw. */
export interface StewardCoverage {
  /** Documents that closed on contract but failed validation — off-contract rows, never guessed. */
  invalidDocs: number;
  /** Documents abandoned mid-write when a column-0 `{` opened the next one. */
  abandonedDocs: number;
  /** Whether the tail ends inside an unterminated document — a torn final fragment, never a run. */
  openTail: boolean;
  /** Non-empty lines outside documents — stderr noise between reports, counted never quoted. */
  strayLines: number;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  truncated: boolean;
  /** The ledger read's own state when it was not 'read'. */
  sourceState: string;
}

/** One root's consecutive over-quota streak: the fold's measured cell. */
export interface StewardRootCell {
  id: string;
  action: 'delete' | 'archive' | 'report';
  /** Consecutive newest valid reports measuring this root overQuota. */
  runs: number;
  /** Streak documents recorded applied:true vs applied:false. */
  appliedRuns: number;
  reportOnlyRuns: number;
  /** The newest streak report's measurement, quoted as recorded. */
  newestBytes: number;
  newestFiles: number;
  newestQuotaBytes: number;
  newestReclaimableFiles: number;
  newestReclaimableBytes: number;
  /** Streak totals: files the applied runs deleted and cold sessions they archived. */
  deletedFiles: number;
  archivedFiles: number;
  deletedBytes: number;
  archivedBytes: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A non-negative finite number, the shape every recorded byte figure takes. */
function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A non-negative safe integer, the shape every recorded file count takes. */
function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A bounded non-empty string, scrubbed, printable-only, flattened and capped — journal text is untrusted. */
function fieldText(value: unknown, max = FIELD_MAX): string {
  if (typeof value !== 'string') return '';
  return scrubSecrets(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Pure: validate one parsed steward.jsonl document against the shape
 * runSteward returns and the CLI prints — {applied, roots[], totalBytes,
 * reclaimableBytes, deleted, archived}. Roots must come from the
 * writer's contract: bounded id/path strings, boolean exists/overQuota,
 * safe-integer file counts, non-negative finite byte figures, the
 * closed action vocabulary and the reclaimable/deleted/archived pair
 * shapes. Anything else is not a journal document.
 */
export function parseStewardReportDoc(value: unknown): StewardRunReport | null {
  if (!isRecord(value)) return null;
  const applied = value['applied'];
  if (typeof applied !== 'boolean') return null;
  const rawRoots = value['roots'];
  if (!Array.isArray(rawRoots)) return null;
  const roots: StewardRootReport[] = [];
  for (const raw of rawRoots) {
    if (!isRecord(raw)) return null;
    const id = fieldText(raw['id'], 128);
    const path = fieldText(raw['path'], 4096);
    if (id === '' || path === '') return null;
    const action = raw['action'];
    if (typeof action !== 'string' || !ACTION_VOCABULARY.has(action)) return null;
    const exists = raw['exists'];
    const overQuota = raw['overQuota'];
    if (typeof exists !== 'boolean' || typeof overQuota !== 'boolean') return null;
    const files = raw['files'];
    const bytes = raw['bytes'];
    const quotaBytes = raw['quotaBytes'];
    if (!nonNegativeInt(files) || !nonNegative(bytes) || !nonNegative(quotaBytes)) return null;
    const reclaimable = raw['reclaimable'];
    if (!isRecord(reclaimable)) return null;
    const reclaimableFiles = reclaimable['files'];
    const reclaimableBytes = reclaimable['bytes'];
    if (!nonNegativeInt(reclaimableFiles) || !nonNegative(reclaimableBytes)) return null;
    const nativeHint = raw['nativeHint'];
    if (nativeHint !== undefined && typeof nativeHint !== 'string') return null;
    roots.push({
      id,
      action: action as 'delete' | 'archive' | 'report',
      exists,
      files,
      bytes,
      quotaBytes,
      overQuota,
      reclaimableFiles,
      reclaimableBytes,
    });
  }
  const totalBytes = value['totalBytes'];
  const reclaimableBytes = value['reclaimableBytes'];
  if (!nonNegative(totalBytes) || !nonNegative(reclaimableBytes)) return null;
  const pair = (key: 'deleted' | 'archived'): { files: number; bytes: number } | null => {
    const row = value[key];
    if (!isRecord(row)) return null;
    const files = row['files'];
    const bytes = row['bytes'];
    if (!nonNegativeInt(files) || !nonNegative(bytes)) return null;
    return { files, bytes };
  };
  const deleted = pair('deleted');
  const archived = pair('archived');
  if (deleted === null || archived === null) return null;
  return {
    applied,
    roots,
    totalBytes,
    reclaimableBytes,
    deletedFiles: deleted.files,
    deletedBytes: deleted.bytes,
    archivedFiles: archived.files,
    archivedBytes: archived.bytes,
  };
}

/**
 * Pure: parse one steward.jsonl file's text into validated run reports
 * plus coverage. Documents are delimited by column-0 braces — the
 * writer's JSON.stringify(report, null, 2) framing — so a column-0 `{`
 * opens a document and a column-0 `}` closes it; a column-0 `{` inside
 * an open document abandons it (abandonedDocs), an unterminated tail
 * fragment is openTail, and non-empty lines outside documents are
 * strayLines. Closed documents that fail the report contract count as
 * invalidDocs — never guessed.
 */
export function parseStewardJournal(text: string): { runs: StewardRunReport[]; coverage: Omit<StewardCoverage, 'truncated' | 'sourceState'> } {
  const runs: StewardRunReport[] = [];
  let invalidDocs = 0;
  let abandonedDocs = 0;
  let strayLines = 0;
  let openTail = false;
  let buffer: string[] | null = null;
  for (const line of text.split('\n')) {
    if (buffer === null) {
      if (line === '{') buffer = [line];
      else if (line.trim() !== '') strayLines += 1;
      continue;
    }
    if (line === '{') {
      // A column-0 `{` can only be a new document: the previous one was
      // abandoned mid-write (torn write or a stray stderr brace line).
      abandonedDocs += 1;
      buffer = [line];
      continue;
    }
    buffer.push(line);
    if (line !== '}') continue;
    const docText = buffer.join('\n');
    buffer = null;
    let value: unknown;
    try {
      value = JSON.parse(docText);
    } catch {
      invalidDocs += 1;
      continue;
    }
    const run = parseStewardReportDoc(value);
    if (run === null) { invalidDocs += 1; continue; }
    runs.push(run);
  }
  if (buffer !== null) openTail = true;
  return { runs, coverage: { invalidDocs, abandonedDocs, openTail, strayLines } };
}

/**
 * Pure: fold validated run reports into per-root consecutive
 * over-quota streaks. A root's streak is the suffix of reports ending
 * at the newest one: scanning newest-to-oldest while every report
 * measured the id with overQuota true. A report lacking the id, or
 * recording it back under quota, ends the streak — so a root that
 * recovered, or one the newest reports no longer measure (a policy
 * change dropped it), carries no current streak and never emits.
 * Invalid documents never enter the sequence at all (they are not a
 * completed run's verdict). Streak totals quote the newest report's
 * measurement and sum the streak's deleted/archived figures —
 * report-only runs record zeros there by the writer's own contract.
 */
export function foldStewardEvidence(runs: readonly StewardRunReport[]): StewardRootCell[] {
  const byRun = runs.map((run) => new Map(run.roots.map((root) => [root.id, root])));
  const ids = new Set<string>();
  for (const run of runs) for (const root of run.roots) ids.add(root.id);
  const cells: StewardRootCell[] = [];
  for (const id of ids) {
    let streak = 0;
    let appliedRuns = 0;
    let reportOnlyRuns = 0;
    let newest: StewardRootReport | null = null;
    let deletedFiles = 0;
    let deletedBytes = 0;
    let archivedFiles = 0;
    let archivedBytes = 0;
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const run = runs[i]!;
      const root = byRun[i]!.get(id);
      if (root === undefined || !root.overQuota) break;
      streak += 1;
      if (newest === null) newest = root;
      if (run.applied) appliedRuns += 1; else reportOnlyRuns += 1;
      deletedFiles += run.deletedFiles;
      deletedBytes += run.deletedBytes;
      archivedFiles += run.archivedFiles;
      archivedBytes += run.archivedBytes;
    }
    if (newest === null) continue;
    cells.push({
      id,
      action: newest.action,
      runs: streak,
      appliedRuns,
      reportOnlyRuns,
      newestBytes: newest.bytes,
      newestFiles: newest.files,
      newestQuotaBytes: newest.quotaBytes,
      newestReclaimableFiles: newest.reclaimableFiles,
      newestReclaimableBytes: newest.reclaimableBytes,
      deletedFiles,
      archivedFiles,
      deletedBytes,
      archivedBytes,
    });
  }
  return cells.sort((a, b) => b.runs - a.runs || a.id.localeCompare(b.id));
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Id-safe fragment: backlog ids admit [A-Za-z0-9._-] only and cap at 120 chars total. */
const idSafe = (value: string, cap: number): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, cap) || 'unknown';

/** Byte figures as recorded, rounded to one decimal MB — never re-estimated. */
function mbText(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function coverageNote(coverage: StewardCoverage): string {
  const parts: string[] = [];
  if (coverage.invalidDocs > 0) parts.push(`${coverage.invalidDocs} document(s) failed the report contract and were not counted`);
  if (coverage.abandonedDocs > 0) parts.push(`${coverage.abandonedDocs} document(s) were abandoned mid-write`);
  if (coverage.openTail) parts.push('the tail ends inside an unterminated document');
  if (coverage.strayLines > 0) parts.push(`${coverage.strayLines} non-document line(s) between reports`);
  if (coverage.truncated) parts.push('the bounded tail cut older documents, so counts are a lower bound');
  if (coverage.sourceState !== 'read') parts.push(`the journal read state was '${coverage.sourceState}'`);
  return parts.length === 0 ? '' : ` Journal coverage: ${parts.join('; ')}.`;
}

const EVIDENCE = 'The evidence is ~/.ashlr/logs/steward.jsonl under the user\'s home — the stdout+stderr sink stewardSchedule (src/core/steward/schedule.ts) gives the daily `phm steward disk [--apply] --json` unit (launchd ai.ashlr.phm.steward / systemd phm-steward.{service,timer}), one pretty-printed StewardReport JSON document per completed run. runSteward (src/core/steward/disk.ts) measures the allowlisted agent-log roots — codex-sessions, codex-log, claude-projects, ashlr-logs, ashlr-runs under defaultStewardPolicy — against each root\'s retentionDays and quotaMB and reports exists/files/bytes/quotaBytes/overQuota/reclaimable per root plus the deleted/archived totals an --apply run recorded. Documents carry no timestamp, so this feed counts consecutive recorded runs, never days. Until now the journal\'s only surface was the log file itself — no fold ever read it; `phm steward disk --json` prints the same report live and improve/loop.ts\'s gatherProposals reads a live runSteward report for its steward-retention proposals, never the recorded series.';

const NO_CHANGE = 'If the newest `phm steward disk --json` run shows the root back under quota, the streak was a bounded burst the later runs recovered from, the quota or retention was already retuned, the root\'s growth is a vendor session store\'s own retention the policy deliberately watches report-only, the scheduled unit was uninstalled or retimed, or the cause is owner-side or pinned ops machinery — report no-change and name the evidence.';

function stewardPrompt(cell: StewardRootCell, coverage: StewardCoverage): string {
  const modeText = cell.appliedRuns > 0 && cell.reportOnlyRuns > 0
    ? ` The streak mixes ${cell.appliedRuns} applied and ${cell.reportOnlyRuns} report-only run(s) — report-only documents are the install's designed measurement, but the journal is the only place they land.`
    : '';
  const churnText = cell.appliedRuns === 0
    ? ' Every run in the streak was report-only — the unit measures the root but never reclaims it.'
    : cell.deletedFiles + cell.archivedFiles > 0
      ? ` Across the streak the applied runs deleted ${cell.deletedFiles} file(s) (${mbText(cell.deletedBytes)}) and archived ${cell.archivedFiles} cold session(s) (${mbText(cell.archivedBytes)}) — maintenance ran and the root still stayed over quota.`
      : ' The streak\'s applied runs recorded zero deleted and zero archived files.';
  const stuckText = cell.newestReclaimableFiles === 0
    ? ' The newest report\'s reclaimable tally is zero files: nothing was eligible to delete or archive (every file inside the 24-hour protection window, or the victim set already exhausted), so retention alone cannot bring this root under quota.'
    : ` The newest report still found ${cell.newestReclaimableFiles} file(s) / ${mbText(cell.newestReclaimableBytes)} reclaimable — deletes or archives happen but the root regrows past quota before the next run.`;
  return [
    `Phantom's scheduled steward disk guardrail keeps reporting agent-log root '${cell.id}' over quota — ${cell.runs} consecutive recorded runs, the self-improvement work this backlog exists for.`,
    '',
    `Each document is one completed \`phm steward disk [--apply] --json\` run's StewardReport appended to the schedule's log. The newest recorded measurement: ${mbText(cell.newestBytes)} across ${cell.newestFiles} file(s) vs a ${mbText(cell.newestQuotaBytes)} quota under the '${cell.action}' action, still overQuota.${modeText}${churnText}${stuckText}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why '${cell.id}' stays over quota: defaultStewardPolicy (src/core/steward/disk.ts) sets each root's retentionDays and quotaMB — check whether the quota fits the root's real working set (a quota below the 24-hour-protected live set can never be satisfied by retention), whether the archive/delete path keeps up with the root's growth (reclaimable files every run means maintenance runs but the writer outgrows it — find the runaway session/log producer), whether the unit was installed report-only so nothing ever reclaims, or whether the root's path or vendor changed underneath the policy. Reproduce with \`phm steward disk --json\` — the dry run prints the same measurement — and the journal tail; the sibling disk-backlog items carry the host-pressure context and disk-sweep-backlog the fleet sweep's own outcomes. Fix what lives in this repository — the policy, the growth source or the schedule; if the consumer is a vendor store's own retention, owner-side state or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function stewardItem(cell: StewardRootCell, coverage: StewardCoverage, repo: string): CloudBacklogItem {
  // The hash covers the full cell identity (root id); the readable
  // fragment is bounded so the id stays inside ID_RE's 120-char cap.
  const hash = createHash('sha256')
    .update(`steward-overquota:${repo.trim().toLowerCase()}:${cell.id}`)
    .digest('hex').slice(0, 16);
  const id = `steward-overquota-${idSafe(cell.id, 30)}-${hash}`;
  return {
    id,
    title: `Steward root '${cell.id}' stays over quota`.slice(0, MAX_TITLE_CHARS),
    prompt: stewardPrompt(cell, coverage),
    area: 'disk-pressure',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the steward journal's recurring adverse evidence:
 * roots whose overQuota verdict holds on the newest STEWARD_MIN_RUNS
 * consecutive valid reports. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function stewardBacklogItems(opts: StewardItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath ?? join(home, '.ashlr', 'logs', 'steward.jsonl');
    const read = await readLedgerTail(journalPath, STEWARD_TAIL_BYTES);
    // A missing, non-file or unreadable journal is the writer's normal
    // state — the schedule is opt-in --install — and contributes nothing.
    if (read.state !== 'read') return [];
    const parsed = parseStewardJournal(read.text);
    if (parsed.runs.length === 0) return [];
    const cells = foldStewardEvidence(parsed.runs);
    const coverage: StewardCoverage = {
      ...parsed.coverage,
      truncated: read.truncated,
      sourceState: read.state,
    };
    const items: CloudBacklogItem[] = [];
    for (const cell of cells) {
      if (cell.runs < STEWARD_MIN_RUNS) break;
      items.push(stewardItem(cell, coverage, repo));
      if (items.length >= STEWARD_MAX_ITEMS) break;
    }
    const limit = Math.max(1, Math.min(opts.limit ?? STEWARD_MAX_ITEMS, STEWARD_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
