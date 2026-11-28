/**
 * Model-racing distillation outcomes → self-improvement backlog items.
 *
 * M166's model racing (src/core/fleet/model-racing.ts) is the fleet's
 * local-vs-frontier experiment: when `foundry.modelRacing.enabled` is set,
 * raceTask() runs the SAME work item through the local engine and a frontier
 * engine, scores each via the judge, picks a winner and persists a
 * secret-scrubbed RaceRecord to ~/.ashlr/racing/<date>.jsonl — the
 * distillation dataset whose frontier diff is the teacher target for local
 * model improvement. racingStats() aggregates that journal for the
 * `ashlr_racing` MCP tool and the autonomy outcome-records report (which
 * resource-strategy.ts folds toward routing decisions), so the numbers are
 * already meant to steer the fleet.
 *
 * Until now nothing folded the journal into work: the only readers were the
 * aggregate stats surfaces, so a racing run that kept tying, kept losing to
 * the frontier, or never ran at all while the flag was on produced no
 * self-improvement item. racingOutcomeBacklogItems carries the bounded
 * record fold into discoverBacklog, so `phm improve discover` and the
 * scheduler's autoDiscover queue it exactly like the sibling evidence feeds.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. ~/.ashlr/racing/*.jsonl is enumerated and parsed through a
 *    bounded read (capped file count, per-file byte ceiling, per-line JSON
 *    parse); nothing is written and no network is touched. The diffs the
 *    records carry are never quoted into a prompt — only counts, rates and
 *    scrubbed task titles.
 *  - Degraded evidence yields no items. A missing directory reads as an
 *    empty dataset; an unreadable directory, an oversized file or a file
 *    list past the cap marks the read incomplete, and the 'never
 *    accumulated' signal stays quiet rather than claim zero records it
 *    cannot prove. Malformed lines are skipped, never fatal.
 *  - Recurring means recorded. The outcome-pattern signals need
 *    RACING_OUTCOME_MIN_RACES in-window records before a win rate means
 *    anything — the fleet's RECURRING_FAILURES convention applied to races,
 *    not rows: a handful of races cannot separate signal from luck. The
 *    enabled-but-empty signal needs no minimum because its evidence is the
 *    absence itself.
 *  - Windowed on the record's own `ts`. Only records stamped inside
 *    RACING_OUTCOME_WINDOW_MS of the clock count toward the pattern
 *    signals, with the sibling feeds' one-minute future-skew ceiling — a
 *    record stamped further ahead is corrupt or replayed evidence. The
 *    enabled-but-empty check instead counts every parseable record the
 *    bounded read reaches, since "never accumulated" is a statement about
 *    the whole dataset, not the window.
 *  - Fleet machinery only. Racing, its journal and the config flag are this
 *    install's machinery, so items emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule the sibling
 *    feeds apply.
 *  - Dedup is downstream. The item id is a stable slug of the signal kind
 *    (never the counts, rates or titles), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; a dataset that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts, rates and
 *    titles are quoted only as recorded (titles scrubbed and flattened),
 *    the journal path and the producing/consuming code are named, and the
 *    brief keeps the usual no-change escape for evidence that has rolled
 *    forward.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import { loadConfigReadOnly } from '../config.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the signal set is a handful of fixed umbrellas. */
export const RACING_OUTCOME_BACKLOG_MAX_ITEMS = 4;
const RACING_OUTCOME_ITEM_HARD_MAX = 25;
/**
 * Event-recency window for the outcome-pattern signals (7 days, the sibling
 * feeds' recurrence window).
 */
export const RACING_OUTCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Future-skew ceiling on record `ts` stamps, the sibling feeds' one-minute
 * tolerance for same-host clock drift: a record stamped further ahead than
 * the evaluation time is corrupt or replayed evidence and never reaches a
 * tally.
 */
export const RACING_OUTCOME_FUTURE_SKEW_MS = 60_000;
/**
 * In-window races a pattern signal needs before a win rate means anything —
 * a rate over a handful of races cannot separate signal from luck.
 */
export const RACING_OUTCOME_MIN_RACES = 5;
/** Win share (wins / races) at or above which a side counts as dominant. */
export const RACING_OUTCOME_DOMINANT_RATE = 2 / 3;
/** Newest-first daily journal files one read may span (~2 months of races). */
const RACING_MAX_FILES = 62;
/** Per-file byte ceiling; race diffs are large, so an oversized file is skipped rather than parsed. */
const RACING_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct task titles quoted inside one prompt before the rest is summarized. */
const PROMPT_TASKS_MAX = 5;
/** The fleet's own repository label: racing evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface RacingOutcomeItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Racing journal directory override (default: ~/.ashlr/racing, racingDir() in model-racing.ts). */
  racingDir?: string;
  /** Most items one call emits (default RACING_OUTCOME_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock for the window, skew and rate reads (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string | null | undefined, max = FIELD_MAX): string {
  if (value === null || value === undefined) return '';
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

type RaceWinner = 'local' | 'frontier' | 'tie';

interface RaceFold {
  winner: RaceWinner;
  localScore: number;
  frontierScore: number;
  tsMs: number;
  taskId: string;
  taskTitle: string;
}

/** The record fields the fold consumes, or null when the line is not a usable race record. */
function raceRecord(value: unknown): RaceFold | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const winner = r['winner'];
  if (winner !== 'local' && winner !== 'frontier' && winner !== 'tie') return null;
  const localScore = r['localScore'];
  const frontierScore = r['frontierScore'];
  if (typeof localScore !== 'number' || !Number.isFinite(localScore)) return null;
  if (typeof frontierScore !== 'number' || !Number.isFinite(frontierScore)) return null;
  const ts = r['ts'];
  if (typeof ts !== 'string') return null;
  const tsMs = Date.parse(ts);
  if (Number.isNaN(tsMs)) return null;
  const taskId = r['taskId'];
  const taskTitle = r['taskTitle'];
  return {
    winner,
    localScore,
    frontierScore,
    tsMs,
    taskId: typeof taskId === 'string' ? taskId : '',
    taskTitle: typeof taskTitle === 'string' ? taskTitle : '',
  };
}

interface RacingRead {
  /** Every parseable record the bounded read reached, any age. */
  records: RaceFold[];
  /**
   * False when the read could not prove it saw the whole dataset — the
   * directory was unreadable, a file was oversized or unreadable, or the
   * file list exceeded the cap. The enabled-but-empty signal requires a
   * complete read before it may claim zero records.
   */
  complete: boolean;
}

/**
 * Bounded read of the racing journal. Files are daily `YYYY-MM-DD.jsonl`
 * names; the newest RACING_MAX_FILES are read so a long-lived install does
 * not fold unbounded history. Malformed lines are skipped, never fatal.
 */
function readRacingJournal(dir: string): RacingRead {
  if (!existsSync(dir)) return { records: [], complete: true };
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { records: [], complete: false };
  }
  names.sort().reverse();
  const filesComplete = names.length <= RACING_MAX_FILES;
  const records: RaceFold[] = [];
  let complete = filesComplete;
  for (const name of names.slice(0, RACING_MAX_FILES)) {
    const path = join(dir, name);
    let text: string;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > RACING_MAX_FILE_BYTES) {
        complete = false;
        continue;
      }
      text = readFileSync(path, 'utf8');
    } catch {
      complete = false;
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = raceRecord(JSON.parse(line));
        if (rec !== null) records.push(rec);
      } catch {
        // malformed line: skip, never fatal
      }
    }
  }
  return { records, complete };
}

type SignalKind = 'enabled-empty' | 'degenerate' | 'frontier-dominant' | 'local-dominant';

interface Signal {
  kind: SignalKind;
  title: string;
  prompt: string;
}

const EVIDENCE = 'The evidence is the model-racing distillation journal ~/.ashlr/racing/<date>.jsonl (racingDir in src/core/fleet/model-racing.ts — one RaceRecord per raceTask run, secret-scrubbed diffs included): `ashlr_racing` (the MCP tool, src/core/mcp-native.ts) and racingStats() print the aggregate win rate, average score delta and local-win count, and the autonomy outcome-records report (src/core/autonomy/outcome-records.ts → resource-strategy.ts) folds the same stats toward routing decisions. raceTask itself is gated on foundry.modelRacing.enabled (default false — it doubles inference cost per raced task) and is the journal\'s only writer.';

const NO_CHANGE = 'If the flag was turned off, the races already ran and the window has rolled forward to a different verdict, the journal was rotated or pruned since this evidence, or the only missing piece is owner-side (a provider account, payment or a protected gate) — report no-change and name the evidence.';

function pct(part: number, whole: number): string {
  return whole === 0 ? 'unknown' : `${Math.round((part / whole) * 100)}%`;
}

function taskTitles(records: readonly RaceFold[]): string {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const rec of records) {
    const title = fieldText(rec.taskTitle, 80);
    if (title === '' || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
    if (titles.length >= PROMPT_TASKS_MAX) break;
  }
  if (titles.length === 0) return 'No raced task titles were recorded.';
  const more = records.length > titles.length ? ` and ${records.length - titles.length} more raced task(s)` : '';
  return `Newest raced tasks include ${titles.map((t) => `'${t}'`).join(', ')}${more}.`;
}

function enabledEmptySignal(): Signal {
  return {
    kind: 'enabled-empty',
    title: 'Model racing is enabled but the distillation dataset never accumulates',
    prompt: [
      'Phantom\'s model-racing flag is on but the distillation journal has never recorded a race — the self-improvement work this backlog exists to queue.',
      '',
      `foundry.modelRacing.enabled is set in the Phantom config, yet a complete bounded read of ~/.ashlr/racing/ found zero parseable race records. raceTask (src/core/fleet/model-racing.ts) is the journal's only writer and the flag's only gate: it is meant to run the same work item through the local engine and a frontier engine and persist the teacher-target diff, but no dispatch, daemon or CLI path in this repository invokes it — racingStats() and the outcome-records report read a dataset that cannot grow. The local-vs-frontier evidence the flag exists to produce (and resource-strategy.ts folds toward routing) is therefore always empty.`,
      '',
      'What is in scope: whether a sampled dispatch path should invoke raceTask behind the existing foundry.modelRacing.enabled flag (respecting its documented inference-cost doubling — opt-in sampling only, never every task), or whether the flag and the dormant machinery should be removed or documented as deferred. Check src/core/fleet/model-racing.ts, the dispatch paths in src/core/daemon/loop.ts and src/core/fabric/gateway.ts, and the config schema in src/core/types/config.ts. If the flag was enabled only for a manual experiment that already ran and rotated its journal — report no-change and name the evidence.',
      '',
      EVIDENCE,
      '',
      NO_CHANGE,
    ].join('\n'),
  };
}

function degenerateSignal(races: number, titles: string): Signal {
  return {
    kind: 'degenerate',
    title: 'Model races keep tying — the judge never separates local from frontier',
    prompt: [
      `Phantom's model-racing journal recorded ${races} race(s) inside the ${Math.round(RACING_OUTCOME_WINDOW_MS / 86_400_000)}-day window and every one ended 'tie' — the judge never once separated the local engine from the frontier.`,
      '',
      titles,
      '',
      `The journal is ~/.ashlr/racing/<date>.jsonl (racingDir in src/core/fleet/model-racing.ts); \`ashlr_racing\` and racingStats() print the same tallies. A tie means localScore === frontierScore. The likely cause is the judge path: raceTask defaults to buildMinimalJudgeClient (an empty completion → judgeProposal's parse-failure fallback → score 0 on both sides) unless the caller passes a real judgeClient, and no production caller passes one today. A dataset of all-tie records carries diffs but no teacher signal — the frontier diff cannot be trusted as the better target when the judge never preferred it.`,
      '',
      'What is in scope: whether races need a real judge client wired through (judgeProposal in src/core/fleet/manager.ts, scoreVerdict in src/core/fleet/verdict-score.ts), whether the parse-failure fallback should mark records unjudgeable rather than score 0, or whether tie-heavy evidence should gate the distillation claim entirely. Check src/core/fleet/model-racing.ts and src/core/fleet/manager.ts. If the window has rolled forward to discriminating records — report no-change and name the evidence.',
      '',
      EVIDENCE,
      '',
      NO_CHANGE,
    ].join('\n'),
  };
}

function dominantSignal(kind: 'frontier-dominant' | 'local-dominant', races: number, wins: number, avgDelta: number, titles: string): Signal {
  const side = kind === 'frontier-dominant' ? 'frontier' : 'local';
  const deltaText = avgDelta > 0 ? `+${avgDelta.toFixed(2)}` : avgDelta.toFixed(2);
  return {
    kind,
    title: kind === 'frontier-dominant'
      ? 'Model races keep going to the frontier — the local engine is systematically behind'
      : 'Model races keep going to the local engine — frontier racing spend may not pay',
    prompt: [
      `Phantom's model-racing journal recorded ${races} race(s) inside the ${Math.round(RACING_OUTCOME_WINDOW_MS / 86_400_000)}-day window; the ${side} engine won ${wins} of them (${pct(wins, races)}) with an average score delta of ${deltaText} (frontier minus local).`,
      '',
      titles,
      '',
      `The journal is ~/.ashlr/racing/<date>.jsonl (racingDir in src/core/fleet/model-racing.ts); \`ashlr_racing\` and racingStats() print the same tallies, and the autonomy outcome-records report folds them toward routing. ${kind === 'frontier-dominant'
        ? 'A frontier-dominant streak is the evidence the distillation dataset exists for: the local engine is not yet competitive on these task shapes, so the frontier diff is the teacher target — the open question is whether local-model improvement or routing local-class work to frontier is the cheaper closure.'
        : 'A local-dominant streak means the frontier engine is not earning its racing cost on these task shapes — the open question is whether racing should narrow to the task classes where frontier actually wins, or whether the judge is biased toward the local side.'}`,
      '',
      'What is in scope: whether the win pattern is stable enough to act on (racingStats in src/core/fleet/model-racing.ts, the outcome-records fold in src/core/autonomy/outcome-records.ts and resource-strategy.ts), whether racing coverage is too narrow to generalize, or whether the judge scoring (judgeProposal/scoreVerdict) needs a bias check. If the window has rolled forward to a different verdict — report no-change and name the evidence.',
      '',
      EVIDENCE,
      '',
      NO_CHANGE,
    ].join('\n'),
  };
}

/**
 * Backlog items for model-racing distillation evidence on `repo`. Total: a
 * missing journal, another repository, a degraded read or any fold failure
 * yields no items rather than throwing into discovery.
 */
export async function racingOutcomeBacklogItems(opts: RacingOutcomeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const dir = opts.racingDir ?? join(homedir(), '.ashlr', 'racing');
    const read = readRacingJournal(dir);

    // The flag read is isolated: a config failure must not suppress journal
    // folding, and an unreadable config can never prove the flag is on.
    let racingEnabled = false;
    try {
      racingEnabled = loadConfigReadOnly().foundry?.modelRacing?.enabled === true;
    } catch {
      racingEnabled = false;
    }

    const signals: Signal[] = [];
    if (racingEnabled && read.complete && read.records.length === 0) {
      signals.push(enabledEmptySignal());
    }

    const windowStart = nowMs - RACING_OUTCOME_WINDOW_MS;
    const inWindow = read.records.filter(
      (rec) => rec.tsMs >= windowStart && rec.tsMs <= nowMs + RACING_OUTCOME_FUTURE_SKEW_MS,
    );
    if (inWindow.length >= RACING_OUTCOME_MIN_RACES) {
      const frontierWins = inWindow.filter((rec) => rec.winner === 'frontier').length;
      const localWins = inWindow.filter((rec) => rec.winner === 'local').length;
      const ties = inWindow.length - frontierWins - localWins;
      const avgDelta = inWindow.reduce((sum, rec) => sum + (rec.frontierScore - rec.localScore), 0) / inWindow.length;
      const titles = taskTitles(inWindow);
      if (ties === inWindow.length) {
        signals.push(degenerateSignal(inWindow.length, titles));
      } else {
        if (frontierWins / inWindow.length >= RACING_OUTCOME_DOMINANT_RATE && avgDelta > 0) {
          signals.push(dominantSignal('frontier-dominant', inWindow.length, frontierWins, avgDelta, titles));
        }
        if (localWins / inWindow.length >= RACING_OUTCOME_DOMINANT_RATE && avgDelta < 0) {
          signals.push(dominantSignal('local-dominant', inWindow.length, localWins, avgDelta, titles));
        }
      }
    }

    const limit = Math.max(1, Math.min(opts.limit ?? RACING_OUTCOME_BACKLOG_MAX_ITEMS, RACING_OUTCOME_ITEM_HARD_MAX));
    return signals.slice(0, limit).map((signal) => ({
      id: `racing-${signal.kind}`,
      title: signal.title.slice(0, MAX_TITLE_CHARS),
      prompt: signal.prompt,
      area: 'model-racing',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    }));
  } catch {
    return [];
  }
}
