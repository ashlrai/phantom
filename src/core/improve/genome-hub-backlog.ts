/**
 * Genome hub journal recurring adverse evidence → self-improvement
 * backlog items.
 *
 * ~/.ashlr/genome/hub.jsonl is Phantom's learned-memory store: an
 * append-only JSONL of GenomeEntry records ({id, project, source:'hub',
 * title, text, tags, ts} — hubStorePath() in src/core/genome/store.ts
 * resolves ~/.ashlr directly under the user's home, deliberately not
 * $ASHLR_HOME). appendHubEntry writes one line per learned note and is
 * called by explicit `phm learn` / the ashlar_learn MCP tool, M26
 * playbook distillation (src/core/learn/playbooks.ts, tags
 * 'm26'+'playbook'), self-improve anti-playbook entries
 * (src/core/fleet/self-improve.ts, 'm235:anti-playbook'), the
 * skill-library legacy skill notes (src/core/fleet/skill-library.ts,
 * 'm243:skill') and — the highest-volume writer — the auto-capture
 * hooks captureFromRun/captureFromSwarm (src/core/genome/capture.ts)
 * invoked on every terminal run/swarm state from
 * src/core/run/orchestrator.ts and src/core/swarm/runner.ts unless
 * cfg.genome.autoCapture === false. Auto-capture tags each row with
 * its kind ('run'|'swarm'), its outcome ('done'|'aborted'|'failed')
 * and optional engine/provider/project/'phases:N' tags; consolidateGenome
 * (src/core/genome/consolidate.ts, manual `phm genome consolidate`,
 * backup-gated) is the only compaction and rewrites merged rows with
 * mergedCount/firstTs/lastTs provenance.
 *
 * Until now the journal's only readers were the recall/playbook/
 * export surfaces themselves — loadHubEntries keeps the NEWEST
 * HUB_MAX_ENTRIES (2000) valid records, so once the append-only log
 * outgrew that window the oldest learned memories silently left every
 * consumer's reach; recall (src/core/genome/recall.ts) injects
 * keyword/embedding hits into future agent context and excludes only
 * the 'm243:skill' and 'm235:anti-playbook' tag classes, so recurring
 * failure captures keep surfacing as "lessons"; and the auto-capture
 * dedupe (isDuplicate in capture.ts) scans only the newest 50
 * same-project entries at Jaccard ≥ 0.72 while every other writer
 * never dedupes at all — so re-recorded lessons, failed-outcome
 * memorization and recall-bound overflow produced evidence only inside
 * an append-only file nobody folded, never work.
 *
 * genomeHubBacklogItems carries the journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling evidence sources beside it.
 *
 * Three evidence axes:
 *
 *  - duplicates: in-window rows grouped by (project, normalized title)
 *    — the same normalization consolidateGenome clusters on — emit
 *    when a cluster reaches GENOME_HUB_RECURRING rows spanning at
 *    least GENOME_HUB_MIN_DAYS distinct UTC days. The capture dedupe
 *    window, the non-capture writers' missing dedupe and the
 *    manual-only consolidation together let the same lesson
 *    accumulate; the live store has already passed the recall bound,
 *    so the debt is real, not hypothetical.
 *  - failures: in-window rows carrying the auto-capture outcome tags
 *    ('run'|'swarm' kind plus 'failed'|'aborted' outcome) emit at the
 *    same recurring bars. Each row is a terminal run/swarm state that
 *    ended badly AND was written into permanent learned memory that
 *    recall can still inject — the genome hub is the only aggregate
 *    journal of the interactive run/swarm path's terminal outcomes.
 *  - oversized: the count of recallable rows (the same four-string-
 *    field bar recallableHubEntryTimestamp/loadHubEntries apply)
 *    emits when it exceeds the 2000-entry recall window — exact when
 *    the bounded reads saw the whole file, stated as a lower bound
 *    when they did not. Past the bound the OLDEST entries are
 *    unreachable by recall, playbook synthesis, export and the
 *    consolidation merge cap, and nothing reported it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readPrivateFileTailCapped
 *    (newest GENOME_HUB_TAIL_BYTES) for the window cells and, only
 *    when that tail truncated, readPrivateFileCapped
 *    (GENOME_HUB_COUNT_BYTES head) for the oversized proof — the same
 *    no-follow regular-file discipline every sibling feed applies.
 *    Nothing is written and no network is touched; a missing or
 *    unreadable file yields no items, a clean empty source.
 *  - Writer-contract validation. A row counts only when id, title,
 *    text and ts are all strings — the exact bar
 *    recallableHubEntryTimestamp and loadHubEntries enforce — so
 *    malformed, foreign or schema-drifted lines are skipped exactly
 *    the way every real reader skips them. Window cells additionally
 *    require a finite Date.parse(ts); rows failing that stay counted
 *    for oversized (they still occupy recall slots) but can never be
 *    quoted as window evidence.
 *  - Recurring, not incidental. Window cells emit only at
 *    GENOME_HUB_RECURRING rows across GENOME_HUB_MIN_DAYS distinct UTC
 *    days inside the 7-day window — the fleet's RECURRING_FAILURES
 *    convention — with the one-minute future-skew tolerance sibling
 *    feeds apply to same-host clock drift.
 *  - Truncated tails are lower bounds. When the tail read cut older
 *    lines, in-window counts cover only the retained rows and the
 *    oversized count is a proven floor (a head count past the bound
 *    still proves the file holds more); prompts say so explicitly.
 *  - Fleet machinery only. The hub describes this install's learned
 *    memory and its project field is a project name, not an
 *    owner/repo coordinate, so items emit only for the fleet's own
 *    repository ('phantom' last-segment match, the sibling feeds'
 *    rule).
 *  - Quoted text is bounded. Entry titles and project names are free
 *    text — goal strings, user notes, model output — so prompts quote
 *    only scrubSecrets'd, length-capped fragments inside a printable
 *    shape check, never raw bodies.
 *  - Dedup is downstream. Item ids hash only the cell identity
 *    (duplicates / failures / oversized — never counts or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; a hub that stops
 *    producing the evidence simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the brief names the journal, the writer
 *    and reader functions, the commands and where the fix surfaces
 *    live, with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readPrivateFileCapped, readPrivateFileTailCapped } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';

/** The evidence window: seven days, the same recurrence window the sibling outcome feeds anchor on. */
export const GENOME_HUB_WINDOW_HOURS = 24 * 7;
/** Rows one cluster/cell needs inside the window before it counts as recurring — the fleet's RECURRING_FAILURES convention. */
export const GENOME_HUB_RECURRING = 3;
/** Distinct UTC days those rows must span. */
export const GENOME_HUB_MIN_DAYS = 2;
/**
 * Future-skew ceiling on entry timestamps, the sibling feeds' one-minute
 * tolerance for same-host clock drift: a row stamped further ahead than
 * the evaluation time is corrupt or replayed evidence and never reaches
 * a cell.
 */
export const GENOME_HUB_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded tail read for the window cells. Hub rows carry up to ~800 chars
 * of summary text plus metadata, so 4 MiB retains on the order of two to
 * four thousand of the newest records — several weeks of active
 * auto-capture — while staying a fixed bound on a file that has already
 * passed sixteen thousand entries in the field.
 */
export const GENOME_HUB_TAIL_BYTES = 4 * 1024 * 1024;
/**
 * Bounded head read used only to prove the oversized verdict when the
 * tail truncated — mirrors HUB_HEALTH_MAX_BYTES in
 * src/core/genome/store.ts so the count covers the same span
 * genomeHubHealth measures.
 */
export const GENOME_HUB_COUNT_BYTES = 8 * 1024 * 1024;
/**
 * The recall/merge window the store keeps: mirrors HUB_MAX_ENTRIES and
 * CONSOLIDATE_MAX_ENTRIES in src/core/genome/store.ts and
 * src/core/genome/consolidate.ts (both private constants — mirrored
 * here with their names so a drift is visible).
 */
export const GENOME_HUB_RECALL_BOUND = 2000;
/** Items one call may emit; the cell set is bounded at three. */
export const GENOME_HUB_MAX_ITEMS = 4;
const GENOME_HUB_ITEM_HARD_MAX = 25;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: hub evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Quoted lesson titles inside prompts: scrubbed, printable-shaped, length-capped. */
const MAX_QUOTED_TITLE_CHARS = 60;
/** Example titles quoted per prompt, most recent first. */
const MAX_EXAMPLES = 3;
/** Duplicate clusters quoted per prompt, largest first. */
const MAX_CLUSTERS = 3;

/** One parsed hub row: the recallable bar plus the window/failure fields the fold needs. */
export interface GenomeHubRow {
  id: string;
  project: string | null;
  title: string;
  text: string;
  tags: string[];
  /** Raw ts string exactly as recorded. */
  ts: string;
  /** Date.parse(ts) when finite; null for stamps no reader could place in time. */
  tsMs: number | null;
  /** Consolidation provenance: >1 when consolidateGenome folded sources into this row. */
  mergedCount: number | null;
}

/**
 * The writer-contract bar, mirroring recallableHubEntryTimestamp and
 * loadHubEntries: id, title, text and ts must all be strings. tags
 * default to [] and project to null exactly the way loadHubEntries
 * coerces them; mergedCount is kept only when it is a number > 1.
 */
export function parseGenomeHubLine(line: string): GenomeHubRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (
    typeof row['id'] !== 'string' ||
    typeof row['title'] !== 'string' ||
    typeof row['text'] !== 'string' ||
    typeof row['ts'] !== 'string'
  ) {
    return null;
  }
  const tsMs = Date.parse(row['ts']);
  const merged = row['mergedCount'];
  return {
    id: row['id'],
    project: typeof row['project'] === 'string' ? row['project'] : null,
    title: row['title'],
    text: row['text'],
    tags: Array.isArray(row['tags'])
      ? (row['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    ts: row['ts'],
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
    mergedCount: typeof merged === 'number' && Number.isFinite(merged) && merged > 1 ? merged : null,
  };
}

/** Parse a bounded file slice into rows; `dropFirst` discards the possibly-torn leading line of a truncated tail. */
function parseHubLines(text: string, dropFirst: boolean): { rows: GenomeHubRow[]; skipped: number } {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  const rows: GenomeHubRow[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = parseGenomeHubLine(line);
    if (row === null) skipped += 1;
    else rows.push(row);
  }
  return { rows, skipped };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** UTC day bucket for the distinct-days recurrence bar. */
function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/**
 * The consolidation grouping key: project bucket plus the title
 * normalization consolidateGenome applies (lowercase, non-alphanumeric
 * to space, whitespace collapsed, trimmed) — the same lesson written by
 * any producer lands in the same cluster.
 */
function lessonKey(row: GenomeHubRow): string | null {
  const normalized = row.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized === '') return null;
  return `${(row.project ?? '').toLowerCase().trim()}::${normalized}`;
}

/** Auto-capture kind tags: 'run' from captureFromRun, 'swarm' from captureFromSwarm. */
const CAPTURE_KINDS: ReadonlySet<string> = new Set(['run', 'swarm']);
/** Auto-capture outcome tags for terminal states that did not succeed. */
const CAPTURE_FAILURES: ReadonlySet<string> = new Set(['failed', 'aborted']);

function isFailureCapture(row: GenomeHubRow): boolean {
  const tags = new Set(row.tags.map((t) => t.trim().toLowerCase()));
  let kind = false;
  let failed = false;
  for (const tag of tags) {
    if (CAPTURE_KINDS.has(tag)) kind = true;
    if (CAPTURE_FAILURES.has(tag)) failed = true;
  }
  return kind && failed;
}

/** A quotable title fragment: printable ASCII-ish, scrubbed, length-capped — free text is never quoted raw. */
function quoteTitle(title: string): string | null {
  const scrubbed = scrubSecrets(title).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (scrubbed === '') return null;
  return scrubbed.length > MAX_QUOTED_TITLE_CHARS ? `${scrubbed.slice(0, MAX_QUOTED_TITLE_CHARS - 1)}…` : scrubbed;
}

interface WindowRow {
  row: GenomeHubRow;
  tsMs: number;
  day: string;
}

/** In-window rows with a placeable timestamp, sorted oldest→newest. */
function windowRows(rows: readonly GenomeHubRow[], sinceMs: number, untilMs: number): WindowRow[] {
  const out: WindowRow[] = [];
  for (const row of rows) {
    if (row.tsMs === null || row.tsMs < sinceMs || row.tsMs > untilMs) continue;
    out.push({ row, tsMs: row.tsMs, day: utcDay(row.tsMs) });
  }
  out.sort((a, b) => a.tsMs - b.tsMs);
  return out;
}

interface RecurringCluster {
  /** Display fragment of the shared normalized lesson title. */
  title: string;
  project: string | null;
  count: number;
  days: number;
  firstSeen: string;
  lastSeen: string;
}

/** The duplicates cell: normalized-lesson clusters at the recurring bars. */
export type GenomeHubDuplicateCluster = RecurringCluster;

export interface GenomeHubCell {
  key: 'duplicates' | 'failures' | 'oversized';
  /** Rows the cell's evidence covers (exact or proven lower bound). */
  count: number;
  /** True when bounded reads could not see the whole journal: counts are floors. */
  lowerBound: boolean;
  /** Window cells: ISO bounds of the qualifying rows' ts stamps. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Duplicates cell: the qualifying clusters, largest first. */
  clusters: GenomeHubDuplicateCluster[];
  /** Failures cell: kind tallies ('run'/'swarm') over the qualifying rows. */
  byKind: { kind: string; count: number }[];
  /** Failures/duplicates context: example quoted titles, newest first. */
  examples: string[];
  /** Oversized cell: total file bytes as recorded by the tail probe. */
  fileBytes: number | null;
  /** Rows carrying consolidation provenance inside the window (context, any cell). */
  consolidatedRows: number;
}

/**
 * Pure: fold parsed hub rows into the emittable cells. `countRows` is the
 * recallable-row set used for the oversized verdict (whole file when the
 * bounded reads saw it all, a proven floor otherwise); `window` rows feed
 * the recurrence cells. Returns only cells that clear their bars — an
 * empty journal or a quiet window yields no cells.
 */
export function foldGenomeHubCells(opts: {
  rows: readonly GenomeHubRow[];
  countRows: readonly GenomeHubRow[] | null;
  /** True when the window tail cut older lines: in-window counts are floors. */
  tailLowerBound: boolean;
  /** True when the oversized count could not see the whole file: the count is a proven floor. */
  countLowerBound: boolean;
  sinceMs: number;
  untilMs: number;
  fileBytes: number | null;
}): GenomeHubCell[] {
  const cells: GenomeHubCell[] = [];
  const inWindow = windowRows(opts.rows, opts.sinceMs, opts.untilMs);
  const consolidatedRows = inWindow.filter(({ row }) => row.mergedCount !== null).length;

  // --- duplicates: same (project, normalized title) re-recorded ---
  const clusters = new Map<string, { project: string | null; title: string; rows: WindowRow[] }>();
  for (const wr of inWindow) {
    const key = lessonKey(wr.row);
    if (key === null) continue;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { project: wr.row.project, title: wr.row.title, rows: [] };
      clusters.set(key, cluster);
    }
    cluster.rows.push(wr);
  }
  const qualifying = [...clusters.values()]
    .map((cluster) => {
      const days = new Set(cluster.rows.map((wr) => wr.day));
      return {
        title: cluster.title,
        project: cluster.project,
        count: cluster.rows.length,
        days: days.size,
        firstSeen: new Date(cluster.rows[0]!.tsMs).toISOString(),
        lastSeen: new Date(cluster.rows[cluster.rows.length - 1]!.tsMs).toISOString(),
      } satisfies RecurringCluster;
    })
    .filter((c) => c.count >= GENOME_HUB_RECURRING && c.days >= GENOME_HUB_MIN_DAYS)
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
  if (qualifying.length > 0) {
    const quoted = qualifying
      .slice(0, MAX_CLUSTERS)
      .map((c) => quoteTitle(c.title))
      .filter((t): t is string => t !== null);
    const firstMs = Math.min(...qualifying.map((c) => Date.parse(c.firstSeen)));
    const lastMs = Math.max(...qualifying.map((c) => Date.parse(c.lastSeen)));
    cells.push({
      key: 'duplicates',
      count: qualifying.reduce((sum, c) => sum + c.count, 0),
      lowerBound: opts.tailLowerBound,
      firstSeen: new Date(firstMs).toISOString(),
      lastSeen: new Date(lastMs).toISOString(),
      clusters: qualifying.slice(0, MAX_CLUSTERS),
      byKind: [],
      examples: quoted,
      fileBytes: opts.fileBytes,
      consolidatedRows,
    });
  }

  // --- failures: recurring failed/aborted auto-captures ---
  const failures = inWindow.filter(({ row }) => isFailureCapture(row));
  if (failures.length >= GENOME_HUB_RECURRING) {
    const days = new Set(failures.map((wr) => wr.day));
    if (days.size >= GENOME_HUB_MIN_DAYS) {
      const kindMap = new Map<string, number>();
      for (const { row } of failures) {
        const kind = row.tags.some((t) => t.trim().toLowerCase() === 'swarm') ? 'swarm' : 'run';
        kindMap.set(kind, (kindMap.get(kind) ?? 0) + 1);
      }
      const examples = [...failures]
        .sort((a, b) => b.tsMs - a.tsMs)
        .map(({ row }) => quoteTitle(row.title))
        .filter((t): t is string => t !== null)
        .slice(0, MAX_EXAMPLES);
      cells.push({
        key: 'failures',
        count: failures.length,
        lowerBound: opts.tailLowerBound,
        firstSeen: new Date(failures[0]!.tsMs).toISOString(),
        lastSeen: new Date(failures[failures.length - 1]!.tsMs).toISOString(),
        clusters: [],
        byKind: [...kindMap.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
        examples,
        fileBytes: opts.fileBytes,
        consolidatedRows,
      });
    }
  }

  // --- oversized: recallable rows past the 2000-entry recall window ---
  if (opts.countRows !== null && opts.countRows.length > GENOME_HUB_RECALL_BOUND) {
    cells.push({
      key: 'oversized',
      count: opts.countRows.length,
      lowerBound: opts.countLowerBound,
      firstSeen: null,
      lastSeen: null,
      clusters: [],
      byKind: [],
      examples: [],
      fileBytes: opts.fileBytes,
      consolidatedRows,
    });
  }

  return cells;
}

const NO_CHANGE = 'If the window has rolled forward, the repeated lessons or failure captures stopped being recorded (the writers changed, the runs stopped, or autoCapture was switched off deliberately), the duplicate titles are genuinely distinct lessons that only share a generic goal string, the oversized count reflects a deliberate retention choice, or the cause is owner-only (editing ~/.ashlr/genome/hub.jsonl itself, host permissions) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the journal path and modules are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is ~/.ashlr/genome/hub.jsonl (hubStorePath in src/core/genome/store.ts — resolved under the user\'s home directly, not $ASHLR_HOME): appendHubEntry appends one GenomeEntry per learned note, loadHubEntries keeps the newest HUB_MAX_ENTRIES (2000) valid records for recall/playbook/export, recall (src/core/genome/recall.ts) injects hits into agent context excluding only the m243:skill and m235:anti-playbook tag classes, consolidateGenome (src/core/genome/consolidate.ts) is the only compaction and runs only via `phm genome consolidate`, and genomeHubHealth reports the hub\'s entry count, size and last-learned stamp.';

const boundText = (cell: GenomeHubCell): string =>
  cell.lowerBound ? ' The bounded journal reads could not see the whole file, so these counts cover only the retained rows — a proven lower bound, not the full window.' : '';

const consolidatedText = (cell: GenomeHubCell): string =>
  cell.consolidatedRows > 0 ? ` ${cell.consolidatedRows} in-window row(s) already carry consolidation provenance (mergedCount > 1), so 'phm genome consolidate' has run at least once inside the window.` : '';

function duplicatesPrompt(cell: GenomeHubCell, windowHours: number): string {
  const clusters = cell.clusters
    .map((c) => {
      const title = quoteTitle(c.title);
      if (title === null) return null;
      const project = c.project === null ? '' : ` (project '${scrubSecrets(c.project).replace(/[^\x20-\x7e]+/g, ' ').slice(0, 40)}')`;
      return `"${title}" ×${c.count} across ${c.days} day(s)${project}`;
    })
    .filter((t): t is string => t !== null)
    .join('; ');
  const seen = cell.firstSeen === cell.lastSeen
    ? ` First and last recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
  const clusterText = clusters === '' ? 'titles withheld (nothing quotable survived scrubbing)' : clusters;
  return [
    `Phantom's genome hub keeps re-recording the same learned lessons — inside the ${windowHours}-hour window, ${cell.count} row(s) sit in normalized-title clusters that each recur at the bar (≥${GENOME_HUB_RECURRING} rows across ≥${GENOME_HUB_MIN_DAYS} UTC days); largest cluster(s): ${clusterText}.`,
    '',
    `Every row is one appendHubEntry call into ~/.ashlr/genome/hub.jsonl — the learned-memory store recall injects into future agent context. The only dedupe is isDuplicate inside the auto-capture path (src/core/genome/capture.ts): it scans just the newest 50 same-project hub entries at trigram-Jaccard ≥ 0.72, so it misses older duplicates, cross-project twins and every near-miss under the threshold; explicit \`phm learn\`, M26 playbook distillation (src/core/learn/playbooks.ts), self-improve anti-playbook entries (src/core/fleet/self-improve.ts) and the skill-library legacy notes (src/core/fleet/skill-library.ts) never dedupe at all; and the only compaction, consolidateGenome (src/core/genome/consolidate.ts), is a manual backup-gated \`phm genome consolidate\` nobody schedules.${seen}${boundText(cell)}${consolidatedText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which writer produces the repeated titles — the rows' tags name the producer ('run'/'swarm' auto-captures, 'm26'+'playbook' distillations, 'm243:skill' legacy notes, 'm235:anti-playbook' self-improve entries, or bare learns) and the cluster projects say whether one repo dominates. Then decide the honest fix in this repository's src/: widen the capture dedupe window or threshold, add writer-side dedupe to the non-capture producers, teach recall to collapse duplicates at read time, or make consolidation runnable on a schedule — whichever matches how the duplicates actually accumulate. If the titles only look duplicated because distinct lessons share a generic goal string, report no-change and name the evidence. ` + NO_CHANGE,
  ].join('\n');
}

function failuresPrompt(cell: GenomeHubCell, windowHours: number): string {
  const kinds = cell.byKind.map((k) => `'${k.kind}' ×${k.count}`).join(', ');
  const examples = cell.examples.length === 0 ? '' : ` Example recorded titles (scrubbed, capped): ${cell.examples.map((t) => `"${t}"`).join(', ')}.`;
  const seen = cell.firstSeen === cell.lastSeen
    ? ` First and last recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
  return [
    `Phantom's run/swarm auto-capture keeps recording terminal failures into permanent learned memory — ${cell.count} hub row(s) carry the capture outcome tags 'failed' or 'aborted' inside the ${windowHours}-hour window (by kind: ${kinds}).`,
    '',
    `captureFromRun/captureFromSwarm (src/core/genome/capture.ts) fire on every terminal run/swarm state — src/core/run/orchestrator.ts and src/core/swarm/runner.ts call them unless cfg.genome.autoCapture === false — and tag each row 'run' or 'swarm' plus the mapped outcome ('done'|'aborted'|'failed'). These rows are not just a log: recall (src/core/genome/recall.ts) injects hub entries into future agent context and excludes only the 'm243:skill' and 'm235:anti-playbook' tag classes, so failed/aborted captures stay recall-eligible at the 0.9 run/swarm multiplier — recurring failures mean the interactive run/swarm path keeps ending badly AND each failure keeps being memorized as a "lesson" future runs can be shown.${seen}${examples}${boundText(cell)}${consolidatedText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The genome hub is the only aggregate journal of the run/swarm path's terminal outcomes, so this fold cannot see the runs' own error detail — cross-reference the run/swarm stores and ledgers (the RunState/SwarmRun records the capture summarized, plus the jobs and agent-action ledgers the sibling feeds read) to find which goals, engines or providers dominate the failures. Then fix what lives in this repository's src/: routing or admission that keeps sending unachievable work to run/swarm, an engine adapter whose failures should classify differently, or a capture policy that should stop memorizing recurring failure classes verbatim. If the failures are genuine one-off outcomes the machinery already learned from, report no-change and name the evidence. ` + NO_CHANGE,
  ].join('\n');
}

function oversizedPrompt(cell: GenomeHubCell): string {
  const countText = cell.lowerBound ? `at least ${cell.count}` : `${cell.count}`;
  const bytesText = cell.fileBytes !== null ? ` (${Math.round(cell.fileBytes / 1048576)} MiB on disk)` : '';
  return [
    `Phantom's genome hub holds ${countText} recallable entries${bytesText} — past the ${GENOME_HUB_RECALL_BOUND}-entry window every hub reader keeps.`,
    '',
    `loadHubEntries (src/core/genome/store.ts) reads the whole append-only journal then keeps only the NEWEST HUB_MAX_ENTRIES (2000) valid records, so once the store outgrew that window the oldest learned memories became unreachable by recall (src/core/genome/recall.ts), playbook synthesis (src/core/learn/playbooks.ts), genome export and the auto-capture dedupe scan — silently, because every reader still returns a healthy-looking newest slice and genomeHubHealth only counts entries without flagging the overflow. The only compaction, consolidateGenome (src/core/genome/consolidate.ts), is a manual backup-gated \`phm genome consolidate\` whose own merge cap is also 2000 entries — rows beyond it are preserved verbatim and never merged — and nothing schedules it.${cell.lowerBound ? ' The count is a proven floor: the bounded head read already holds more than the bound, and the tail read could not see the whole file.' : ''}`,
    '',
    EVIDENCE,
    '',
    `Check \`phm genome consolidate --json\` (dry-run shape) and \`phm genome health\`/status surfaces for the recorded entry count, then decide the honest fix in this repository's src/: schedule consolidation through the existing automation/launchd machinery the sibling scheduled journals use, widen or shard the recall window honestly, or add an overflow verdict to genomeHubHealth so the condition reports itself. Rewriting or truncating ~/.ashlr/genome/hub.jsonl by hand is owner-only — the store is append-only by contract. If the overflow is deliberate retention, report no-change and name the evidence. ` + NO_CHANGE,
  ].join('\n');
}

function cellItem(cell: GenomeHubCell, repo: string, windowHours: number): CloudBacklogItem {
  const titles: Record<GenomeHubCell['key'], string> = {
    duplicates: 'Genome hub keeps re-recording the same learned lessons',
    failures: 'Genome hub keeps memorizing failed/aborted run and swarm captures',
    oversized: `Genome hub exceeds the ${GENOME_HUB_RECALL_BOUND}-entry recall window`,
  };
  const prompts: Record<GenomeHubCell['key'], string> = {
    duplicates: duplicatesPrompt(cell, windowHours),
    failures: failuresPrompt(cell, windowHours),
    oversized: oversizedPrompt(cell),
  };
  const id = `genome-hub-${createHash('sha256').update(`genome-hub:${cell.key}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: titles[cell.key].slice(0, MAX_TITLE_CHARS),
    prompt: prompts[cell.key],
    area: 'genome-hub',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

export interface GenomeHubItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home the default hub path resolves under (default: os.homedir()). */
  homeDir?: string;
  /** Direct hub-journal override (default: <home>/.ashlr/genome/hub.jsonl — the writer's own resolution). */
  hubPath?: string;
  /** Evidence window in hours (default GENOME_HUB_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default GENOME_HUB_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * Backlog items for genome-hub journal evidence: recurring
 * re-recorded lessons, recurring failed/aborted auto-captures, and the
 * recall-window overflow verdict. Total: a missing or unreadable
 * journal, another repository, or any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function genomeHubBacklogItems(opts: GenomeHubItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const hubPath = opts.hubPath ?? join(home, '.ashlr', 'genome', 'hub.jsonl');
    const windowHours = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : GENOME_HUB_WINDOW_HOURS;
    const nowMs = (opts.now ?? new Date()).getTime();
    const sinceMs = nowMs - windowHours * 60 * 60 * 1000;
    const untilMs = nowMs + GENOME_HUB_FUTURE_SKEW_MS;

    const tail = readPrivateFileTailCapped(hubPath, GENOME_HUB_TAIL_BYTES);
    if (tail === null) return [];
    const tailParse = parseHubLines(tail.text, tail.truncated);

    // The oversized verdict needs a recallable-row count. When the tail
    // saw the whole file the parsed rows ARE the total; when it
    // truncated, a bounded head read proves the floor — a head count
    // past the recall bound already proves the file holds more, and an
    // untruncated head gives the exact total.
    let countRows: GenomeHubRow[] | null = tailParse.rows;
    let countLowerBound = tail.truncated;
    if (tail.truncated) {
      const head = readPrivateFileCapped(hubPath, GENOME_HUB_COUNT_BYTES);
      if (head === null) {
        countRows = null;
      } else {
        countRows = parseHubLines(head.text, false).rows;
        countLowerBound = head.truncated;
      }
    }

    const cells = foldGenomeHubCells({
      rows: tailParse.rows,
      countRows,
      tailLowerBound: tail.truncated,
      countLowerBound,
      sinceMs,
      untilMs,
      fileBytes: tail.bytes,
    });
    const limit = Math.max(1, Math.min(opts.limit ?? GENOME_HUB_MAX_ITEMS, GENOME_HUB_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => cellItem(cell, repo, windowHours));
  } catch {
    return [];
  }
}
