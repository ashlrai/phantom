/**
 * build-stale.ts — what a `doctor.build.v1` report means for the fleet, in plain words. Pure and browser-safe
 * (type-only import): the `build-stale` pulse alert, the Leader card and the phone card all read it from here,
 * so the threshold and the wording exist once.
 *
 * Stale = more than BUILD_STALE_COMMITS commits behind master, or missing a commit that merged more than
 * BUILD_STALE_HOURS ago. Unknown is its own answer and never raises an alert, with one exception: a build that
 * cannot say which commit it is (nothing embedded at build time and no git checkout) can never be measured, so
 * it would read unknown forever. That is "unidentified", and it does raise the build-stale alert.
 */
import type { BuildLiveReport } from './build-live.js';

export const BUILD_STALE_COMMITS = 50;
export const BUILD_STALE_HOURS = 24;
export interface BuildStaleLimits { commits: number; hours: number }
export const DEFAULT_BUILD_STALE_LIMITS: BuildStaleLimits = { commits: BUILD_STALE_COMMITS, hours: BUILD_STALE_HOURS };

export type BuildStaleness = 'current' | 'behind' | 'stale' | 'unknown';

/** An older Mac's report has no `build` (or no `since`); both read as unknown or as "no date", never as current. */
export type MaybeBuildReport = Pick<Partial<BuildLiveReport>, 'commit' | 'behind'> | null | undefined;

const knownBehind = (r: MaybeBuildReport) => r?.commit?.state === 'known' && r.behind?.state === 'known' ? r.behind : null;
const sinceMs = (since: unknown): number => typeof since === 'string' ? Date.parse(since) : NaN;

export function buildStaleness(r: MaybeBuildReport, now: number, limits: BuildStaleLimits = DEFAULT_BUILD_STALE_LIMITS): BuildStaleness {
  const behind = knownBehind(r);
  if (!behind) return 'unknown';
  if (behind.count === 0) return 'current';
  const since = sinceMs(behind.since);
  return behind.count > limits.commits || (Number.isFinite(since) && now - since > limits.hours * 3_600_000) ? 'stale' : 'behind';
}

/** "Nov 12" (UTC, so every screen and test reads the same day). */
const day = (iso: string): string => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const commits = (n: number): string => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** The one card line: "Live build: current", "Live build: 644 behind (since Nov 12)", "Live build: unknown". */
export function liveBuildLine(r: MaybeBuildReport): string {
  const behind = knownBehind(r);
  if (!behind) return 'Live build: unknown';
  if (behind.count === 0) return 'Live build: current';
  return `Live build: ${behind.count} behind${Number.isFinite(sinceMs(behind.since)) ? ` (since ${day(behind.since as string)})` : ''}`;
}

/** The alert's two sentences, or null when the build is not stale. */
export function buildStaleText(r: MaybeBuildReport, now: number, limits: BuildStaleLimits = DEFAULT_BUILD_STALE_LIMITS): { detail: string; fix: string } | null {
  const behind = knownBehind(r);
  if (!behind || buildStaleness(r, now, limits) !== 'stale') return null;
  const since = Number.isFinite(sinceMs(behind.since)) ? ` (since ${day(behind.since as string)})` : '';
  return { detail: `The running phm is ${commits(behind.count)} behind master${since}. Merged fleet features are not live.`, fix: 'Fix: rebuild from master.' };
}

/** The alert's two sentences for a build with no identity (no embedded commit, no git checkout), or null when it has one. */
export function buildUnidentifiedText(r: MaybeBuildReport): { detail: string; fix: string } | null {
  if (!r || r.commit?.state !== 'unknown') return null;
  return { detail: `The running phm cannot say which commit it was built from (${r.commit.why}), so nobody can tell whether it is current.`, fix: 'Fix: rebuild from a master checkout.' };
}
