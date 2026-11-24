/**
 * Pure shaping for Home's Running jobs and Main cards. Everything here is arithmetic over the two lists the `phm home`
 * summary (home.v1) already holds: `running` (lane, running, target) and `main` (repo, state). Nothing is estimated;
 * a lane with no recorded target has no share and no slots, and an unknown repo stays unknown.
 */
import type { HomeSummary } from '../../../../core/fleet/home.js';

type Known<K extends 'running' | 'main'> = Extract<HomeSummary[K], { state: 'ok' }>['value'];
export type HomeLane = Known<'running'>[number];
export type HomeRepo = Known<'main'>[number];

/** Above this many slots a lane draws one bar instead of a square per slot. */
export const PIP_LIMIT = 24;

export interface LaneTile {
  lane: string; running: number; target: number | null;
  /** Share of the target that is running, 0 to 100. Null when the lane has no target above zero. */
  percent: number | null;
  /** One entry per target slot, true while a job fills it. Null with no target, or with more slots than PIP_LIMIT. */
  pips: boolean[] | null;
  /** Jobs running beyond the target. */
  over: number;
  /** The same sentence `phm home` prints for the lane. */
  words: string;
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

export function laneTiles(lanes: readonly HomeLane[]): LaneTile[] {
  return lanes.map(({ lane, running, target }) => {
    const measured = target !== null && target > 0;
    return {
      lane, running, target,
      percent: measured ? Math.min(100, Math.round((running / target) * 100)) : null,
      pips: measured && target <= PIP_LIMIT ? Array.from({ length: target }, (_, slot) => slot < running) : null,
      over: target !== null && running > target ? running - target : 0,
      words: `${lane}: ${running}${target === null ? '' : ` of ${target}`}`,
    };
  });
}

/** One line over the tiles: jobs running and on how many lanes, then how many target slots they fill. */
export function lanesSummary(lanes: readonly HomeLane[]): string {
  const total = lanes.reduce((sum, lane) => sum + lane.running, 0);
  const busy = lanes.filter(lane => lane.running > 0).length;
  const targeted = lanes.filter((lane): lane is HomeLane & { target: number } => lane.target !== null);
  const asked = targeted.reduce((sum, lane) => sum + lane.target, 0);
  const filled = targeted.reduce((sum, lane) => sum + Math.min(lane.running, lane.target), 0);
  const untargeted = lanes.length - targeted.length;
  return [
    total === 0 ? `No job is running on ${lanes.length === 1 ? 'the one lane' : `any of the ${lanes.length} lanes`}.` : `${plural(total, 'job')} running on ${busy} of ${plural(lanes.length, 'lane')}.`,
    asked > 0 ? `${filled} of ${plural(asked, 'target slot')} filled.` : '',
    untargeted > 0 ? `${plural(untargeted, 'lane')} ${untargeted === 1 ? 'has' : 'have'} no target.` : '',
  ].filter(Boolean).join(' ');
}

const ORDER: Record<HomeRepo['state'], number> = { red: 0, unknown: 1, green: 2 };

/** Red first, then unknown, then green; the summary's own order is kept within each. */
export function repoMarks(repos: readonly HomeRepo[]): HomeRepo[] {
  return repos.map((repo, index) => ({ repo, index })).sort((a, b) => ORDER[a.repo.state] - ORDER[b.repo.state] || a.index - b.index).map(({ repo }) => repo);
}

export interface MainSummary { tone: 'red' | 'unknown' | 'green'; text: string }

/** One line over the marks. Green is only said when every repo is green. */
export function mainSummary(repos: readonly HomeRepo[]): MainSummary {
  const named = (state: HomeRepo['state']) => repos.filter(repo => repo.state === state).map(repo => repo.repo);
  const red = named('red'), unsure = named('unknown');
  const branches = plural(repos.length, 'default branch', 'default branches');
  if (red.length) return { tone: 'red', text: `${red.length} of ${branches} red: ${red.join(', ')}.${unsure.length ? ` Not known for ${unsure.join(', ')}.` : ''}` };
  if (unsure.length) return { tone: 'unknown', text: `${repos.length - unsure.length} of ${branches} green. Not known for ${unsure.join(', ')}.` };
  return { tone: 'green', text: repos.length === 1 ? 'The one default branch is green.' : `All ${repos.length} default branches are green.` };
}
