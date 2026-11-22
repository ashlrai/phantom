/**
 * Family yield: merged PRs per launch for every recurring job family, and the families that waste launches.
 *
 * `familyYield` is pure. Parsing is `yieldTally` in slot-yield.ts (the same counting model as `phm jobs yield`);
 * this file only regroups its runs by a coarser family and judges each one. `readFamilyYield` streams a file
 * through an injected line reader; `src/cli/fleet-yield.ts` renders the report.
 *
 * Family: the job id with its numbers collapsed (`collapseFamily`). This is coarser than `jobKind`, so a
 * recurring generator that spreads its launches over many areas (RECUTAPI, RECUTCLI, ...) is judged as one.
 */

import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { FILLER_ID, yieldTally, type YieldReport, type YieldRow, type YieldRun } from './slot-yield.js';
import { dirname, join } from 'node:path';
import { runsRoot } from '../metrics/loop-collect.js';
import { readText } from './empty-cause.js';
import { classifyYieldEmpty, YIELD_EMPTY_LABELS, type YieldEmptyReason } from './empty-why-classify.js';

export const FAMILY_YIELD_SCHEMA = 'fleet.family-yield.v1';
/** Finished runs a family needs in the window before it can be told to stop. */
export const FAMILY_STOP_MIN_FINISHED = 6;
/** Merged per launch under this, with enough finished runs, is stop. */
export const FAMILY_STOP_RATE = 0.2;
/** Merged per launch under this is watch. */
export const FAMILY_WATCH_RATE = 0.4;
/** How long a printed stop row lasts. */
export const FAMILY_STOP_HOURS = 24;

export type FamilyVerdict = 'keep' | 'watch' | 'stop';

export interface FamilyYieldRow {
  family: string;
  /** Distinct job ids seen in the family. */
  jobs: number;
  /** Launch slots used; a job launched twice counts twice. */
  launches: number;
  finished: number;
  empty: number;
  prs: number;
  merged: number;
  /** Launches whose merge was recorded as reverted; never counted in `merged`. */
  reverted: number;
  merged_per_launch: number;
  /** Sum over runs that reported tokens; null when none did (unknown, not zero). */
  tokens_total: number | null;
  /** Ended runs with no token count. When above 0, the token sums are lower bounds. */
  tokens_unknown: number;
  /** Null unless something merged and every ended run reported tokens. */
  tokens_per_merged: number | null;
  /** Tokens spent on runs that did not merge; null when none of those reported tokens. */
  wasted_tokens: number | null;
  /** True when some unmerged run reported no tokens, so `wasted_tokens` is a lower bound. */
  wasted_tokens_partial: boolean;
  /** ISO time of the newest timestamped row for the family. */
  last_seen: string;
  verdict: FamilyVerdict;
  /** The counts behind the verdict, in plain words. */
  reason: string;
}

/** One ready-to-use job stop file row: `<pattern>\t<until>\t<reason>`. */
export interface FamilyStopRow { family: string; pattern: string; until: number; reason: string; line: string }

/** Exact recurring name; unlike stop-policy families, internal digits and areas stay distinct. */
export const launchFamily = (id: string): string => id.replace(/\d+[A-Za-z]?$/, '');
export type FamilyFinish = { empty: boolean; reason: YieldEmptyReason; at: number };
/** Last N finished launches, ordered by launch time; running launches never consume the sample. */
export function shouldPauseFamily(stats: { recent_finishes: readonly FamilyFinish[] } | undefined, n = 4): boolean {
  const last = stats?.recent_finishes.slice().sort((a, b) => b.at - a.at).slice(0, n) ?? [];
  return Number.isSafeInteger(n) && n > 0 && last.length === n
    && last.every(r => r.empty && (r.reason === 'no_eligible_source' || r.reason === 'no_diff'));
}
export const pausedFamily = (rows: readonly LaunchFamilyYield[], id: string): boolean =>
  shouldPauseFamily(rows.find(row => row.family === launchFamily(id)));
export const readLaunchFamilies = async (root = runsRoot(), now = Date.now()): Promise<LaunchFamilyYield[]> =>
  (await readFamilyYield(join(root, 'metrics/jobs.jsonl'), 24, now)).launch_families;
export type LaunchFamilyYield = Pick<FamilyYieldRow, 'family' | 'launches' | 'prs' | 'merged' | 'empty' | 'merged_per_launch'> & {
  empty_tokens: number | null;
  empty_tokens_partial: boolean;
  sentence: string;
  empty_reasons: Record<YieldEmptyReason, number>;
  recent_finishes: FamilyFinish[];
  paused: boolean;
};

function launchFamilies(runs: readonly YieldRun[]): LaunchFamilyYield[] {
  const groups = new Map<string, YieldRun[]>();
  for (const run of runs) {
    const family = launchFamily(run.job), group = groups.get(family) ?? [];
    group.push(run); groups.set(family, group);
  }
  return [...groups].map(([family, group]): LaunchFamilyYield => {
    const row = familyRow(family, group), empty = group.filter(r => r.empty);
    const empty_reasons = Object.fromEntries(Object.keys(YIELD_EMPTY_LABELS).map(k => [k, 0])) as Record<YieldEmptyReason, number>;
    for (const run of empty) empty_reasons[run.empty_reason ?? 'unknown']++;
    const top = (Object.keys(empty_reasons) as YieldEmptyReason[]).sort((a, b) => empty_reasons[b] - empty_reasons[a])[0]!;
    const recent_finishes = group.filter(r => r.finished).map(r => ({ empty: r.empty && !r.merged && r.prs.size === 0, reason: r.empty_reason ?? 'unknown', at: r.at })).sort((a, b) => b.at - a.at);
    const tokens = knownSum(empty.map(r => r.tokens)), partial = empty.some(r => r.tokens === null);
    const amount = tokens === null ? 'unknown tokens' : `${partial ? 'at least ' : ''}${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} tokens`;
    return { family, launches: row.launches, prs: row.prs, merged: row.merged, empty: row.empty,
      merged_per_launch: row.merged_per_launch, empty_tokens: tokens, empty_tokens_partial: partial,
      empty_reasons, recent_finishes, paused: shouldPauseFamily({ recent_finishes }),
      sentence: `${family.replace(/^RQ-(?:PHX-)?/, '')}: ${row.merged} of ${row.launches} merged, ${amount} on empty runs${row.empty ? `; ${row.empty} of ${row.launches} empty, mostly '${YIELD_EMPTY_LABELS[top]}'` : ''}` };
  }).sort((a, b) => a.merged_per_launch - b.merged_per_launch || (b.empty_tokens ?? -1) - (a.empty_tokens ?? -1)
    || b.launches - a.launches || a.family.localeCompare(b.family));
}

/** `known: false` means the metrics file could not be read: totals are null and every list is empty. */
export interface FamilyYieldReport {
  schema: typeof FAMILY_YIELD_SCHEMA;
  version: 1;
  window_hours: number;
  known: boolean;
  /** Precise launch families, lowest merged-per-launch first, then most EMPTY tokens. */
  launch_families: LaunchFamilyYield[];
  launches: number | null;
  merged: number | null;
  /** Launches whose merge was recorded as reverted; null when the read is unknown. */
  reverted: number | null;
  wasted_tokens: number | null;
  wasted_tokens_partial: boolean | null;
  /** Families with two or more job ids, most wasted tokens first. */
  families: FamilyYieldRow[];
  /** Families of one job id (ids with no number, or one-off ids), same order. */
  single: FamilyYieldRow[];
  /** One row per stop family. Each pattern matches exactly the ids that collapse to its family. */
  stops: FamilyStopRow[];
  /** Same rows as `phm fleet yield` always showed, by lane and tier. */
  lanes: YieldRow[];
  tiers: YieldRow[];
}

const escapeEre = (text: string): string => text.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
/** Collapse every digit run except a closing `Q8` queue stamp, which is part of the name. */
const digitsCollapsed = (id: string) => {
  const stamp = id.endsWith('Q8') ? 'Q8' : '', text = id.slice(0, id.length - stamp.length);
  return { family: text.replace(/\d+/g, '*') + stamp, pattern: text.split(/\d+/).map(escapeEre).join('[0-9]+') + stamp };
};

/**
 * The family of a job id and an anchored ERE for it; null when the id has no number (its own family).
 *
 * - Filler ids collapse every number: `RQ-MD12A111815Q8` -> `RQ-MD*A*Q8`.
 * - A last word of a five-letter kind, a free-text area and a `C<cycle>` suffix drops the area too:
 *   `RQ-PHX-RECUTAPIC606` and `RQ-PHX-RECUTCLIC607` -> `RQ-PHX-RECUT*C*`.
 * - Any other id collapses each digit run: `RQ-CL-DESK-1795042045` -> `RQ-CL-DESK-*`.
 */
export function collapseFamily(id: string): { family: string; pattern: string } | null {
  if (!/\d/.test(id)) return null;
  const out = FILLER_ID.test(id) ? digitsCollapsed(id) : null;
  if (out) return { family: out.family, pattern: `^${out.pattern}$` };
  const cycle = /^(.*-)?([A-Z]{5})[A-Z]+C\d+$/.exec(id);
  if (cycle) {
    const head = cycle[1] ?? '';
    return { family: `${head}${cycle[2]}*C*`, pattern: `^${escapeEre(head)}${cycle[2]}[A-Z]+C[0-9]+$` };
  }
  const plain = digitsCollapsed(id);
  return { family: plain.family, pattern: `^${plain.pattern}$` };
}

/** stop: 6+ finished runs and merged per launch under 0.2. watch: under 0.4. keep: the rest. */
export function familyVerdict(row: Pick<FamilyYieldRow, 'finished' | 'merged_per_launch'>): FamilyVerdict {
  if (row.finished >= FAMILY_STOP_MIN_FINISHED && row.merged_per_launch < FAMILY_STOP_RATE) return 'stop';
  return row.merged_per_launch < FAMILY_WATCH_RATE ? 'watch' : 'keep';
}

const running = (r: YieldRun) => !r.finished && !r.empty && !r.aborted && !r.merged && !r.reverted && r.prs.size === 0;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** Sum of the known values; null when there are none but some are unknown. */
const knownSum = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length || !values.length ? sum(known) : null;
};

function familyRow(family: string, runs: YieldRun[]): FamilyYieldRow {
  const ended = runs.filter(r => !running(r));
  const merged = runs.filter(r => r.merged).length;
  const reverted = runs.filter(r => r.reverted).length;
  const measured = runs.filter(r => r.tokens !== null);
  const tokensTotal = measured.length ? sum(measured.map(r => r.tokens!)) : null;
  const tokensUnknown = ended.filter(r => r.tokens === null).length;
  const unmerged = ended.filter(r => !r.merged);
  const wasted = knownSum(unmerged.map(r => r.tokens));
  const base = {
    family,
    jobs: new Set(runs.map(r => r.job)).size,
    launches: runs.length,
    finished: runs.filter(r => r.finished).length,
    empty: runs.filter(r => r.empty).length,
    prs: sum(runs.map(r => r.prs.size)),
    merged,
    reverted,
    merged_per_launch: merged / runs.length,
    tokens_total: tokensTotal,
    tokens_unknown: tokensUnknown,
    tokens_per_merged: merged > 0 && tokensTotal !== null && tokensUnknown === 0 ? tokensTotal / merged : null,
    wasted_tokens: wasted,
    wasted_tokens_partial: wasted !== null && unmerged.some(r => r.tokens === null),
    last_seen: new Date(Math.max(...runs.map(r => r.last))).toISOString(),
  };
  const verdict = familyVerdict(base);
  const reason = [`${merged} merged of ${base.launches} launch${base.launches === 1 ? '' : 'es'}`,
    reverted ? `${reverted} reverted` : '', `${base.empty} empty`,
    wasted === null ? 'wasted tokens unknown' : `${wasted}${base.wasted_tokens_partial ? '+' : ''} tokens on unmerged runs`].filter(Boolean).join(', ');
  return { ...base, verdict, reason };
}

/** Most wasted tokens first (unknown after known), then most launches, then name. */
const byWaste = (a: FamilyYieldRow, b: FamilyYieldRow) =>
  (b.wasted_tokens ?? -1) - (a.wasted_tokens ?? -1) || b.launches - a.launches || a.family.localeCompare(b.family);

/** The report from the tally's runs. `lanesTiers` carries the existing lane and tier rows through unchanged. */
export function familyYieldFromRuns(runs: readonly YieldRun[], now: number, hours: number, lanesTiers: Pick<YieldReport, 'lanes' | 'tiers'> = { lanes: [], tiers: [] }): FamilyYieldReport {
  const groups = new Map<string, { pattern: string; runs: YieldRun[] }>();
  for (const run of runs) {
    const hit = collapseFamily(run.job) ?? { family: run.job, pattern: `^${escapeEre(run.job)}$` };
    const group = groups.get(hit.family);
    if (group) group.runs.push(run); else groups.set(hit.family, { pattern: hit.pattern, runs: [run] });
  }
  const rows = [...groups].map(([family, g]) => familyRow(family, g.runs)).sort(byWaste);
  const until = Math.floor(now / 1000) + FAMILY_STOP_HOURS * 3600;
  const stops = rows.filter(r => r.verdict === 'stop').map((row): FamilyStopRow => {
    const pattern = groups.get(row.family)!.pattern, reason = `yield_${row.merged}of${row.launches}_empty${row.empty}`;
    return { family: row.family, pattern, until, reason, line: `${pattern}\t${until}\t${reason}` };
  });
  return {
    schema: FAMILY_YIELD_SCHEMA, version: 1, window_hours: hours, known: true,
    launch_families: launchFamilies(runs),
    launches: runs.length, merged: runs.filter(r => r.merged).length, reverted: runs.filter(r => r.reverted).length,
    wasted_tokens: knownSum(rows.map(r => r.wasted_tokens)),
    wasted_tokens_partial: rows.some(r => r.wasted_tokens_partial || r.wasted_tokens === null),
    families: rows.filter(r => r.jobs > 1), single: rows.filter(r => r.jobs === 1),
    stops, lanes: lanesTiers.lanes, tiers: lanesTiers.tiers,
  };
}

/** Pure: job metric ledger lines (launch, finish, publish, outcome) in, family report out. */
export function familyYield(lines: Iterable<string>, now: number, hours: number): FamilyYieldReport {
  const tally = yieldTally(now, hours);
  for (const line of lines) tally.add(line);
  return familyYieldFromRuns(tally.runs(), now, hours, tally.report());
}

export function unknownFamilyYield(hours: number): FamilyYieldReport {
  return { schema: FAMILY_YIELD_SCHEMA, version: 1, window_hours: hours, known: false, launches: null, merged: null, reverted: null,
    launch_families: [],
    wasted_tokens: null, wasted_tokens_partial: null, families: [], single: [], stops: [], lanes: [], tiers: [] };
}

/** Stream a metrics file through the shared tally; an unreadable file is unknown, never zero. */
export async function readFamilyYield(path: string, hours: number, now: number, read: YieldLineReader = readLedgerLines): Promise<FamilyYieldReport> {
  const tally = yieldTally(now, hours);
  if (!await read(path, line => tally.add(line)).catch(() => false)) return unknownFamilyYield(hours);
  const runs = tally.runs(), latest = new Map(runs.map(r => [r.job, r]));
  // Files are overwritten on retries: only the newest attempt may use their evidence.
  for (let i = 0; i < runs.length; i += 16) await Promise.all(runs.slice(i, i + 16).map(async (run, offset) => {
    if (!run.empty || run.empty_reason && run.empty_reason !== 'unknown' || latest.get(run.job) !== run || !/^[\w.-]+$/.test(run.job)) return;
    const texts = await Promise.all(['log', 'publish'].map(ext => readText(join(dirname(path), '..', `${run.job}.${ext}`), 65536)));
    runs[i + offset] = { ...run, empty_reason: (['precheck_skip', 'worker_error', 'no_eligible_source', 'no_diff'] as const).find(reason => texts.some(text => classifyYieldEmpty(text) === reason)) ?? 'unknown' };
  }));
  return familyYieldFromRuns(runs, now, hours, tally.report());
}
