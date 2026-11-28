/**
 * Self-update install journal recurring evidence → self-improvement backlog items.
 *
 * Phantom's release-directory self-updater — `updateReleaseDirectory`
 * (src/core/update/release-directory.ts) — appends one audit line to
 * `<home>/.ashlr-runs/installs.log` on every completed non-check update
 * attempt. Two callers reach it: a manual `phm update` (src/cli/update.ts)
 * and the unattended `phm update --auto` tick the ai.ashlr.updater launchd
 * agent runs (runAutoUpdateTick, same file; the agent's stdout lands in
 * <runs>/update/updater.log as per-tick phantom.update.auto.v2 JSON). The
 * line shape is fixed by the writer's log() closure:
 *
 *   Phantom <from|'unknown'> to <to|'unknown'>: <outcome>; integrity:
 *   <verified|unknown>; attestation: <unknown|verified>; rolled back:
 *   <true|false>
 *
 * <outcome> is 'updated' on success, 'up to date' when the installed
 * version already matches the registry's latest, or the caught error's
 * closed-vocabulary message ('Registry unreachable', 'Release integrity
 * verification failed', 'Service kickstart failed', … — anything outside
 * the writer's prefix set collapses to 'Release update failed'). `rolled
 * back: true` means the failure landed after the `current` symlink or a
 * CLI alias had already swapped, so the host briefly pointed at the new
 * release before links were restored — the most user-visible failure
 * mode. `--check` runs return before any append, so every line is a real
 * update attempt. Until now the journal had exactly one reader — none:
 * docs/SELF-HOSTING.md documents it as the install audit trail and no code
 * path ever opened it, so a host whose self-updates kept failing (or kept
 * rolling back live swaps) never became work.
 *
 * installsBacklogItems carries the same journal into discoverBacklog:
 *
 *  - 'update-error' cells recurring per error class: the same failure
 *    message recorded often enough to be chronic rather than a burst —
 *    the slug of the recorded error text ('registry-unreachable',
 *    'release-integrity-verification-failed', 'service-kickstart-failed',
 *    …) with the from→to version pairs it hit as context.
 *  - the 'rolled-back' cell: post-swap failures recurring across any
 *    error class — the severity view, since those rows mean users ran a
 *    half-updated install before links were restored.
 *
 * Honesty rules, same as every other backlog source — plus the journal's
 * own twist:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing, non-file or unreadable evidence yields no items.
 *  - The journal describes this install's updater — it carries no
 *    repository column — so like the sibling fleet-evidence feeds, items
 *    emit only when the backlog's repo name is the fleet's own; another
 *    repository inherits nothing.
 *  - Lines count only under the writer's contract: the fixed line shape,
 *    semver-or-'unknown' versions, the two integrity/attestation
 *    vocabularies, and the writer's own invariants ('up to date' rows
 *    always carry unknown integrity/attestation and no rollback, 'updated'
 *    rows always carry verified integrity and no rollback, only error
 *    rows can roll back). Malformed and off-contract lines are skipped,
 *    never guessed.
 *  - 'updated' and 'up to date' rows are the healthy path: they never
 *    emit, counting only as separators/context inside the adverse
 *    prompts.
 *  - THE JOURNAL RECORDS NO TIMESTAMPS. Every sibling fold anchors
 *    recurrence on distinct UTC days inside a 7-day window; installs.log
 *    cannot — its only chronology is append order. Recurrence is
 *    therefore proven two honest ways, and the prompts say which fired:
 *    a cell needs INSTALLS_MIN_ROWS adverse rows AND either at least one
 *    healthy row recorded between its first and last adverse row (the
 *    failures are non-contiguous across completed update cycles) or
 *    INSTALLS_SUSTAINED_ROWS adverse rows outright (a sustained streak —
 *    the updater's own schedule spaces due ticks at least 60 s apart and
 *    doubles the gap toward a 30-minute cap while no newer release
 *    appears, so a dozen recorded failures cover real hours; manual
 *    `phm update` runs share the journal unspaced, which the prompts
 *    state as the caveat). A short contiguous burst stays silent rather
 *    than claiming recurrence it cannot prove.
 *  - A truncated tail still folds the retained rows with the prompts
 *    stating the counts as lower bounds — and, since there is no window,
 *    the retained tail IS the whole evidence base.
 *  - Dedup is downstream. Item ids hash the cell kind + error slug (or
 *    'rolled-back') + repo — never the counts — so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new;
 *    shifted tallies do not spawn twin items and a failure class that
 *    stops recurring simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, version pairs come from validated rows, the brief
 *    names the journal, the writer, the updater tick and the line
 *    grammar, and the usual no-change escape covers windows that no
 *    longer reproduce or owner-only causes.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the error-class set is small and closed. */
export const INSTALLS_MAX_ITEMS = 8;
const INSTALLS_ITEM_HARD_MAX = 25;
/**
 * Bounded tail for the journal. One ~150-byte line lands per completed
 * update attempt; the auto-update tick's due checks are spaced at least
 * 60 s apart (src/core/update/auto-update.ts MIN_DELAY_MS) and manual
 * runs are rare, so 512 KiB retains thousands of attempts — weeks of
 * steady-state history and days even under a release storm.
 */
export const INSTALLS_TAIL_BYTES = 512 * 1024;
/** Adverse rows one cell needs before recurrence is even considered. */
export const INSTALLS_MIN_ROWS = 6;
/**
 * A cell with fewer healthy separators than this needs this many adverse
 * rows outright to count as sustained rather than a burst. At the tick's
 * ≥60 s spacing floor with backoff toward 30 min, a dozen recorded
 * failures cover real hours.
 */
export const INSTALLS_SUSTAINED_ROWS = 12;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The journal's path under the user's home — the writer hardcodes ~/.ashlr-runs, not $ASHLR_RUNS_DIR. */
const INSTALLS_JOURNAL_RELATIVE = join('.ashlr-runs', 'installs.log');
/** The fleet's own repository label: update evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

export type InstallOutcome = 'updated' | 'up-to-date' | 'error';
export type CellKind = 'update-error' | 'rolled-back';

export interface InstallsItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: <home>/.ashlr-runs/installs.log — the writer's own path). */
  journalPath?: string;
  /** Home for the default journal path (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default INSTALLS_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** One validated installs.log row. The journal is undated: `line` is the
 * row's ordinal among the tail's non-empty lines — append order is the
 * only chronology, and it is what the recurrence bars measure. */
export interface InstallRow {
  line: number;
  from: string;
  to: string;
  outcome: InstallOutcome;
  /** The recorded error text on 'error' rows (closed writer vocabulary, parsed tolerantly). */
  error: string | null;
  /** error lowercased/punctuation-collapsed — the cell key. */
  slug: string | null;
  rolledBack: boolean;
  integrity: 'verified' | 'unknown';
  attestation: 'verified' | 'unknown';
}

const VERSION = /^(?:unknown|\d+\.\d+\.\d+)$/;
const LINE = /^Phantom (\S+) to (\S+): (.*); integrity: (verified|unknown); attestation: (unknown|verified); rolled back: (true|false)$/;
/** Sanity cap on recorded error text — the writer's longest message is far shorter. */
const MAX_ERROR_CHARS = 200;

const slugOf = (error: string): string =>
  error.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/**
 * Pure: parse journal text into validated install rows. Lines are matched
 * against the writer's fixed shape, then held to the writer's own
 * invariants — 'up to date' rows predate verification so they must carry
 * unknown integrity/attestation and no rollback, 'updated' rows postdate
 * the integrity gate so they must carry verified integrity and no
 * rollback, and only error rows can record rolled back: true. Malformed
 * lines and off-contract rows are skipped — never guessed. Extra fields
 * cannot exist (the line is not JSON); a future writer extending the
 * grammar fails the regex and its rows simply stay out until this parser
 * learns them.
 */
export function parseInstallsJournal(text: string): InstallRow[] {
  const rows: InstallRow[] = [];
  let line = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    line += 1;
    const m = LINE.exec(raw.trim());
    if (m === null) continue;
    const [, from, to, outcome, integrity, attestation, rolledBack] = m;
    if (from === undefined || to === undefined || outcome === undefined
      || integrity === undefined || attestation === undefined || rolledBack === undefined) continue;
    if (!VERSION.test(from) || !VERSION.test(to)) continue;
    if (outcome === '') continue;
    const rb = rolledBack === 'true';
    const kind: InstallOutcome = outcome === 'updated' ? 'updated'
      : outcome === 'up to date' ? 'up-to-date' : 'error';
    if (kind === 'up-to-date' && (integrity !== 'unknown' || attestation !== 'unknown' || rb)) continue;
    if (kind === 'updated' && (integrity !== 'verified' || rb)) continue;
    // A rollback requires `changed` non-empty, which only happens after the
    // integrity gate — so rolled-back rows always carry verified integrity.
    if (rb && integrity !== 'verified') continue;
    // Version invariants: 'up to date' fires only on from === to, 'updated'
    // only on a real transition between releases, and an error row never
    // sees equal semver versions — the equality check returns 'up to date'
    // before any failure path, so equal versions on an error row mean both
    // sides are 'unknown' (a failure before the package identity was read).
    const semver = (v: string): boolean => /^\d+\.\d+\.\d+$/.test(v);
    if (kind === 'up-to-date' && !(from === to && semver(from))) continue;
    if (kind === 'updated' && !(from !== to && semver(from) && semver(to))) continue;
    if (kind === 'error' && from === to && semver(from)) continue;
    if (kind === 'error' && outcome.length > MAX_ERROR_CHARS) continue;
    const slug = kind === 'error' ? slugOf(outcome) : null;
    if (kind === 'error' && slug === '') continue;
    rows.push({
      line, from, to, outcome: kind,
      error: kind === 'error' ? outcome : null,
      slug,
      rolledBack: rb,
      integrity: integrity as 'verified' | 'unknown',
      attestation: attestation as 'verified' | 'unknown',
    });
  }
  return rows;
}

/** One error class's adverse-row track inside the retained tail. */
export interface ErrorCell {
  slug: string;
  /** Representative recorded error text (first seen for the slug). */
  error: string;
  rows: number;
  /** Subset of `rows` recorded after links had already swapped. */
  rolledBack: number;
  /** 'from→to' version transitions the class hit, most frequent first (top 4). */
  pairs: Array<{ pair: string; count: number }>;
  /** Distinct version transitions the class hit — the uncapped count. */
  pairTotal: number;
  firstLine: number;
  lastLine: number;
  /** Healthy rows ('updated'/'up to date') strictly between firstLine and lastLine. */
  healthyBetween: number;
}

/** The aggregate post-swap failure track — the severity view across classes. */
export interface RollbackCell {
  rows: number;
  /** Error slugs on the rolled-back rows, most frequent first. */
  errors: Array<{ slug: string; count: number }>;
  pairs: Array<{ pair: string; count: number }>;
  /** Distinct version transitions the rolled-back rows hit — the uncapped count. */
  pairTotal: number;
  firstLine: number;
  lastLine: number;
  healthyBetween: number;
}

export interface InstallFold {
  /** Every validated row in the retained tail. */
  total: number;
  /** 'updated' + 'up-to-date' rows — the healthy path, context only. */
  healthy: number;
  /** 'error' rows total across all classes. */
  errorRows: number;
  /** Rows recorded with rolled back: true. */
  rolledBackRows: number;
  /** Error class slug → its adverse track. */
  errors: Map<string, ErrorCell>;
  rolledBack: RollbackCell;
}

const pairOf = (row: InstallRow): string => `${row.from}→${row.to}`;

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const topPairs = (map: Map<string, number>, cap: number): Array<{ pair: string; count: number }> =>
  [...map.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair))
    .slice(0, cap);

/** Count of `sorted` values strictly inside (lo, hi) — healthy lines are appended in order. */
const countBetween = (sorted: readonly number[], lo: number, hi: number): number => {
  let count = 0;
  for (const v of sorted) {
    if (v <= lo) continue;
    if (v >= hi) break;
    count += 1;
  }
  return count;
};

const newErrorCell = (slug: string, error: string, line: number): ErrorCell => ({
  slug, error, rows: 0, rolledBack: 0, pairs: [], pairTotal: 0,
  firstLine: line, lastLine: line, healthyBetween: 0,
});

/**
 * Pure: fold validated rows into the install journal's evidence. There is
 * no time window — the retained tail is the whole evidence base and
 * append order (`line`) is the only chronology, so cells track first/
 * last line and the count of healthy rows between them; that is what the
 * recurrence bars read. 'updated' and 'up to date' rows never enter a
 * cell — they are the separators and context.
 */
export function foldInstallRows(rows: readonly InstallRow[]): InstallFold {
  const errors = new Map<string, ErrorCell>();
  const errorPairs = new Map<string, Map<string, number>>();
  const healthyLines: number[] = [];
  const rbErrors = new Map<string, number>();
  const rbPairs = new Map<string, number>();
  const fold: InstallFold = {
    total: rows.length, healthy: 0, errorRows: 0, rolledBackRows: 0,
    errors, rolledBack: {
      rows: 0, errors: [], pairs: [], pairTotal: 0,
      firstLine: Number.POSITIVE_INFINITY, lastLine: Number.NEGATIVE_INFINITY, healthyBetween: 0,
    },
  };
  for (const row of rows) {
    if (row.outcome !== 'error' || row.slug === null) {
      fold.healthy += 1;
      healthyLines.push(row.line);
      continue;
    }
    fold.errorRows += 1;
    let cell = errors.get(row.slug);
    if (cell === undefined) {
      cell = newErrorCell(row.slug, row.error ?? row.slug, row.line);
      errors.set(row.slug, cell);
      errorPairs.set(row.slug, new Map());
    }
    cell.rows += 1;
    cell.firstLine = Math.min(cell.firstLine, row.line);
    cell.lastLine = Math.max(cell.lastLine, row.line);
    const pair = pairOf(row);
    bump(errorPairs.get(row.slug)!, pair);
    if (row.rolledBack) {
      cell.rolledBack += 1;
      fold.rolledBackRows += 1;
      bump(rbErrors, row.slug);
      bump(rbPairs, pair);
      fold.rolledBack.rows += 1;
      fold.rolledBack.firstLine = Math.min(fold.rolledBack.firstLine, row.line);
      fold.rolledBack.lastLine = Math.max(fold.rolledBack.lastLine, row.line);
    }
  }
  for (const [slug, cell] of errors) {
    const pairMap = errorPairs.get(slug)!;
    cell.pairTotal = pairMap.size;
    cell.pairs = topPairs(pairMap, 4);
    cell.healthyBetween = countBetween(healthyLines, cell.firstLine, cell.lastLine);
  }
  fold.rolledBack.errors = [...rbErrors.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));
  fold.rolledBack.pairs = topPairs(rbPairs, 4);
  fold.rolledBack.pairTotal = rbPairs.size;
  fold.rolledBack.healthyBetween = countBetween(healthyLines, fold.rolledBack.firstLine, fold.rolledBack.lastLine);
  return fold;
}

/**
 * The recurrence bar for an undated journal: enough adverse rows, and
 * either proven non-contiguity (a healthy row between the cell's first
 * and last) or a sustained streak long enough to cover real hours at the
 * tick's spacing floor.
 */
const meetsBar = (cell: { rows: number; healthyBetween: number }): boolean =>
  cell.rows >= INSTALLS_MIN_ROWS
  && (cell.healthyBetween >= 1 || cell.rows >= INSTALLS_SUSTAINED_ROWS);

const WINDOW_NOTE = 'installs.log records no per-line timestamps, so there is no day window: the retained tail is the whole evidence base. The auto-update schedule spaces due ticks at least 60 s apart and doubles the gap toward a 30-minute cap while no newer release appears, so recorded failures are spaced real attempts rather than bursts; manual `phm update` runs share the journal unspaced, so the recorded count — not elapsed time — is the recurrence evidence.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const healthyNote = (cell: { rows: number; healthyBetween: number }): string =>
  cell.healthyBetween >= 1
    ? `${cell.healthyBetween} healthy update cycle(s) ('updated'/'up to date') completed between the first and last recorded failure, so the failures are non-contiguous across finished update attempts.`
    : 'No healthy update cycle separated the recorded failures in the retained tail — the streak is contiguous.';

const pairsText = (pairs: ReadonlyArray<{ pair: string; count: number }>, total: number): string =>
  pairs.length === 0 ? 'no recorded version pairs'
    : pairs.map((p) => `${p.pair} ×${p.count}`).join(', ') + (pairs.length < total ? `, +${total - pairs.length} more` : '');

const JOURNAL = 'The evidence is ~/.ashlr-runs/installs.log (the writer hardcodes the home-relative path — $ASHLR_RUNS_DIR does not move it): updateReleaseDirectory (src/core/update/release-directory.ts) appends one `Phantom <from> to <to>: <outcome>; integrity: <verified|unknown>; attestation: <unknown|verified>; rolled back: <true|false>` line per completed non-check update attempt, reached by `phm update` and by the ai.ashlr.updater launchd tick (runAutoUpdateTick in src/cli/update.ts; per-tick JSON also lands in <runs>/update/updater.log). <outcome> is \'updated\', \'up to date\', or the caught error\'s message — \'Registry unreachable\', \'Release integrity verification failed\', \'Service kickstart failed\' and the rest of the writer\'s closed set, with anything unrecognized collapsing to \'Release update failed\'. \'rolled back: true\' means the failure landed after the `current` symlink or a CLI alias had already swapped. Until this feed nothing read the journal: its only mention was documentation.';

const NO_CHANGE = 'If the retained tail no longer reproduces the failures (the journal rolled forward past them, a fixed release pipeline stopped the class recurring, or the cause is owner-only — registry credentials, gh auth, a protected gate, host hardware) — report no-change and name the evidence.';

/** Which pipeline stage an error class points at, for the prompt's check-list. */
function stageHint(slug: string): string {
  if (slug === 'release-update-failed') return 'an unrecognized pipeline failure — the writer\'s catch-all for thrown errors outside its known prefixes, so the underlying throw has to be reproduced to name the stage';
  if (slug === 'unsupported-package-identity') return 'the local package.json identity check (the running release must be @ashlr/phantom at a semver version)';
  if (slug.includes('unsupported')) return 'release-layout detection (detectReleaseDirectory — the updater ran against a root that is not the per-user release layout)';
  if (slug.includes('registry')) return 'the npm registry probe (probeNpmRegistry in src/core/update/registry.ts — egress, proxy or registry metadata shape)';
  if (slug.includes('integrity') || slug.includes('attestation') || slug.includes('github-verifier')) return 'artifact verification — the sha512 integrity check, `gh attestation verify`, or the GitHub verifier itself';
  if (slug.includes('archive') || slug.includes('package-identity') || slug.includes('candidate')) return 'the unpacked-package checks (tar entry safety, package.json identity, the immutable releases/<sha> destination)';
  if (slug.includes('smoke')) return 'the candidate smoke test (`phm --version` on the staged release)';
  if (slug.includes('current-release') || slug.includes('cli-link')) return 'the link-ownership and link-race checks around the `current` symlink and ~/.local/bin CLI aliases';
  if (slug.includes('service') || slug.includes('rollback') || slug.includes('recovery')) return 'launchctl service control — SIGSTOP/SIGCONT/kickstart of the resident services, or the rollback/recovery path itself';
  return 'a stage of the update pipeline the closed error vocabulary does not name more precisely';
}

function errorPrompt(cell: ErrorCell, fold: InstallFold, truncated: boolean): string {
  const rb = cell.rolledBack > 0 ? ` — ${cell.rolledBack} of them recorded 'rolled back: true' (the failure landed after links had already swapped)` : '';
  return [
    `Phantom's self-update path keeps recording '${cell.error}' failures in installs.log.`,
    '',
    `The retained journal tail recorded ${cell.rows} '${cell.error}' failure(s)${rb} across ${cell.pairTotal} recorded version transition(s) (${pairsText(cell.pairs, cell.pairTotal)}); the journal holds ${fold.total} validated row(s) total, ${fold.healthy} healthy. ${healthyNote(cell)}${truncationNote(truncated)}`,
    '',
    JOURNAL,
    '',
    WINDOW_NOTE,
    '',
    `'${cell.error}' points at ${stageHint(cell.slug)}. Recurring failures on the same from→to pair say that release cannot install on this host; failures spread across pairs say the updater's own dependencies are broken rather than one bad release. Check the newest lines (\`tail ~/.ashlr-runs/installs.log\`), \`phm update --check --json\` for the live verdict, and whether the class predates the newest release — a fixed pipeline stops recurring on its own. ${NO_CHANGE}`,
  ].join('\n');
}

function rolledBackPrompt(cell: RollbackCell, fold: InstallFold, truncated: boolean): string {
  const classes = cell.errors.map((e) => `'${e.slug}' ×${e.count}`).join(', ');
  return [
    `Phantom's self-update path keeps swapping release links and then rolling them back.`,
    '',
    `The retained journal tail recorded ${cell.rows} rolled-back update(s) — failures that landed after the \`current\` symlink or a CLI alias had already swapped, so the host briefly pointed at the new release before links were restored. The rolled-back rows carried these error classes: ${classes}; version transitions: ${pairsText(cell.pairs, cell.pairTotal)}. ${healthyNote(cell)} The journal holds ${fold.total} validated row(s) total, ${fold.healthy} healthy, ${fold.errorRows} error row(s) overall.${truncationNote(truncated)}`,
    '',
    JOURNAL,
    '',
    WINDOW_NOTE,
    '',
    `A rolled-back row means the failure happened inside the post-swap window: the second 'Current release changed'/'CLI link changed' race checks, a launchctl service restart (kill SIGCONT/kickstart) that failed, or the rollback/recovery path itself ('Release rollback failed'/'Service recovery failed' — the latter can leave a resident service stopped). Pre-swap failures — registry, integrity, archive, smoke — roll back nothing because \`changed\` is still empty, so recurring rollbacks specifically indict service control or link handling rather than download/verify. Check launchctl behavior for the resident services, the .update-lock discipline under ~/.local/share/ashlr, and whether recovery itself is failing. ${NO_CHANGE}`,
  ].join('\n');
}

interface Candidate {
  kind: CellKind;
  key: string;
  rows: number;
  item: CloudBacklogItem;
}

function itemId(kind: CellKind, key: string, repo: string): string {
  const hash = createHash('sha256').update(`installs:${kind}:${key}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `installs-${kind}-${hash}`;
}

function makeItem(kind: CellKind, key: string, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, key, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'self-update',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the self-update install journal's recurring error
 * classes and post-swap rollbacks. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function installsBacklogItems(opts: InstallsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const home = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath ?? join(home, INSTALLS_JOURNAL_RELATIVE);
    const tail = await readLedgerTail(journalPath, INSTALLS_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const rows = parseInstallsJournal(tail.text);
    const fold = foldInstallRows(rows);

    const candidates: Candidate[] = [];
    for (const cell of fold.errors.values()) {
      if (!meetsBar(cell)) continue;
      candidates.push({
        kind: 'update-error',
        key: cell.slug,
        rows: cell.rows,
        item: makeItem('update-error', cell.slug, repo,
          `Self-update keeps failing: ${cell.error}`,
          errorPrompt(cell, fold, tail.truncated)),
      });
    }
    if (meetsBar(fold.rolledBack)) {
      candidates.push({
        kind: 'rolled-back',
        key: 'rolled-back',
        rows: fold.rolledBack.rows,
        item: makeItem('rolled-back', 'rolled-back', repo,
          'Self-update keeps rolling back swapped releases',
          rolledBackPrompt(fold.rolledBack, fold, tail.truncated)),
      });
    }
    // Strongest recorded evidence first; identity fields last so the order is total.
    candidates.sort((a, b) =>
      b.rows - a.rows
      || a.key.localeCompare(b.key)
      || a.kind.localeCompare(b.kind));
    const limit = Math.max(1, Math.min(opts.limit ?? INSTALLS_MAX_ITEMS, INSTALLS_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => c.item);
  } catch {
    return [];
  }
}
