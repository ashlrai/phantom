/**
 * Next bets: the leader's hourly "what should run next" pick as a typed, read-only step.
 * Backs `phm bets suggest|explain` and GET /api/verse/fleet/control/ideas/bets. It only
 * suggests: nothing here writes a queue, a drop job or any other file.
 *
 * Every input comes from a report Phantom already keeps (no second source):
 *   lanes      readFleetRunsDirState  (`phm lanes --json`)       free slots, nothing queued
 *   pace       readUsagePace          (use_it_all in status.json) usage that expires unused
 *   yield      yieldTally             (`phm fleet yield`)         family empty rate, tier yield
 *   mains      readFleetMainHealth    (main guardian)             red main branches
 *   releases   probeReleases          (Ops Releases view)         commits since the last tag
 *   autonomy   readAutonomy           (`phm autonomy`)            releases shipped in 24 h
 * A reader that fails or answers "unknown" yields null: that signal is listed as unknown
 * and adds no suggestion. Score = sum of term points, where points = min(value, cap) * weight
 * (BET_WEIGHTS). Order is score descending, then id, so equal inputs give equal output.
 */
import { join } from 'node:path';
import { runsRoot } from '../metrics/loop-collect.js';
import { listEnrolled } from '../sandbox/policy.js';
import { readUsagePace, type PaceRow } from '../usage/pace.js';
import { scrubSecrets } from '../util/scrub.js';
import { opsRunner, probeReleases } from '../verse/ops-releases.js';
import type { OpsRepoReleaseV1 } from '../verse/ops-types.js';
import { readAutonomy, type AutonomyReport } from './autonomy.js';
import { DROP_JOB_TIERS } from './drop-job-writer.js';
import { readLedgerLines } from './ledger-lines.js';
import { readFleetMainHealth, type FleetMainHealthRepo } from './main-health.js';
import { readFleetRunsDirState, type FleetRunsLane } from './runs-dir-state.js';
import { jobFamily, yieldTally, YIELD_MIN_LAUNCHES, type YieldReport } from './slot-yield.js';
import { laneLaunchTarget } from './lane-launch-target.js';

export const NEXT_BETS_SCHEMA = 'fleet.next-bets.v1';
export const NEXT_BETS_UI_LIMIT = 5;
/** The documented weights. `cap` bounds the input value before it is multiplied. */
export const BET_WEIGHTS = {
  redMain: { weight: 1000, cap: 1 }, // a red main outranks everything: no other sum of terms reaches 1000
  fixAttempt: { weight: 10, cap: 10 }, // guardian fix attempts that did not clear the failure
  idleSlot: { weight: 40, cap: 5 }, // free slots (launch target minus running) on a lane with nothing queued and no hold
  poolWastePct: { weight: 2, cap: 100 }, // percent of a pool's usage projected to expire unused, from POOL_WASTE_MIN_PCT up
  releaseAgeDay: { weight: 4, cap: 30 }, // days since the last tag in a repo with commits after it
  unreleasedCommit: { weight: 1, cap: 40 }, // commits since the last tag
  noRecentRelease: { weight: 20, cap: 1 }, // 1 when the autonomy report counted no release in its window
  familyEmptyRate: { weight: -100, cap: 1 }, // penalty: empty share (0 to 1) of the suggestion's job family, once it has YIELD_MIN_LAUNCHES launches
} as const;
export const POOL_WASTE_MIN_PCT = 20;
/** Jobs the leader queues by hand all fall in slot-yield's `leader` family. */
const LEADER_FAMILY = 'leader';
const FALLBACK_LANE = 'claude';

export interface BetInputs {
  lanes: FleetRunsLane[] | null; pace: PaceRow[] | null; yield: YieldReport | null;
  mains: FleetMainHealthRepo[] | null; releases: OpsRepoReleaseV1[] | null; autonomy: AutonomyReport | null;
}
/** One injectable reader per signal; tests pass fixtures. */
export type BetReaders = { [K in keyof BetInputs]: () => Promise<BetInputs[K]> };
export type BetSignal = 'red-main' | 'idle-lane' | 'pool-waste' | 'release';
export interface BetTerm { input: keyof typeof BET_WEIGHTS; value: number; weight: number; points: number }
export interface BetSuggestion {
  id: string; rank: number; goal: string; lane: string; tier: string; repo: string | null;
  signal: BetSignal; numbers: Record<string, number | string | null>; family: string | null;
  score: number; terms: BetTerm[];
  /** Paste into the router queue to act (repo by its short name, as the queue writes it). Phantom never queues it for you. */
  queueLine: string;
}
export interface NextBetsReport {
  schema: typeof NEXT_BETS_SCHEMA; generatedAt: string; readOnly: true; weights: typeof BET_WEIGHTS;
  total: number; suggestions: BetSuggestion[];
  signals: { name: keyof BetInputs; status: 'ok' | 'unknown' }[];
}

const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';
// eslint-disable-next-line no-control-regex -- names come from local files; keep them printable and on one line.
const plain = (text: string): string => scrubSecrets(text.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 140);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const term = (input: BetTerm['input'], value: number): BetTerm => {
  const { weight, cap } = BET_WEIGHTS[input];
  return { input, value: round(value), weight, points: Math.round(Math.min(value, cap) * weight) };
};
const freeSlots = (lane: FleetRunsLane): number => lane.held || lane.healthy === false ? 0
  : Math.max(0, laneLaunchTarget(lane.target, lane.effectiveTarget) - lane.running);

/** Pure: rank suggestions from whatever inputs are known. */
export function suggestBets(inputs: BetInputs, now: number, limit = Number.MAX_SAFE_INTEGER): NextBetsReport {
  const drafts: Omit<BetSuggestion, 'rank' | 'score' | 'queueLine'>[] = [];
  const lanes = [...inputs.lanes ?? []].sort((a, b) => a.lane.localeCompare(b.lane));
  // Where repo-level work should go: the lane with the most room, by name on a tie.
  const roomiest = lanes.reduce<FleetRunsLane | null>((best, lane) => freeSlots(lane) > (best ? freeSlots(best) : 0) ? lane : best, null)?.lane ?? FALLBACK_LANE;
  // The tier with the best merged-per-launch among tiers with enough launches to judge.
  const bestTier = [...inputs.yield?.tiers ?? []]
    .filter(row => row.launches >= YIELD_MIN_LAUNCHES && (DROP_JOB_TIERS as readonly string[]).includes(row.name))
    .sort((a, b) => b.merged_per_launch - a.merged_per_launch || a.name.localeCompare(b.name))[0]?.name ?? 'work';

  for (const main of inputs.mains ?? []) {
    if (main.state !== 'red') continue;
    const attempts = main.fixJobs.length + main.emptyAttempts;
    const check = plain(main.failingCheck ?? 'the failing check');
    drafts.push({
      id: `red-main:${slug(main.repo)}`, signal: 'red-main', lane: roomiest, tier: 'frontier', repo: plain(main.repo),
      goal: `Fix ${check} on main in ${plain(main.repo)}${attempts ? `; ${plural(attempts, 'earlier fix attempt')} did not clear it` : ''}`,
      numbers: { failingCheck: main.failingCheck === null ? null : check, fixAttempts: attempts, emptyFixAttempts: main.emptyAttempts },
      family: main.fixJobs[0] ? jobFamily(main.fixJobs[0]) : null,
      terms: [term('redMain', 1), ...(attempts ? [term('fixAttempt', attempts)] : [])],
    });
  }

  const waste = new Map((inputs.pace ?? []).flatMap(row => row.unusedPercent !== null && row.unusedPercent >= POOL_WASTE_MIN_PCT ? [[row.pool, row] as const] : []));
  const byLane = new Map(lanes.map(lane => [lane.lane, lane]));
  for (const name of [...new Set([...byLane.keys(), ...waste.keys()])].sort()) {
    const lane = byLane.get(name), pool = waste.get(name);
    const free = lane && lane.queued === 0 ? freeSlots(lane) : 0;
    const launch = lane ? laneLaunchTarget(lane.target, lane.effectiveTarget) : null;
    // A held or unhealthy lane is a deliberate pause, not unused room.
    if (free === 0 && (!pool || lane?.held || lane?.healthy === false)) continue;
    const expiring = pool ? `about ${pool.unusedPercent}% of its usage expires unused${pool.hoursLeft === null ? '' : ` in ${plural(Math.round(pool.hoursLeft), 'hour')}`}` : '';
    drafts.push({
      id: `${free ? 'idle-lane' : 'pool-waste'}:${slug(name)}`, signal: free ? 'idle-lane' : 'pool-waste', lane: plain(name), tier: bestTier, repo: null,
      goal: free ? `Give ${plain(name)} work: ${free} of ${plural(launch!, 'slot')} free and nothing queued${expiring ? `; ${expiring}` : ''}` : `Route more work to ${plain(name)}: ${expiring}`,
      numbers: { running: lane?.running ?? null, target: lane?.target ?? null, effectiveTarget: lane?.effectiveTarget ?? null, queued: lane?.queued ?? null, freeSlots: lane ? free : null,
        unusedPercent: pool?.unusedPercent ?? null, hoursToReset: pool?.hoursLeft == null ? null : round(pool.hoursLeft, 1) },
      family: LEADER_FAMILY,
      terms: [...(free ? [term('idleSlot', free)] : []), ...(pool ? [term('poolWastePct', pool.unusedPercent!)] : [])],
    });
  }

  for (const release of inputs.releases ?? []) {
    const commits = release.commitsSinceTag ?? 0;
    if (commits <= 0) continue;
    const tagged = release.tagCommittedAt ? Date.parse(release.tagCommittedAt) : NaN;
    const days = Number.isFinite(tagged) && tagged <= now ? Math.floor((now - tagged) / 86_400_000) : null;
    const repo = plain(release.repo);
    drafts.push({
      id: `release:${slug(release.repo)}`, signal: 'release', lane: roomiest, tier: 'frontier', repo,
      goal: `Release ${repo}: ${plural(commits, 'commit')} since ${plain(release.latestTag ?? 'the last tag')}${days === null ? '' : `, tagged ${plural(days, 'day')} ago`}`,
      numbers: { commitsSinceTag: commits, latestTag: release.latestTag, daysSinceTag: days, releasesIn24h: inputs.autonomy?.releases ?? null },
      family: null,
      terms: [term('unreleasedCommit', commits), ...(days ? [term('releaseAgeDay', days)] : []), ...(inputs.autonomy?.releases === 0 ? [term('noRecentRelease', 1)] : [])],
    });
  }

  const ranked = drafts.map(draft => {
    const row = draft.family === null ? undefined : inputs.yield?.families.find(family => family.name === draft.family);
    const terms = row && row.launches >= YIELD_MIN_LAUNCHES && row.empty > 0 ? [...draft.terms, term('familyEmptyRate', row.empty / row.launches)] : draft.terms;
    return { ...draft, terms, score: terms.reduce((sum, t) => sum + t.points, 0) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const names: (keyof BetInputs)[] = ['lanes', 'pace', 'yield', 'mains', 'releases', 'autonomy'];
  return {
    schema: NEXT_BETS_SCHEMA, generatedAt: new Date(now).toISOString(), readOnly: true, weights: BET_WEIGHTS, total: ranked.length,
    suggestions: ranked.slice(0, Math.max(0, limit)).map((bet, index) => ({
      id: bet.id, rank: index + 1, goal: bet.goal, lane: bet.lane, tier: bet.tier, repo: bet.repo, signal: bet.signal, numbers: bet.numbers,
      family: bet.family, score: bet.score, terms: bet.terms,
      queueLine: `- READY RQ-NEXT-${bet.id.toUpperCase().replace(/[^A-Z0-9]+/g, '-')} (${bet.signal === 'red-main' ? 'P0' : 'P1'}, pool=${bet.lane}, tier=${bet.tier}${bet.repo ? `, repo=${bet.repo.split('/').pop()}` : ''}, src=bets): ${bet.goal}`,
    })),
    signals: names.map(name => ({ name, status: inputs[name] === null ? 'unknown' : 'ok' })),
  };
}

/** The existing readers, each reduced to "known data or null". */
export function defaultBetReaders(runsDir = runsRoot(), now = Date.now()): BetReaders {
  return {
    lanes: async () => { const state = await readFleetRunsDirState({ runsDir, now: () => now }); return state.sources.status === 'healthy' ? state.lanes : null; },
    pace: async () => { const rows = (await readUsagePace(join(runsDir, 'queue', 'status.json'))).pools.filter(row => row.unusedPercent !== null); return rows.length ? rows : null; },
    yield: async () => { const tally = yieldTally(now, 24); return await readLedgerLines(join(runsDir, 'metrics', 'jobs.jsonl'), line => tally.add(line)) ? tally.report() : null; },
    mains: async () => { const health = await readFleetMainHealth({ runsDir, now: () => now }); return health.source === 'ok' ? health.repos : null; },
    // Local git only: tags and commit counts need no network, so `gh` is never run here.
    releases: async () => { const paths = listEnrolled(); return paths.length ? probeReleases(paths, { run: (bin, args) => bin === 'gh' ? Promise.resolve(null) : opsRunner(bin, args) }) : null; },
    autonomy: () => readAutonomy({ runsDir, now }),
  };
}

/** Read every signal; a reader that throws is an unknown signal, never an error. */
export async function readNextBets(opts: { readers?: BetReaders; now?: number; limit?: number } = {}): Promise<NextBetsReport> {
  const now = opts.now ?? Date.now();
  const readers = opts.readers ?? defaultBetReaders(undefined, now);
  const names = Object.keys(readers) as (keyof BetInputs)[];
  const values = await Promise.all(names.map(name => readers[name]().catch(() => null)));
  return suggestBets(Object.fromEntries(names.map((name, i) => [name, values[i]])) as unknown as BetInputs, now, opts.limit);
}

const UNKNOWN_HINT: Record<keyof BetInputs, string> = {
  lanes: 'lane status', pace: 'usage pace', yield: 'launch yield', mains: 'main health', releases: 'releases', autonomy: 'autonomy score',
};
export const betNumbersText = (bet: BetSuggestion): string => Object.entries(bet.numbers).map(([key, value]) => `${key}=${value ?? 'unknown'}`).join(', ');
export function notCheckedBets(report: Pick<NextBetsReport, 'signals'>): string | null {
  const unknown = report.signals.filter(signal => signal.status === 'unknown').map(signal => UNKNOWN_HINT[signal.name] ?? signal.name);
  return unknown.length ? `Not checked: ${unknown.join(', ')}.` : null;
}
/** `phm bets suggest` as plain lines. */
export function nextBetsLines(report: NextBetsReport): string[] {
  const notChecked = notCheckedBets(report);
  const lines = report.suggestions.flatMap(bet => [
    `${bet.rank}. ${bet.goal} (score ${bet.score})`,
    `   ${bet.lane} · ${bet.tier} · ${bet.repo ?? 'any repo'} · ${bet.signal}: ${betNumbersText(bet)}`,
    `   Queue line: ${bet.queueLine}`,
  ]);
  if (!lines.length) lines.push(notChecked ? 'No suggestions from the signals that could be read.' : 'No suggestions: nothing is idle, red or unreleased.');
  else lines.push('Nothing was queued. Paste a queue line into the router queue to act; phm bets explain <id> shows the scoring.');
  return notChecked ? [...lines, notChecked] : lines;
}
/** `phm bets explain <id>` as plain lines: the inputs and each term of the score. */
export function explainBetLines(bet: BetSuggestion): string[] {
  return [
    `${bet.id}: ${bet.goal}`,
    `Lane ${bet.lane}, tier ${bet.tier}, repo ${bet.repo ?? 'any'}, job family ${bet.family ?? 'none'}.`,
    `Inputs: ${betNumbersText(bet)}`,
    ...bet.terms.map(t => `  ${t.input}: ${t.value} x ${t.weight}${t.value > BET_WEIGHTS[t.input].cap ? ` (capped at ${BET_WEIGHTS[t.input].cap})` : ''} = ${t.points}`),
    `Score: ${bet.score}`,
    `Queue line: ${bet.queueLine}`,
  ];
}
