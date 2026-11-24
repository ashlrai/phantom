/**
 * routes/verse/leader-thread/composer-lane-commands.ts: the Leader reply
 * box's lane commands. `/lanes` says, in one line, how every lane stands:
 * what is running against what was asked for, which lanes are held or down
 * and why, what is waiting, and when the dispatcher last ticked. `/lane
 * <lane>` says the same for one lane and names the jobs running on it, so
 * each can be opened from the line.
 *
 * Both read what the Lanes board reads: `GET /api/verse/fleet/runs` (`phm
 * fleet runs --json`) and, for the time a hold ends and a lane's target
 * bounds, `GET /api/verse/fleet/control/lanes`. They write nothing, so they
 * need no unlock and post no inbox note. Nothing is invented: a reading the
 * snapshot does not hold is "unknown", and a read that does not answer says
 * the lanes are unknown and why. They never throw.
 */
import { ApiError, readFailureReason } from '../../../data/client.js';
import { parseClaudeLane } from '../fleet-lanes/claude-lane-state.js';
import { repoShort } from '../fleet-lanes/fleet-lanes-model.js';
import { boardHeadline, laneCard, laneFacts, pulseLine, type LaneCard } from '../fleet-lanes/lanes-board-model.js';
import { clockTime } from '../leader/thread-model.js';
import { captionFor, type LaneTargetRow, type LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { laneTargetsQuery } from '../ops/lane-targets-queries.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';

export interface LaneCommandDeps {
  /** The live runs snapshot; null when this server does not serve it. */
  runs: () => Promise<FleetRuns | null>;
  /** Lane targets and holds; null when this server does not serve them. */
  targets: () => Promise<LaneTargetsV1 | null>;
}

export const liveLaneDeps: LaneCommandDeps = {
  runs: () => opsRunsQuery.fetch(),
  targets: () => laneTargetsQuery.fetch(),
};

/** Jobs named in a `/lane` line; the rest are counted. */
export const LANE_JOBS_LIMIT = 8;

type ClaudeLane = ReturnType<typeof parseClaudeLane>;

const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const bare = (text: string): string => text.trim().replace(/[.\s]+$/, '');

/** "held until 2:05 PM (quota reset pending)"; the end time only when the hold record has one. */
function heldWords(card: LaneCard, target: LaneTargetRow | undefined): string {
  const until = target?.heldUntil ? clockTime(target.heldUntil) : '';
  return `held${until ? ` until ${until}` : ''} (${bare(card.heldReason ?? target?.heldReason ?? '') || 'reason not recorded'})`;
}

const downWords = (claude: ClaudeLane): string =>
  `down${claude.reason ? ` (${bare(claude.reason)})` : ''}${claude.sinceText ? ` ${claude.sinceText}` : ''}`;

/** One lane in a few words: "claude 3 of 4", "glm held until 2:05 PM (provider outage), 1 running", "kimi target 0". */
export function laneWords(card: LaneCard, target: LaneTargetRow | undefined, claude: ClaudeLane): string {
  const waiting = card.queued > 0 ? `, ${card.queued} waiting` : '';
  if (card.state === 'down') return `${card.lane} ${downWords(claude)}, ${card.running} running${waiting}`;
  if (card.state === 'held') return `${card.lane} ${heldWords(card, target)}, ${card.running} running${waiting}`;
  if (card.state === 'off') return `${card.lane} target 0${waiting}`;
  return `${card.lane} ${card.running} of ${card.target}${waiting}`;
}

const ATTENTION: Readonly<Record<LaneCard['state'], number>> = { down: 0, held: 1, open: 2, over: 2, full: 2, off: 3 };

function cardsOf(runs: FleetRuns, nowMs: number): { cards: LaneCard[]; claude: ClaudeLane } {
  const claude = parseClaudeLane(runs.claudeLane, nowMs);
  return { cards: runs.lanes.map(lane => laneCard(lane, claude.down)), claude };
}

/** What the snapshot says about itself: the fleet pause, then a record that is not whole. */
function standing(runs: FleetRuns): string[] {
  const partial = runs.sources.runsDir !== 'healthy' || runs.sources.workers !== 'healthy';
  return [
    ...(runs.paused === true ? ['The fleet is paused.'] : runs.paused === null ? ['Whether the fleet is paused is unknown.'] : []),
    ...(partial ? ['The runs record is not whole, so these counts may be incomplete.'] : []),
  ];
}

/** `/lanes`: the board's headline, then every lane, the down and held ones first and the switched-off ones last. */
export function lanesLine(runs: FleetRuns, targets: LaneTargetsV1 | null, nowMs: number): string {
  if (runs.lanes.length === 0) return ['No lanes reported.', ...standing(runs), `${pulseLine(runs, nowMs)}.`].join(' ');
  const { cards, claude } = cardsOf(runs, nowMs);
  const rows = new Map(targets?.lanes.map(row => [row.lane, row]));
  const listed = cards.map((card, index) => ({ card, index }))
    .sort((a, b) => ATTENTION[a.card.state] - ATTENTION[b.card.state] || a.index - b.index)
    .map(({ card }) => laneWords(card, rows.get(card.lane), claude));
  return [
    `Lanes: ${boardHeadline(runs)}`,
    `${listed.join(' · ')}.`,
    ...standing(runs),
    `${pulseLine(runs, nowMs)}.`,
    '/lane <lane> names its jobs; /open fleet-lanes has the board.',
  ].join(' ');
}

export type NamedLane = { kind: 'one'; lane: string } | { kind: 'several'; names: string[] } | { kind: 'none' };

/** The lane a typed name means: the exact name first, then the only lane that starts with it. */
export function namedLane(runs: FleetRuns, typed: string): NamedLane {
  const needle = typed.trim().toLowerCase();
  if (!needle) return { kind: 'none' };
  const names = runs.lanes.map(lane => lane.lane);
  if (names.includes(needle)) return { kind: 'one', lane: needle };
  const starts = names.filter(name => name.startsWith(needle));
  if (starts.length === 1) return { kind: 'one', lane: starts[0]! };
  return starts.length === 0 ? { kind: 'none' } : { kind: 'several', names: starts };
}

/** "12 min", "2 h 5 min"; a job whose age was not read says so. */
function ageWords(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'age unknown';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'under a minute';
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/** `/lane <lane>`: where it stands, the jobs on it (oldest first), what is not running and why, and its labelled readings. */
export function laneLine(runs: FleetRuns, targets: LaneTargetsV1 | null, lane: string, nowMs: number): string {
  const { cards, claude } = cardsOf(runs, nowMs);
  const card = cards.find(item => item.lane === lane);
  if (!card) return `No lane is named "${lane}".`;
  const target = targets?.lanes.find(row => row.lane === lane);
  const waiting = card.queued > 0 ? `, ${card.queued} waiting` : '';
  const head = card.state === 'down' ? `${downWords(claude)}, ${card.running} running${waiting}`
    : card.state === 'held' ? `${heldWords(card, target)}, ${card.running} of ${card.target} running${waiting}`
      : card.state === 'off' ? `target 0, nothing running${waiting}`
        : `${card.running} of ${card.target} running${card.stateText && card.state !== 'full' ? `, ${card.stateText.toLowerCase()}` : ''}${waiting}`;
  const bounds = target ? [`Target ${target.target}, from ${target.floor} to ${target.ceiling}`, ...(target.held ? [] : [captionFor(target, nowMs)].filter(Boolean))].join(', ') : null;

  const workers = runs.workers.filter(worker => worker.lane === lane).sort((a, b) => (b.ageSeconds ?? -Infinity) - (a.ageSeconds ?? -Infinity));
  const named = workers.slice(0, LANE_JOBS_LIMIT).map(worker => `${worker.job} (${repoShort(worker.repo)}, ${worker.tier}, ${ageWords(worker.ageSeconds)})`);
  const more = workers.length - named.length;
  const jobs = workers.length === 0
    // The lane's own count is the claim; an empty worker list beside it is a gap, not "none".
    ? (card.running > 0 ? `The snapshot counts ${card.running} running but names no job.` : 'No job is running on it.')
    : `Running: ${named.join(' · ')}${more > 0 ? ` · and ${more} more` : ''}.`;
  const starting = (runs.claimed ?? []).filter(item => item.lane === lane).map(item => item.job);
  const stuck = (runs.notRunning ?? []).filter(item => item.job_or_lane === lane || workers.some(worker => worker.job === item.job_or_lane));

  return [
    `${lane}: ${head}.`,
    ...(bounds ? [`${bounds}.`] : []),
    jobs,
    ...(starting.length > 0 ? [`Claimed, not yet running: ${starting.join(' · ')}.`] : []),
    ...stuck.map(item => `Not running: ${sentence(item.reason)} ${sentence(item.unblock)}`),
    `${laneFacts(card).map(fact => `${fact.label} ${fact.value ?? 'unknown'}`).join(' · ')}.`,
    ...standing(runs),
  ].join(' ');
}

const unknownBecause = (error: unknown): string =>
  error instanceof ApiError && error.status === 404 ? 'Lanes are unknown: this server does not serve the live runs read.'
    : `Lanes are unknown. ${readFailureReason(error)}`;

/** Both reads at once. The runs snapshot is the answer; the targets read only adds to it, so its failure costs the hold's end time and the bounds, never the line. */
async function read(deps: LaneCommandDeps): Promise<{ runs: FleetRuns; targets: LaneTargetsV1 | null } | string> {
  const [runs, targets] = await Promise.allSettled([deps.runs(), deps.targets()]);
  if (runs.status === 'rejected') return unknownBecause(runs.reason);
  if (!runs.value) return 'Lanes are unknown: this server does not serve the live runs read.';
  return { runs: runs.value, targets: targets.status === 'fulfilled' ? targets.value : null };
}

/** `/lanes`. Never throws. */
export async function runLanesCommand(deps: LaneCommandDeps, nowMs: number): Promise<string> {
  const got = await read(deps);
  return typeof got === 'string' ? got : lanesLine(got.runs, got.targets, nowMs);
}

/** `/lane <lane>`: the lane's name, or enough of its start to fit one lane. Never throws. */
export async function runLaneCommand(typed: string, deps: LaneCommandDeps, nowMs: number): Promise<string> {
  const got = await read(deps);
  if (typeof got === 'string') return got;
  const named = namedLane(got.runs, typed);
  if (named.kind === 'several') return `"${typed}" fits ${named.names.join(', ')}. Type more of the name.`;
  if (named.kind === 'none') {
    const names = got.runs.lanes.map(lane => lane.lane);
    return `No lane is named "${typed}".${names.length > 0 ? ` The lanes are ${names.join(', ')}.` : ' No lanes reported.'}`;
  }
  return laneLine(got.runs, got.targets, named.lane, nowMs);
}
