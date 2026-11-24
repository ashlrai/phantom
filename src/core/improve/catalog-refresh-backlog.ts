/**
 * Router catalog refresh report series recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `phm router catalog refresh` (src/cli/router-catalog.ts) runs
 * refreshCatalog (src/core/routing/catalog-refresh.ts): it probes the
 * configured model sources (Claude/Codex `--help` scans, Devin
 * `models list`, Cursor/Grok `models`, the loopback Ollama tags
 * endpoint, optionally seat discovery), diffs
 * what they report against the hand-maintained pattern table
 * (src/core/run/model-catalog-patterns.ts) and the generated catalog
 * data (src/core/run/model-catalog-data.ts), and writes one
 * `router.catalog-refresh.v1` JSON report plus a review-only patch per
 * run to `<ashlr home>/router/catalog/catalog-refresh-<stamp>.json`.
 * The weekly catalogSchedule unit
 * (src/core/routing/catalog-schedule.ts) installs the recurring pass;
 * manual runs add more. Each report carries the per-source probe
 * statuses, additions/reappeared, the unseen/deprecated/proposedRemovals
 * model lists, the `unknown` list of catalog models no ok source could
 * verify (no owning pattern, or every owning source read unknown), and
 * `rejectedRules` — pattern-table entries that failed validation.
 *
 * Until now the report series had no reader: each run prints its own
 * report to stdout and the artifacts accumulate unread, so a catalog
 * source whose probe kept failing (that provider's models are never
 * discovered, and — because diffCatalog skips unseen marks while an
 * owning source reads unknown — its owned models are never even
 * flagged missing), catalog models that kept failing verification, a
 * rejected pattern rule that silently unassigned its matches every
 * week, and removal proposals that piled up unreviewed (refresh never
 * removes; MODEL_CATALOG_UNSEEN/UNASSIGNED have no consumers, so an
 * unseen model keeps its tier and stays routable) never became work.
 *
 * catalogRefreshBacklogItems carries the same report series into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling evidence feeds beside
 * it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The catalog dir is listed and each candidate report is
 *    tail-read through readTail's bounded no-follow read; nothing is
 *    written and no probe, network or lock is touched. A missing or
 *    unreadable dir yields no items — a host that never ran the refresh
 *    and a healthy catalog look identical to an absent series, and
 *    both correctly emit nothing.
 *  - Reports count only under the writer's contract: schema
 *    'router.catalog-refresh.v1', a parseable generatedAt, a sources
 *    array of {id, status} rows inside the writer's vocabularies, and
 *    unknown/rejectedRules/proposedRemovals arrays of the writer's
 *    entry shapes. Malformed files, foreign shapes and off-contract
 *    entries are skipped or dropped, never guessed; a truncated read
 *    cannot parse and is counted, never folded.
 *  - Recurring means recorded across reports and days. The refresh is
 *    a weekly scheduled pass, so the window is 28 days — four scheduled
 *    observations — not the sibling feeds' 7. A cell emits only when
 *    it appears in at least CATALOG_REFRESH_MIN_REPORTS distinct
 *    in-window reports spanning CATALOG_REFRESH_MIN_DAYS distinct UTC
 *    days: a one-off probe failure or a single bad report stays quiet.
 *  - Still-adverse currency gate. These reports are state snapshots,
 *    not events: the newest in-window report re-states the whole
 *    picture, so a cell emits only while the newest evidence still
 *    shows it — a source whose newest containing report reads 'ok', a
 *    model that left the unknown or proposedRemovals lists, a rule
 *    that left rejectedRules, all resolved and emit nothing. For
 *    sources the check runs against the newest report that probed the
 *    source at all, so an opt-in source (seats) absent from scheduled
 *    reports keeps its last recorded verdict rather than reading as
 *    recovered.
 *  - Fleet machinery only. The reports describe this install's router
 *    catalog and provider CLIs — they carry no repository column — so
 *    items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling feeds apply.
 *  - Dedup is downstream. Item ids key on the cell — source id, or a
 *    hash of the model/rule text — never the counts or timestamps, so
 *    a refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new; a cell that resolves simply stops re-adding.
 *  - Every journal string is untrusted text: source reasons, model
 *    names, rule patterns, unseen-since stamps and holding times are
 *    scrubbed, flattened and capped before they reach a prompt, and
 *    free-text keys are hashed into item ids so raw text never becomes
 *    an identifier.
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readTail } from '../metrics/loop-collect.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is open-ended, so the cap bounds it. */
export const CATALOG_REFRESH_BACKLOG_MAX_ITEMS = 12;
const CATALOG_REFRESH_ITEM_HARD_MAX = 25;
/**
 * Evidence window: 28 days. The refresh is a weekly scheduled pass
 * (catalogSchedule installs Monday units), so four observations is the
 * honest "recurring" bar for this cadence — the sibling feeds' 7-day
 * window would usually hold a single report and could never recur.
 */
export const CATALOG_REFRESH_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on report timestamps, same convention the sibling folds tolerate. */
const CATALOG_REFRESH_FUTURE_SKEW_MS = 60_000;
/** Distinct in-window reports a cell needs before its state counts as recurring. */
export const CATALOG_REFRESH_MIN_REPORTS = 2;
/** Distinct UTC days those reports must span — recurring means across days, not one burst. */
export const CATALOG_REFRESH_MIN_DAYS = 2;
/** Newest report files opened per call; weekly cadence makes 24 ≈ half a year of history. */
const CATALOG_REFRESH_MAX_FILES = 24;
/** Per-report read bound; reports are catalog-sized JSON docs far below this. */
const CATALOG_REFRESH_REPORT_MAX_BYTES = 512 * 1024;
/** Report filename the writer derives from the run timestamp. */
const REPORT_FILE_PATTERN = /^catalog-refresh-.+\.json$/;
/** The report schema the writer stamps on every artifact. */
const REPORT_SCHEMA = 'router.catalog-refresh.v1';
/** Source ids the writer's probes emit; validated before they reach an id or prompt. */
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCE_STATUSES = new Set(['ok', 'unknown']);
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct sample texts quoted inside one prompt before the rest is summarized. */
const PROMPT_SAMPLES_MAX = 4;
/** Model/rule keys are hashed into ids; the raw text is capped for maps and prompts. */
const KEY_MAX = 512;
/** The fleet's own repository label: catalog evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface CatalogRefreshItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Catalog artifact dir holding catalog-refresh-*.json; default <ashlr home>/router/catalog. */
  catalogDir?: string;
  /** Most items one call emits (default CATALOG_REFRESH_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default CATALOG_REFRESH_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const boundedText = (value: unknown, max = KEY_MAX): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;

/** One validated report: the four evidence lists the fold reads, keyed for lookup. */
export interface CatalogRefreshReport {
  generatedAtMs: number;
  utcDay: string;
  /** Source id → probe status, inside the writer's 'ok' | 'unknown' vocabulary. */
  sources: ReadonlyMap<string, string>;
  /** Source id → the recorded failure reason ('' when the writer recorded none). */
  sourceReasons: ReadonlyMap<string, string>;
  /** Catalog model → why it could not be verified ('Owning source unavailable' | 'No owning source pattern' | future reasons). */
  unknownModels: ReadonlyMap<string, string>;
  /** Pattern-table rule → why refresh rejected it. */
  rejectedRules: ReadonlyMap<string, string>;
  /** Catalog model → first-missed stamp, for models past the 90-day removal bar. */
  proposedRemovals: ReadonlyMap<string, string>;
}

function sourceEntries(value: unknown): { id: string; status: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { id: string; status: string; reason: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = boundedText(entry['id'], 40);
    const status = entry['status'];
    if (id === null || !SOURCE_ID_PATTERN.test(id)) continue;
    if (typeof status !== 'string' || !SOURCE_STATUSES.has(status)) continue;
    const reason = entry['reason'];
    out.push({ id, status, reason: typeof reason === 'string' ? reason : '' });
  }
  return out;
}

function reasonEntries(value: unknown, keyField: 'model' | 'rule'): { key: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { key: string; reason: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const key = boundedText(entry[keyField]);
    const reason = entry['reason'];
    if (key === null || typeof reason !== 'string') continue;
    out.push({ key, reason });
  }
  return out;
}

function removalEntries(value: unknown): { key: string; since: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { key: string; since: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const key = boundedText(entry['model']);
    const since = entry['unseenSince'];
    if (key === null || typeof since !== 'string') continue;
    out.push({ key, since });
  }
  return out;
}

/**
 * Pure: validate one parsed report artifact against the writer's
 * contract — schema stamp, parseable generatedAt, and the four
 * evidence collections as arrays. Off-contract entries inside a valid
 * report are dropped; a report missing a whole collection is not the
 * writer's shape and returns null.
 */
export function parseCatalogRefreshReport(value: unknown): CatalogRefreshReport | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== REPORT_SCHEMA) return null;
  const generatedAt = value['generatedAt'];
  const generatedAtMs = typeof generatedAt === 'string' ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(generatedAtMs)) return null;
  const sourcesRaw = value['sources'];
  const unknownRaw = value['unknown'];
  const rulesRaw = value['rejectedRules'];
  const removalsRaw = value['proposedRemovals'];
  if (!Array.isArray(sourcesRaw) || !Array.isArray(unknownRaw) || !Array.isArray(rulesRaw) || !Array.isArray(removalsRaw)) return null;

  const sources = new Map<string, string>();
  const sourceReasons = new Map<string, string>();
  for (const entry of sourceEntries(sourcesRaw)) {
    // A repeated id keeps its first verdict; the writer never emits dupes.
    if (!sources.has(entry.id)) {
      sources.set(entry.id, entry.status);
      sourceReasons.set(entry.id, entry.reason);
    }
  }
  const unknownModels = new Map<string, string>();
  for (const entry of reasonEntries(unknownRaw, 'model')) if (!unknownModels.has(entry.key)) unknownModels.set(entry.key, entry.reason);
  const rejectedRules = new Map<string, string>();
  for (const entry of reasonEntries(rulesRaw, 'rule')) if (!rejectedRules.has(entry.key)) rejectedRules.set(entry.key, entry.reason);
  const proposedRemovals = new Map<string, string>();
  for (const entry of removalEntries(removalsRaw)) if (!proposedRemovals.has(entry.key)) proposedRemovals.set(entry.key, entry.since);

  return { generatedAtMs, utcDay: utcDayOf(generatedAtMs), sources, sourceReasons, unknownModels, rejectedRules, proposedRemovals };
}

type CellKind = 'source-unknown' | 'model-unknown' | 'rule-rejected' | 'removal-proposed';

/** One evidence cell's recurring tally across the in-window reports. */
interface CatalogCell {
  kind: CellKind;
  /** Stable cell key: dedupes the fold and orders the emission. */
  key: string;
  /** Distinct in-window reports carrying this cell. */
  reports: number;
  /** Distinct UTC days those reports fall on. */
  days: Set<string>;
  /** Distinct scrubbed sample texts, capped at PROMPT_SAMPLES_MAX. */
  samples: string[];
  /** True when more distinct samples existed than were kept. */
  sampleOverflow: boolean;
  firstAtMs: number;
  lastAtMs: number;
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string | null, max = FIELD_MAX): string {
  if (value === null) return '';
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function cellFor(cells: Map<string, CatalogCell>, kind: CellKind, key: string): CatalogCell {
  const mapKey = `${kind}${key}`;
  let cell = cells.get(mapKey);
  if (cell === undefined) {
    cell = { kind, key, reports: 0, days: new Set(), samples: [], sampleOverflow: false, firstAtMs: Infinity, lastAtMs: -Infinity };
    cells.set(mapKey, cell);
  }
  return cell;
}

/** Each parsed report's maps hold a key at most once, so one touch per report per cell. */
function touch(cell: CatalogCell, report: CatalogRefreshReport): void {
  cell.reports += 1;
  cell.days.add(report.utcDay);
  cell.firstAtMs = Math.min(cell.firstAtMs, report.generatedAtMs);
  cell.lastAtMs = Math.max(cell.lastAtMs, report.generatedAtMs);
}

function addSample(cell: CatalogCell, text: string): void {
  const cleaned = fieldText(text);
  if (cleaned === '') return;
  if (cell.samples.includes(cleaned)) return;
  if (cell.samples.length >= PROMPT_SAMPLES_MAX) { cell.sampleOverflow = true; return; }
  cell.samples.push(cleaned);
}

/**
 * Pure: fold validated in-window reports (ascending generatedAt) into
 * per-cell tallies plus the still-adverse verdict against the newest
 * report. Returns recurring cells only — a cell needs
 * CATALOG_REFRESH_MIN_REPORTS distinct reports across
 * CATALOG_REFRESH_MIN_DAYS distinct UTC days AND must still be adverse
 * in the newest evidence: for sources, the newest in-window report
 * that probed the id at all must still read 'unknown'; for the list
 * kinds, the newest in-window report's corresponding list must still
 * carry the key.
 */
export function foldCatalogRefreshEvidence(
  input: readonly CatalogRefreshReport[],
): { cells: CatalogCell[]; reports: number } {
  const reports = [...input].sort((a, b) => a.generatedAtMs - b.generatedAtMs || a.utcDay.localeCompare(b.utcDay));
  const cells = new Map<string, CatalogCell>();
  for (const report of reports) {
    for (const [id, status] of report.sources) {
      if (status !== 'unknown') continue;
      const cell = cellFor(cells, 'source-unknown', id);
      touch(cell, report);
      addSample(cell, report.sourceReasons.get(id) ?? 'no reason recorded');
    }
    for (const [model, reason] of report.unknownModels) {
      const cell = cellFor(cells, 'model-unknown', model);
      touch(cell, report);
      addSample(cell, reason);
    }
    for (const [rule, reason] of report.rejectedRules) {
      const cell = cellFor(cells, 'rule-rejected', rule);
      touch(cell, report);
      addSample(cell, reason);
    }
    for (const [model, since] of report.proposedRemovals) {
      const cell = cellFor(cells, 'removal-proposed', model);
      touch(cell, report);
      addSample(cell, `unseen since ${since}`);
    }
  }
  if (reports.length === 0) return { cells: [], reports: 0 };
  const newest = reports[reports.length - 1]!;
  const recurring = [...cells.values()].filter((cell) => {
    if (cell.reports < CATALOG_REFRESH_MIN_REPORTS || cell.days.size < CATALOG_REFRESH_MIN_DAYS) return false;
    return stillAdverse(cell, reports, newest);
  });
  recurring.sort((a, b) => b.reports - a.reports || b.days.size - a.days.size || a.key.localeCompare(b.key));
  return { cells: recurring, reports: reports.length };
}

/**
 * The currency gate: is the cell's adverse state still what the newest
 * evidence says? List kinds check the newest report's own list (a
 * resolved entry simply drops off); source kinds check the newest
 * in-window report that probed the source — an opt-in source absent
 * from later reports keeps its last recorded verdict.
 */
function stillAdverse(cell: CatalogCell, reports: readonly CatalogRefreshReport[], newest: CatalogRefreshReport): boolean {
  switch (cell.kind) {
    case 'source-unknown': {
      for (let i = reports.length - 1; i >= 0; i--) {
        const status = reports[i]!.sources.get(cell.key);
        if (status !== undefined) return status === 'unknown';
      }
      return false;
    }
    case 'model-unknown': return newest.unknownModels.has(cell.key);
    case 'rule-rejected': return newest.rejectedRules.has(cell.key);
    case 'removal-proposed': return newest.proposedRemovals.has(cell.key);
  }
}

/** The evidence pointers every prompt shares; the artifact dir, the writer and its only surface are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is router/catalog/catalog-refresh-<stamp>.json under the Phantom state directory (~/.ashlr or $ASHLR_HOME), one router.catalog-refresh.v1 report per `phm router catalog refresh` run appended by refreshCatalog in src/core/routing/catalog-refresh.ts — the weekly catalogSchedule unit (src/core/routing/catalog-schedule.ts) plus manual runs — carrying per-source probe statuses, additions/reappeared, the unseen/deprecated/proposedRemovals lists, the unknown list and rejectedRules. Each run prints only its own report; nothing else folds the series, and refresh never applies removals.';

const NO_CHANGE = 'If the window has rolled forward, the newest report shows the source healthy or the model/rule/removal resolved, the probe failure is a missing or moved CLI, credential or host state only the owner can fix, or the catalog data itself is pinned ops machinery — report no-change and name the evidence.';

function spanText(firstAtMs: number, lastAtMs: number): string {
  if (!Number.isFinite(firstAtMs) || !Number.isFinite(lastAtMs)) return '';
  const first = new Date(firstAtMs).toISOString();
  const last = new Date(lastAtMs).toISOString();
  return first === last ? ` First recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(unreadReports: number, invalidReports: number, unreadableReports: number): string {
  const notes: string[] = [];
  if (unreadReports > 0) notes.push(`${unreadReports} older report files past the read bound not opened`);
  if (invalidReports > 0) notes.push(`${invalidReports} malformed or off-contract reports dropped`);
  if (unreadableReports > 0) notes.push(`${unreadableReports} report files unreadable`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function samplesText(cell: CatalogCell): string {
  if (cell.samples.length === 0) return 'no sample texts were recorded';
  const joined = cell.samples.map((s) => `'${s}'`).join(', ');
  return cell.sampleOverflow ? `${joined}, and more` : joined;
}

function cellCounts(cell: CatalogCell, reportTotal: number): string {
  return `${cell.reports} of ${reportTotal} in-window reports across ${cell.days.size} UTC days`;
}

function sourcePrompt(cell: CatalogCell, reportTotal: number, coverage: string): string {
  const id = fieldText(cell.key, 40) || 'unknown';
  return [
    `Phantom's router catalog source '${id}' keeps reporting unknown — ${cellCounts(cell, reportTotal)} inside the window probed it and got no model list, the self-improvement work this backlog exists for.`,
    '',
    `Every catalog refresh probes the configured sources (src/core/routing/catalog-sources.ts: claude/codex --help scans, devin models list, cursor-agent/grok models, the loopback Ollama /api/tags endpoint; --include-seats adds seat discovery) and records status 'ok' with the discovered models or 'unknown' on a missing CLI, timeout, nonzero exit, empty or unparseable response. While a source reads unknown its models are never discovered — and because diffCatalog only marks catalog models unseen when every owning source succeeded, its owned models are not even flagged missing, so the catalog rots silently in both directions.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded reasons: ${samplesText(cell)}.${coverage}`,
    '',
    EVIDENCE,
    '',
    `Find why the probe keeps failing: run the source's own command by hand (the spec table in src/core/routing/catalog-sources.ts names the binary and args) — a renamed or moved CLI, a changed --help/model-listing format the extract regex no longer matches, a hung or slow endpoint past the 10s timeout, or Ollama down on 127.0.0.1:11434. Fix the source spec, the extract pattern or the owning-source lists in src/core/run/model-catalog-patterns.ts in this repo; a missing login, billing or host-side outage is owner-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function modelPrompt(cell: CatalogCell, reportTotal: number, coverage: string): string {
  const model = fieldText(cell.key, 120) || 'unknown';
  return [
    `Phantom's catalog model '${model}' keeps failing catalog verification — ${cellCounts(cell, reportTotal)} inside the window listed it under unknown, the self-improvement work this backlog exists for.`,
    '',
    `diffCatalog puts a catalog model (a MODEL_MODE_TIERS or MODEL_CATALOG_UNASSIGNED entry) on the unknown list when no ok source reports it AND either no pattern in src/core/run/model-catalog-patterns.ts owns it ('No owning source pattern' — it can never be auto-tiered or verified) or a pattern owns it but at least one owning source stayed unavailable ('Owning source unavailable' — unverifiable while that probe is down). Either way the entry's tier stands and the router can still pick it: nothing consumes MODEL_CATALOG_UNSEEN, so an unverifiable model is silently routable.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded reasons: ${samplesText(cell)}.${coverage}`,
    '',
    EVIDENCE,
    '',
    `Find which side is wrong: if the reason is 'No owning source pattern', add or fix the owning rule in src/core/run/model-catalog-patterns.ts or remove the stale catalog entry; if 'Owning source unavailable', the fix is the source probe (see the source-unknown items) — the model may be fine. Before removing anything, verify against the live sources that the model really is gone: the scan extractors are heuristic and a CLI help redesign can make a whole provider's models look unseen at once. ${NO_CHANGE}`,
  ].join('\n');
}

function rulePrompt(cell: CatalogCell, reportTotal: number, coverage: string): string {
  const rule = fieldText(cell.key, 160) || 'unknown';
  return [
    `Phantom's catalog pattern rule '${rule}' keeps being rejected by refresh — ${cellCounts(cell, reportTotal)} inside the window listed it under rejectedRules, the self-improvement work this backlog exists for.`,
    '',
    `diffCatalog validates every entry of MODEL_CATALOG_PATTERNS (src/core/run/model-catalog-patterns.ts) on each run: the pattern must compile as a RegExp, sources must be a non-empty string list, and only tier 'lite' or 'normal' may be auto-assigned — anything else lands in rejectedRules and the rule is dropped for that run, so models it should match fall through to 'unassigned' and route nowhere. The rejection is deterministic: the same entry fails every report until the file is fixed.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded reasons: ${samplesText(cell)}.${coverage}`,
    '',
    EVIDENCE,
    '',
    `Fix the entry in src/core/run/model-catalog-patterns.ts: repair the regex, name real source ids, or drop/adjust the tier — 'ultra', 'fusion' and unknown tiers are deliberately rejected because only lite and normal auto-assign. Check test coverage around the pattern table before editing; a rule rejected for an invalid regex may also indicate the pattern was hand-edited into a shape the validator never intended. ${NO_CHANGE}`,
  ].join('\n');
}

function removalPrompt(cell: CatalogCell, reportTotal: number, coverage: string): string {
  const model = fieldText(cell.key, 120) || 'unknown';
  return [
    `Phantom's catalog model '${model}' sits proposed for removal unreviewed — ${cellCounts(cell, reportTotal)} inside the window listed it under proposedRemovals, the self-improvement work this backlog exists for.`,
    '',
    `A catalog model lands on proposedRemovals after its unseenSince mark passes 90 days: every owning source succeeded and none reported it. Refresh is review-only — it never removes models, not even under --apply — and MODEL_CATALOG_UNSEEN/UNASSIGNED have no consumers, so the entry keeps its tier in MODEL_MODE_TIERS and stays routable while every ok source omits it. Deprecations (30 days) are the earlier warning; proposedRemovals is the bar this feed reads.${spanText(cell.firstAtMs, cell.lastAtMs)} Recorded marks: ${samplesText(cell)}.${coverage}`,
    '',
    EVIDENCE,
    '',
    `Decide the model's fate in this repo: verify against the live sources that it really is gone (the extract regexes are heuristic — a provider help redesign can mass-mark models unseen), then remove the entry from the catalog data or fix the owning-source pattern that should have kept it visible. If the model is intentionally kept (alias, historical lookup), say so in the report — there is no keep-list today, so a still-needed entry will keep re-earning this item. ${NO_CHANGE}`,
  ].join('\n');
}

function cellSlug(cell: CatalogCell): string {
  switch (cell.kind) {
    case 'source-unknown': return `source-${cell.key}`;
    case 'model-unknown': return `model-${createHash('sha256').update(cell.key).digest('hex').slice(0, 12)}`;
    case 'rule-rejected': return `rule-${createHash('sha256').update(cell.key).digest('hex').slice(0, 12)}`;
    case 'removal-proposed': return `removal-${createHash('sha256').update(cell.key).digest('hex').slice(0, 12)}`;
  }
}

function cellTitle(cell: CatalogCell): string {
  switch (cell.kind) {
    case 'source-unknown': return `Router catalog source '${fieldText(cell.key, 40)}' keeps reporting unknown`;
    case 'model-unknown': return `Catalog model '${fieldText(cell.key, 120)}' keeps failing catalog verification`;
    case 'rule-rejected': return `Catalog pattern rule '${fieldText(cell.key, 120)}' keeps being rejected by refresh`;
    case 'removal-proposed': return `Catalog model '${fieldText(cell.key, 120)}' sits proposed for removal unreviewed`;
  }
}

function cellPrompt(cell: CatalogCell, reportTotal: number, coverage: string): string {
  switch (cell.kind) {
    case 'source-unknown': return sourcePrompt(cell, reportTotal, coverage);
    case 'model-unknown': return modelPrompt(cell, reportTotal, coverage);
    case 'rule-rejected': return rulePrompt(cell, reportTotal, coverage);
    case 'removal-proposed': return removalPrompt(cell, reportTotal, coverage);
  }
}

function catalogRefreshItem(cell: CatalogCell, reportTotal: number, coverage: string, repo: string): CloudBacklogItem {
  return {
    id: `catrefresh-${cellSlug(cell)}`,
    title: cellTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, reportTotal, coverage),
    area: 'router-catalog',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the catalog refresh report series' recurring
 * adverse evidence. Total: a missing dir, another repository or any
 * read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function catalogRefreshBacklogItems(opts: CatalogRefreshItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const dir = opts.catalogDir ?? join(ashlrHome(), 'router', 'catalog');
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : CATALOG_REFRESH_WINDOW_MS;
    const windowStart = nowMs - windowMs;

    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const candidates = names.filter((name) => REPORT_FILE_PATTERN.test(name)).sort().reverse();
    const files = candidates.slice(0, CATALOG_REFRESH_MAX_FILES);
    const unreadReports = candidates.length - files.length;
    if (files.length === 0) return [];

    const reports: CatalogRefreshReport[] = [];
    let invalidReports = 0;
    let unreadableReports = 0;
    for (const name of files) {
      const tail = await readTail(join(dir, name), CATALOG_REFRESH_REPORT_MAX_BYTES);
      if (tail === null) { unreadableReports += 1; continue; }
      let value: unknown;
      try {
        value = JSON.parse(tail.text);
      } catch {
        invalidReports += 1;
        continue;
      }
      const report = parseCatalogRefreshReport(value);
      if (report === null) { invalidReports += 1; continue; }
      // Only reports inside the evidence window count; future-dated
      // artifacts beyond the skew allowance are untrusted clock noise.
      if (report.generatedAtMs < windowStart || report.generatedAtMs > nowMs + CATALOG_REFRESH_FUTURE_SKEW_MS) continue;
      reports.push(report);
    }
    if (reports.length === 0) return [];

    const folded = foldCatalogRefreshEvidence(reports);
    const coverage = coverageNote(unreadReports, invalidReports, unreadableReports);
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      items.push(catalogRefreshItem(cell, folded.reports, coverage, repo));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? CATALOG_REFRESH_BACKLOG_MAX_ITEMS, CATALOG_REFRESH_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
