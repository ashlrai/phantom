/**
 * Scheduled model-radar run journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `phm models radar schedule [--install]` (src/cli/models.ts →
 * modelRadarSchedule in src/core/fleet/model-radar-schedule.ts)
 * installs a per-user launchd agent (macOS) or systemd user timer
 * (Linux) that runs `phm models radar --fetch --propose --json`
 * daily and appends the command's stdout AND stderr to
 * ~/.ashlr/logs/model-radar.jsonl under the user's home. Each run
 * prints one pretty-printed ModelRadarReport document —
 * runModelRadar (src/core/fleet/model-radar.ts) reading the saved
 * provider release-note pages, diffing them against the verified
 * registry through loadVerifiedRegistry
 * (src/core/fleet/model-verify.ts), and reporting per-provider
 * doc state ('read' | 'empty' | 'unknown'), the --fetch save
 * results, the unapplied registry patch and the --propose inbox
 * filing counts.
 *
 * Until now the journal had no reader at all: the report's only
 * other surfaces are `phm models radar`'s own stdout (a report
 * someone had to run) and the sibling modelRadarBacklogItems fold,
 * which reads the pending '[model radar] Review …' inbox notes the
 * --propose step files — downstream artifacts that only exist when
 * a run got far enough to file them. A radar that keeps failing
 * before proposing — registry unreadable, every source page
 * refusing to save, notes never landing on disk, or candidates
 * found but never filed — left evidence only in an append-only
 * file nobody folded, never work. This feed covers the run
 * journal's recurring adverse verdicts; the sibling feed keeps
 * covering the notes that did land.
 *
 * modelRadarRunBacklogItems carries the journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling evidence sources
 * beside it.
 *
 * Four evidence axes, each anchored to the writer's own document
 * contract and each requiring MODEL_RADAR_MIN_RUNS consecutive
 * valid reports carrying the adverse verdict:
 *
 *  - registry: registry:'unknown' means loadVerifiedRegistry threw,
 *    so the run scanned against an empty registry and compared
 *    nothing — every provider row reads doc:'unknown' by
 *    construction, not by measurement. A registry-outage streak is
 *    one cell; the doc axis treats those runs as unmeasured so the
 *    outage never fabricates per-provider blindness.
 *  - fetch:<provider>: the scheduled command always --fetches, so
 *    every report's fetch[] records one {provider,url,saved} row
 *    per MODEL_RADAR_SOURCES page
 *    (src/core/fleet/model-radar-fetch.ts). A provider whose every
 *    recorded page came back saved:false on consecutive runs never
 *    refreshes — the radar keeps scanning the last saved copy, or
 *    nothing when none ever landed. Partial failures are not the
 *    verdict: one dead secondary page beside live primaries is
 *    normal web flakiness, not blindness.
 *  - doc:<provider>: a providers[] row whose doc stayed 'empty' or
 *    'unknown' on consecutive registry-readable runs — no saved
 *    file, an unreadable one, a file with no text, or a provider
 *    with no id table. Measured only on registry:'ok' runs: an
 *    'unknown' row inside a registry-outage report is the empty
 *    scan's construction, not evidence about the notes.
 *  - proposals: --propose files one pending inbox note per fresh
 *    high-confidence addition through fileModelRadarProposals
 *    (src/core/fleet/model-radar-proposals.ts); proposals.failed
 *    counts candidates createProposal did not return pending. A
 *    streak of failed>0 runs means the radar finds models the
 *    inbox never sees — modelRadarBacklogItems starves even though
 *    the scan works. Runs without a proposals field (a --json run
 *    that never proposed) are unmeasured and break the streak.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail read (1 MiB); documents are validated
 *    against the writer's logged models.radar.v1 contract —
 *    schema/version, the registry/ok/router_choices vocabularies,
 *    the providers[] row shapes, the models.registry-patch.v1
 *    envelope, the fetch[] row shapes, the lane_notices[] row
 *    vocabularies and the optional proposals counts. Malformed
 *    documents, off-contract rows and non-document lines count as
 *    coverage, never guessed; nothing is written and no network is
 *    touched.
 *  - Documents carry no timestamp. ModelRadarReport has no `at`
 *    field and the unit appends whatever the command printed, so
 *    recurrence is measured in recorded runs — the consecutive
 *    suffix of valid reports carrying each adverse verdict — never
 *    in days. Prompts say "consecutive recorded runs"; a host whose
 *    unit fires more often than daily still produces one document
 *    per run and the count stays honest.
 *  - Document framing is unambiguous. The writer's
 *    JSON.stringify(report, null, 2) puts the document's braces
 *    alone on column 0 — nested braces are always indented and JSON
 *    strings never contain literal newlines — so a column-0 `{`
 *    opens a document, a column-0 `}` closes it, and a column-0 `{`
 *    seen inside one means the previous document was abandoned
 *    mid-write (counted as abandonedDocs). An unterminated document
 *    at the tail is a torn final fragment (openTail), never a run.
 *    Lines outside documents — stderr noise between reports —
 *    count as strayLines.
 *  - Missing or unreadable evidence yields no items. A missing,
 *    non-file or unreadable journal is the writer's normal state —
 *    the schedule is opt-in --install — and contributes nothing
 *    rather than an error.
 *  - Recurring means recorded. A cell emits only while its adverse
 *    verdict holds on every one of the newest MODEL_RADAR_MIN_RUNS
 *    valid reports that measured it: a clear verdict, an absent
 *    row or an unmeasured run (registry-outage docs for the doc
 *    axis, a fetch-less report for the fetch axis, a
 *    proposals-less report for the proposals axis) breaks the
 *    streak, an invalid document between two valid ones does not
 *    (it is not a completed run's verdict), and a truncated tail is
 *    stated as a lower bound.
 *  - The evidence carries no repository dimension — it describes
 *    this install's model radar and inbox. Items therefore emit
 *    only when the backlog target's repository name is 'phantom',
 *    the same last-segment rule the sibling fleet-evidence sources
 *    apply.
 *  - Dedup is downstream. Each id embeds a stable hash of the
 *    cell's kind and key (never counts or measurements), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; shifted tallies do not spawn twin items and
 *    a recovered axis stops emitting.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, provider keys and the writer's
 *    bounded note/error strings pass through the scrub-and-cap
 *    rule, absolute paths and vendor details stay out of the item
 *    (the journal path, the sources table and the inbox dir are
 *    named instead), and the brief names `phm models radar`, the
 *    journal and the sibling model-radar/catalog feeds — with the
 *    usual no-change escape when the streak has rolled forward or
 *    the cause is owner-side.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the axes are one registry cell, one proposals cell and per-provider cells. */
export const MODEL_RADAR_MAX_ITEMS = 8;
const MODEL_RADAR_ITEM_HARD_MAX = 25;
/**
 * Bounded tail of the journal. Documents run a few KiB each, so
 * 1 MiB covers hundreds of daily runs — far past any streak this
 * feed emits; a contract-violating larger file still folds its
 * newest documents flagged as a lower bound.
 */
export const MODEL_RADAR_TAIL_BYTES = 1024 * 1024;
/** Consecutive valid reports an adverse verdict needs before it counts as recurring. */
export const MODEL_RADAR_MIN_RUNS = 3;
/** The fleet's own repository label: radar evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** The report's error field is a writer constant; cap defensively anyway. */
const ERROR_MAX = 300;
/** The writer's doc-state vocabulary (ModelRadarProvider.doc in src/core/fleet/model-radar.ts). */
const DOC_VOCABULARY = new Set(['read', 'empty', 'unknown']);
/** The writer's lane-notice status vocabulary (ModelRadarReport.lane_notices). */
const LANE_STATUS_VOCABULARY = new Set(['deprecated', 'retired', 'mentioned']);

export interface ModelRadarRunItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home the journal resolves under (default: os.homedir()); the unit writes <home>/.ashlr/logs/model-radar.jsonl. */
  homeDir?: string;
  /** Journal path override (default: <homeDir>/.ashlr/logs/model-radar.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default MODEL_RADAR_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** One validated providers[] row inside a journaled radar report. */
export interface ModelRadarProviderRow {
  /** The provider key the writer recorded ('anthropic', 'openai', … or a doc-file stem). */
  provider: string;
  doc: 'read' | 'empty' | 'unknown';
  inRegistry: boolean;
  /** The writer's bounded explanation for the doc state, scrubbed and capped; null when absent. */
  note: string | null;
}

/** One validated fetch[] row: a MODEL_RADAR_SOURCES page's save outcome (url validated, never stored). */
export interface ModelRadarFetchRow {
  provider: string;
  saved: boolean;
}

/** One validated model-radar.jsonl document: a completed `phm models radar --json` run's report. */
export interface ModelRadarRunReport {
  /** Whether the run read the verified registry ('ok') or scanned blind ('unknown'). */
  registryOk: boolean;
  ok: boolean;
  /** The writer's error line — one of two contract constants — scrubbed and capped; null when absent. */
  error: string | null;
  providers: ModelRadarProviderRow[];
  /** --fetch save outcomes; null when the run never fetched (the schedule always does). */
  fetch: ModelRadarFetchRow[] | null;
  /** --propose filing counts; null when the report carries no proposals field. */
  proposals: { filed: number; existing: number; failed: number } | null;
  /** Unapplied patch row counts — context for the prompts, never a verdict. */
  patchAdd: number;
  patchRetire: number;
  patchRename: number;
}

/** Journal coverage the prompts state: what the bounded read and document parse actually saw. */
export interface ModelRadarCoverage {
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

/**
 * One recurring adverse cell. Discriminated on kind: 'registry' and
 * 'proposals' are report-level singletons keyed by fixed labels;
 * 'fetch' and 'doc' are per-provider cells keyed by the provider id.
 */
export type ModelRadarCell =
  | {
      kind: 'registry';
      key: 'registry';
      /** Consecutive newest valid reports with registry:'unknown'. */
      runs: number;
      /** The newest streak report's writer error line. */
      error: string | null;
    }
  | {
      kind: 'proposals';
      key: 'proposals';
      /** Consecutive newest valid reports with proposals.failed > 0. */
      runs: number;
      /** The newest streak report's filing counts, quoted as recorded. */
      failed: number;
      filed: number;
      existing: number;
    }
  | {
      kind: 'fetch';
      key: string;
      /** Consecutive newest valid reports where every recorded page for the provider failed to save. */
      runs: number;
      /** The newest streak report's page count for the provider (failed === total inside the streak). */
      pages: number;
      /** The provider's doc state on the newest streak report — 'read' means a stale copy still parses. */
      doc: 'read' | 'empty' | 'unknown' | null;
    }
  | {
      kind: 'doc';
      key: string;
      /** Consecutive newest registry-readable reports with the provider's doc not 'read'. */
      runs: number;
      doc: 'empty' | 'unknown';
      /** Whether the provider has verified-registry rows (context only). */
      inRegistry: boolean;
      /** The newest streak report's writer note for the doc state. */
      note: string | null;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A non-negative safe integer, the shape every recorded count takes. */
function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A bounded non-empty string, scrubbed, printable-only, flattened and capped — journal text is untrusted. */
function fieldText(value: unknown, max = FIELD_MAX): string {
  if (typeof value !== 'string') return '';
  return scrubSecrets(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Pure: validate one parsed model-radar.jsonl document against the
 * shape runModelRadar returns and the CLI prints — the
 * models.radar.v1 envelope, the providers[]/fetch[]/lane_notices[]
 * row contracts, the models.registry-patch.v1 envelope and the
 * optional proposals counts. Anything else is not a journal
 * document.
 */
export function parseModelRadarReportDoc(value: unknown): ModelRadarRunReport | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== 'models.radar.v1' || value['version'] !== 1) return null;
  const registry = value['registry'];
  if (registry !== 'ok' && registry !== 'unknown') return null;
  const ok = value['ok'];
  if (typeof ok !== 'boolean') return null;
  const routerChoices = value['router_choices'];
  if (routerChoices !== 'ok' && routerChoices !== 'unknown') return null;
  const summary = value['summary'];
  if (typeof summary !== 'string') return null;
  const from = value['from'];
  if (from !== null && typeof from !== 'string') return null;
  const error = value['error'];
  if (error !== null && typeof error !== 'string') return null;
  for (const key of ['new_models', 'retired_models', 'renamed'] as const) {
    if (!Array.isArray(value[key])) return null;
  }
  if (!nonNegativeInt(value['unchanged_count'])) return null;
  const rawProviders = value['providers'];
  if (!Array.isArray(rawProviders)) return null;
  const providers: ModelRadarProviderRow[] = [];
  for (const raw of rawProviders) {
    if (!isRecord(raw)) return null;
    const provider = fieldText(raw['provider'], 128);
    if (provider === '') return null;
    const doc = raw['doc'];
    if (typeof doc !== 'string' || !DOC_VOCABULARY.has(doc)) return null;
    const inRegistry = raw['in_registry'];
    if (typeof inRegistry !== 'boolean') return null;
    const docSite = raw['doc_site'];
    if (docSite !== null && typeof docSite !== 'string') return null;
    const note = raw['note'];
    if (note !== null && typeof note !== 'string') return null;
    const noteText = note === null ? '' : fieldText(note);
    providers.push({
      provider,
      doc: doc as 'read' | 'empty' | 'unknown',
      inRegistry,
      note: noteText === '' ? null : noteText,
    });
  }
  const patch = value['patch'];
  if (!isRecord(patch)) return null;
  if (patch['schema'] !== 'models.registry-patch.v1' || patch['version'] !== 1 || patch['applied'] !== false) return null;
  const patchCounts: number[] = [];
  for (const key of ['add', 'retire', 'rename'] as const) {
    const rows = patch[key];
    if (!Array.isArray(rows)) return null;
    patchCounts.push(rows.length);
  }
  const rawFetch = value['fetch'];
  let fetch: ModelRadarFetchRow[] | null = null;
  if (rawFetch !== null) {
    if (!Array.isArray(rawFetch)) return null;
    fetch = [];
    for (const raw of rawFetch) {
      if (!isRecord(raw)) return null;
      const provider = fieldText(raw['provider'], 128);
      const url = raw['url'];
      const saved = raw['saved'];
      if (provider === '' || typeof url !== 'string' || typeof saved !== 'boolean') return null;
      fetch.push({ provider, saved });
    }
  }
  const laneNotices = value['lane_notices'];
  if (!Array.isArray(laneNotices)) return null;
  for (const raw of laneNotices) {
    if (!isRecord(raw)) return null;
    if (typeof raw['lane'] !== 'string' || typeof raw['id'] !== 'string') return null;
    const status = raw['status'];
    if (typeof status !== 'string' || !LANE_STATUS_VOCABULARY.has(status)) return null;
    const replacement = raw['replacement'];
    if (replacement !== null && typeof replacement !== 'string') return null;
  }
  let proposals: { filed: number; existing: number; failed: number } | null = null;
  const rawProposals = value['proposals'];
  if (rawProposals !== undefined) {
    if (!isRecord(rawProposals)) return null;
    const filed = rawProposals['filed'];
    const existing = rawProposals['existing'];
    const failed = rawProposals['failed'];
    if (!Array.isArray(filed) || !filed.every((id) => typeof id === 'string')) return null;
    if (!Array.isArray(existing) || !existing.every((id) => typeof id === 'string')) return null;
    if (!nonNegativeInt(failed)) return null;
    proposals = { filed: filed.length, existing: existing.length, failed };
  }
  const errorText = error === null ? '' : fieldText(error, ERROR_MAX);
  return {
    registryOk: registry === 'ok',
    ok,
    error: errorText === '' ? null : errorText,
    providers,
    fetch,
    proposals,
    patchAdd: patchCounts[0]!,
    patchRetire: patchCounts[1]!,
    patchRename: patchCounts[2]!,
  };
}

/**
 * Pure: parse one model-radar.jsonl file's text into validated run
 * reports plus coverage. Documents are delimited by column-0 braces
 * — the writer's JSON.stringify(report, null, 2) framing — so a
 * column-0 `{` opens a document and a column-0 `}` closes it; a
 * column-0 `{` inside an open document abandons it
 * (abandonedDocs), an unterminated tail fragment is openTail, and
 * non-empty lines outside documents are strayLines. Closed
 * documents that fail the report contract count as invalidDocs —
 * never guessed.
 */
export function parseModelRadarJournal(text: string): { runs: ModelRadarRunReport[]; coverage: Omit<ModelRadarCoverage, 'truncated' | 'sourceState'> } {
  const runs: ModelRadarRunReport[] = [];
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
    const run = parseModelRadarReportDoc(value);
    if (run === null) { invalidDocs += 1; continue; }
    runs.push(run);
  }
  if (buffer !== null) openTail = true;
  return { runs, coverage: { invalidDocs, abandonedDocs, openTail, strayLines } };
}

/** Per-run fetch tallies for one provider: pages recorded and pages that failed to save. */
interface FetchTally { total: number; failed: number }

/**
 * Pure: fold validated run reports into per-axis consecutive
 * adverse streaks. Each axis scans newest-to-oldest and stops at
 * the first run that does not carry the verdict:
 *
 *  - registry: adverse while registryOk is false — the report-level
 *    singleton.
 *  - proposals: adverse while the run recorded proposals with
 *    failed > 0; a report without the field is unmeasured and
 *    breaks the streak.
 *  - fetch:<provider>: adverse while the run's fetch[] recorded at
 *    least one page for the provider and every one of them failed
 *    to save; a fetch-less report or a provider absent from the
 *    fetch results is unmeasured and breaks the streak.
 *  - doc:<provider>: adverse while a registry-readable run's
 *    providers[] row for the provider recorded doc !== 'read'; a
 *    registry-outage run measured no docs at all (the empty scan
 *    writes doc:'unknown' for every provider by construction), a
 *    missing row or a 'read' verdict breaks the streak.
 *
 * Invalid documents never enter the sequence at all (they are not
 * a completed run's verdict). Cells sort by streak length desc,
 * then axis order (registry, proposals, fetch, doc), then key.
 */
export function foldModelRadarEvidence(runs: readonly ModelRadarRunReport[]): ModelRadarCell[] {
  const cells: ModelRadarCell[] = [];

  // Registry: the report-level singleton.
  let registryRuns = 0;
  let registryError: string | null = null;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]!;
    if (run.registryOk) break;
    registryRuns += 1;
    if (registryError === null) registryError = run.error;
  }
  if (registryRuns > 0) {
    cells.push({ kind: 'registry', key: 'registry', runs: registryRuns, error: registryError });
  }

  // Proposals: the report-level singleton.
  let proposalRuns = 0;
  let proposalFailed = 0;
  let proposalFiled = 0;
  let proposalExisting = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]!;
    if (run.proposals === null || run.proposals.failed === 0) break;
    proposalRuns += 1;
    if (proposalRuns === 1) {
      proposalFailed = run.proposals.failed;
      proposalFiled = run.proposals.filed;
      proposalExisting = run.proposals.existing;
    }
  }
  if (proposalRuns > 0) {
    cells.push({
      kind: 'proposals', key: 'proposals', runs: proposalRuns,
      failed: proposalFailed, filed: proposalFiled, existing: proposalExisting,
    });
  }

  // Fetch and doc: per-provider cells. Precompute each run's maps.
  const fetchMaps = runs.map((run) => {
    const map = new Map<string, FetchTally>();
    if (run.fetch === null) return null;
    for (const row of run.fetch) {
      const tally = map.get(row.provider) ?? { total: 0, failed: 0 };
      tally.total += 1;
      if (!row.saved) tally.failed += 1;
      map.set(row.provider, tally);
    }
    return map;
  });
  const docMaps = runs.map((run) => {
    // A registry-outage run's providers[] is the empty scan's
    // construction — every row doc:'unknown' without a file ever
    // being read — so it measures nothing for this axis.
    if (!run.registryOk) return null;
    return new Map(run.providers.map((row) => [row.provider, row]));
  });
  const providerKeys = new Set<string>();
  for (const map of fetchMaps) if (map !== null) for (const key of map.keys()) providerKeys.add(key);
  for (const map of docMaps) if (map !== null) for (const key of map.keys()) providerKeys.add(key);

  for (const key of providerKeys) {
    // Fetch streak: every recorded page failed to save.
    let fetchRuns = 0;
    let fetchPages = 0;
    let fetchDoc: 'read' | 'empty' | 'unknown' | null = null;
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const map = fetchMaps[i];
      const tally = map?.get(key);
      if (map === null || tally === undefined || tally.total === 0 || tally.failed !== tally.total) break;
      fetchRuns += 1;
      if (fetchRuns === 1) {
        fetchPages = tally.total;
        const docRow = docMaps[i]?.get(key);
        fetchDoc = docRow === undefined ? null : docRow.doc;
      }
    }
    if (fetchRuns > 0) {
      cells.push({ kind: 'fetch', key, runs: fetchRuns, pages: fetchPages, doc: fetchDoc });
    }

    // Doc streak: registry-readable runs reporting the provider not 'read'.
    let docRuns = 0;
    let docState: 'empty' | 'unknown' = 'unknown';
    let docInRegistry = false;
    let docNote: string | null = null;
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const map = docMaps[i];
      const row = map?.get(key);
      if (map === null || row === undefined || row.doc === 'read') break;
      docRuns += 1;
      if (docRuns === 1) {
        docState = row.doc === 'empty' ? 'empty' : 'unknown';
        docInRegistry = row.inRegistry;
        docNote = row.note;
      }
    }
    if (docRuns > 0) {
      cells.push({ kind: 'doc', key, runs: docRuns, doc: docState, inRegistry: docInRegistry, note: docNote });
    }
  }

  const order = { registry: 0, proposals: 1, fetch: 2, doc: 3 } as const;
  return cells.sort((a, b) => b.runs - a.runs || order[a.kind] - order[b.kind] || a.key.localeCompare(b.key));
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Id-safe fragment: backlog ids admit [A-Za-z0-9._-] only and cap at 120 chars total. */
const idSafe = (value: string, cap: number): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, cap) || 'unknown';

function coverageNote(coverage: ModelRadarCoverage): string {
  const parts: string[] = [];
  if (coverage.invalidDocs > 0) parts.push(`${coverage.invalidDocs} document(s) failed the report contract and were not counted`);
  if (coverage.abandonedDocs > 0) parts.push(`${coverage.abandonedDocs} document(s) were abandoned mid-write`);
  if (coverage.openTail) parts.push('the tail ends inside an unterminated document');
  if (coverage.strayLines > 0) parts.push(`${coverage.strayLines} non-document line(s) between reports`);
  if (coverage.truncated) parts.push('the bounded tail cut older documents, so counts are a lower bound');
  if (coverage.sourceState !== 'read') parts.push(`the journal read state was '${coverage.sourceState}'`);
  return parts.length === 0 ? '' : ` Journal coverage: ${parts.join('; ')}.`;
}

const EVIDENCE = 'The evidence is ~/.ashlr/logs/model-radar.jsonl under the user\'s home — the stdout+stderr sink modelRadarSchedule (src/core/fleet/model-radar-schedule.ts) gives the daily `phm models radar --fetch --propose --json` unit (launchd ai.ashlr.phm.model-radar / systemd phm-model-radar.{service,timer}), one pretty-printed models.radar.v1 report per completed run. runModelRadar (src/core/fleet/model-radar.ts) reads the saved provider release-note pages under $ASHLR_HOME/model-radar, diffs them against the verified registry through loadVerifiedRegistry (src/core/fleet/model-verify.ts — docs/model-registry.json plus the machine\'s verification overlay), and reports per-provider doc state, the --fetch save results, the unapplied registry patch and the --propose inbox filing counts. Documents carry no timestamp, so this feed counts consecutive recorded runs, never days. Until now the journal\'s only reader was the log file itself — modelRadarBacklogItems folds the pending inbox notes the --propose step files, never the run journal, and catalog-refresh-backlog folds the weekly router catalog probes, a different machinery path — so a radar that kept failing before it could file left no folded evidence anywhere.';

const NO_CHANGE = 'If the newest `phm models radar --json` run shows the axis recovered — registry:\'ok\', every recorded page saved, the provider\'s doc \'read\', or proposals.failed back at zero — the streak was a bounded outage the later runs recovered from, the source table, registry, folder or inbox store was already fixed, the scheduled unit was uninstalled or retimed, or the cause is owner-side or pinned ops machinery — report no-change and name the evidence.';

function registryPrompt(cell: Extract<ModelRadarCell, { kind: 'registry' }>, coverage: ModelRadarCoverage): string {
  const errorText = cell.error === null ? '' : ` The writer's error line: '${cell.error}'.`;
  return [
    `Phantom's scheduled model radar could not read the verified model registry on ${cell.runs} consecutive recorded runs — the self-improvement work this backlog exists for.`,
    '',
    `Each document is one completed \`phm models radar --fetch --propose --json\` run's models.radar.v1 report. registry:'unknown' means loadVerifiedRegistry (src/core/fleet/model-verify.ts) threw, so the run scanned against an empty registry and compared nothing — every provider row reads doc:'unknown' by construction on those runs, not by measurement, and this feed counts them as unmeasured for the per-provider axes.${errorText}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why the registry load keeps failing: loadVerifiedRegistry reads docs/model-registry.json plus the machine's $ASHLR_HOME/model-registry.json verification overlay — check whether the shipped registry or the overlay is missing, unreadable or off-schema, whether a recent registry shape change broke the loader, and whether the failure is the file or the parse. Reproduce with \`phm models radar --json\` — the report's registry field and error line name the same verdict — and the journal tail; the sibling model-radar-backlog items carry the inbox-note side (starved while the radar is blind) and catalog-refresh-backlog the weekly catalog probes. Fix what lives in this repository — the loader, the registry schema or the shipped data; if the overlay is owner-side state, pinned ops machinery or the unit was uninstalled — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function proposalsPrompt(cell: Extract<ModelRadarCell, { kind: 'proposals' }>, coverage: ModelRadarCoverage): string {
  return [
    `Phantom's scheduled model radar keeps finding registry candidates it cannot file — proposals.failed stayed above zero on ${cell.runs} consecutive recorded runs — the self-improvement work this backlog exists for.`,
    '',
    `Each document is one completed \`phm models radar --fetch --propose --json\` run's models.radar.v1 report. The --propose step files one pending '[model radar] Review …' inbox note per fresh high-confidence addition through fileModelRadarProposals (src/core/fleet/model-radar-proposals.ts); the newest streak report recorded failed:${cell.failed} with ${cell.filed} filed and ${cell.existing} already present — candidates the radar detected never reached the inbox, so the sibling modelRadarBacklogItems fold starves even though the scan itself works.${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why proposal filing keeps failing: fileModelRadarProposals calls createProposal (src/core/inbox/store.ts) once per candidate and counts a non-'pending' result as failed — check the inbox dir ($ASHLR_HOME/inbox) is writable, the proposal status vocabulary still matches, and whether the dedupe-by-title path is swallowing or rejecting rows (existing counts show what dedupe already absorbed). Reproduce with \`phm models radar --fetch --propose --json\` and the journal tail; the sibling model-radar-backlog items carry the notes that did land. Fix what lives in this repository — the filer, the store contract or the dedupe key; if the inbox store is owner-side state or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function fetchPrompt(cell: Extract<ModelRadarCell, { kind: 'fetch' }>, coverage: ModelRadarCoverage): string {
  const docText = cell.doc === null
    ? ''
    : cell.doc === 'read'
      ? ' The provider\'s doc still reads \'read\' — a stale saved copy keeps parsing, so the blindness is silent.'
      : ` The provider's doc reads '${cell.doc}' — no readable notes at all.`;
  return [
    `Phantom's scheduled model radar could not save any release-notes page for '${cell.key}' on ${cell.runs} consecutive recorded runs — the self-improvement work this backlog exists for.`,
    '',
    `Each document is one completed \`phm models radar --fetch --propose --json\` run's models.radar.v1 report; its fetch[] records one {provider,url,saved} row per MODEL_RADAR_SOURCES page (src/core/fleet/model-radar-fetch.ts). On every run in the streak all ${cell.pages} recorded page(s) for '${cell.key}' came back saved:false — the provider's release notes never refresh.${docText}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why every '${cell.key}' source page fails to save: check MODEL_RADAR_SOURCES' urls for '${cell.key}' — a moved or renamed page 404s forever, a host that started bot-walling refuses the bounded public GET in src/core/radar/fetch.ts, and a source-table entry that was never live fails from day one. Check whether the sibling doc-axis item for the same provider is also firing (no readable notes at all) and whether other providers' pages still save (a whole-fetch outage looks different from one provider's dead sources). Reproduce with \`phm models radar --fetch --json\` and the journal tail; the sibling model-radar-backlog items carry the inbox-note side and catalog-refresh-backlog the weekly catalog probes. Fix what lives in this repository — the source table's urls, the fetch bounds or the saved-notes folder; if the provider retired its pages or the cause is owner-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function docPrompt(cell: Extract<ModelRadarCell, { kind: 'doc' }>, coverage: ModelRadarCoverage): string {
  const noteText = cell.note === null ? '' : ` The writer's note: '${cell.note}'.`;
  const registryText = cell.inRegistry ? ' The provider has verified-registry rows, so the radar silence hides real models.' : '';
  return [
    `Phantom's scheduled model radar has had no readable release notes for '${cell.key}' on ${cell.runs} consecutive recorded runs — the self-improvement work this backlog exists for.`,
    '',
    `Each document is one completed \`phm models radar --fetch --propose --json\` run's models.radar.v1 report. On every registry-readable run in the streak the providers[] row for '${cell.key}' recorded doc:'${cell.doc}' — 'unknown' means no saved file, an unreadable one, or a provider with no id table; 'empty' means a saved file with no text.${noteText}${registryText}${coverageNote(coverage)}`,
    '',
    EVIDENCE,
    '',
    `Find why '${cell.key}'s notes stay unreadable: check the saved-notes folder the report's 'from' field names ($ASHLR_HOME/model-radar by default) — a missing file means the fetch axis's sibling item or a never-live source, an unreadable one is permissions or a torn write, an empty one is a page that answers with no text the parser keeps. Check MODEL_RADAR_PROVIDERS (src/core/fleet/model-radar.ts) has an id-shape rule for the provider — 'unknown' is also the verdict for a provider the radar cannot parse. Registry-outage runs are unmeasured for this axis: a doc:'unknown' inside a registry:'unknown' report is the empty scan's construction, not evidence. Reproduce with \`phm models radar --json\` and the journal tail; the sibling model-radar-backlog items carry the inbox-note side. Fix what lives in this repository — the fetch table, the reader or the id-shape rules; if the provider publishes no machine-readable notes or the cause is owner-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function cellPrompt(cell: ModelRadarCell, coverage: ModelRadarCoverage): string {
  switch (cell.kind) {
    case 'registry': return registryPrompt(cell, coverage);
    case 'proposals': return proposalsPrompt(cell, coverage);
    case 'fetch': return fetchPrompt(cell, coverage);
    case 'doc': return docPrompt(cell, coverage);
  }
}

function cellTitle(cell: ModelRadarCell): string {
  switch (cell.kind) {
    case 'registry': return 'Model radar cannot read the verified registry';
    case 'proposals': return 'Model radar proposals keep failing to file';
    case 'fetch': return `Model radar fetch fails for '${cell.key}'`;
    case 'doc': return `Model radar has no readable notes for '${cell.key}'`;
  }
}

function cellItem(cell: ModelRadarCell, coverage: ModelRadarCoverage, repo: string): CloudBacklogItem {
  // The hash covers the full cell identity (kind + key); the readable
  // fragment is bounded so the id stays inside ID_RE's 120-char cap.
  const hash = createHash('sha256')
    .update(`modelradar-run:${repo.trim().toLowerCase()}:${cell.kind}:${cell.key}`)
    .digest('hex').slice(0, 16);
  const id = cell.kind === 'registry' || cell.kind === 'proposals'
    ? `modelradar-${cell.kind}-${hash}`
    : `modelradar-${cell.kind}-${idSafe(cell.key, 30)}-${hash}`;
  return {
    id,
    title: cellTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, coverage),
    area: 'router-catalog',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the model-radar journal's recurring adverse
 * evidence: registry-outage, all-pages-failed fetch, unreadable
 * notes and unfiled-proposal streaks across the newest
 * MODEL_RADAR_MIN_RUNS consecutive valid reports per axis. Total:
 * any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function modelRadarRunBacklogItems(opts: ModelRadarRunItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath ?? join(home, '.ashlr', 'logs', 'model-radar.jsonl');
    const read = await readLedgerTail(journalPath, MODEL_RADAR_TAIL_BYTES);
    // A missing, non-file or unreadable journal is the writer's normal
    // state — the schedule is opt-in --install — and contributes nothing.
    if (read.state !== 'read') return [];
    const parsed = parseModelRadarJournal(read.text);
    if (parsed.runs.length === 0) return [];
    const cells = foldModelRadarEvidence(parsed.runs);
    const coverage: ModelRadarCoverage = {
      ...parsed.coverage,
      truncated: read.truncated,
      sourceState: read.state,
    };
    const items: CloudBacklogItem[] = [];
    for (const cell of cells) {
      if (cell.runs < MODEL_RADAR_MIN_RUNS) break;
      items.push(cellItem(cell, coverage, repo));
      if (items.length >= MODEL_RADAR_MAX_ITEMS) break;
    }
    const limit = Math.max(1, Math.min(opts.limit ?? MODEL_RADAR_MAX_ITEMS, MODEL_RADAR_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
