/**
 * build-stale.ts — what a `doctor.build.v1` report means for the fleet, in plain words. Pure and browser-safe
 * (type-only import): the `build-stale` pulse alert, the Leader card and the phone card all read it from here,
 * so the threshold and the wording exist once.
 *
 * Stale = more than BUILD_STALE_COMMITS commits behind master, or missing a commit that merged more than
 * BUILD_STALE_HOURS ago. Unknown is its own answer and never raises an alert.
 */
import type { BuildLiveReport } from './build-live.js';

export const BUILD_STALE_COMMITS = 50;
export const BUILD_STALE_HOURS = 24;
export interface BuildStaleLimits { commits: number; hours: number }
export const DEFAULT_BUILD_STALE_LIMITS: BuildStaleLimits = { commits: BUILD_STALE_COMMITS, hours: BUILD_STALE_HOURS };

/** What the operator may save: whole numbers in these ranges. Env overrides keep their looser "any number >= 0" rule. */
export const BUILD_STALE_COMMITS_RANGE = { min: 1, max: 10_000 } as const;
export const BUILD_STALE_HOURS_RANGE = { min: 1, max: 8_760 } as const;
/** The saved half of the limits (config `fleet.buildStale`); null means "use the default". */
export interface SavedBuildStaleLimits { commits: number | null; hours: number | null }

const inRange = (n: unknown, r: { min: number; max: number }): n is number => typeof n === 'number' && Number.isInteger(n) && n >= r.min && n <= r.max;
export const validBuildStaleCommits = (n: unknown): n is number => inRange(n, BUILD_STALE_COMMITS_RANGE);
export const validBuildStaleHours = (n: unknown): n is number => inRange(n, BUILD_STALE_HOURS_RANGE);

/** Read the saved limits off whatever config holds; anything out of range or not a number reads as unset. */
export function savedBuildStaleLimits(raw: unknown): SavedBuildStaleLimits {
  const row = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  return { commits: validBuildStaleCommits(row['commits']) ? row['commits'] : null, hours: validBuildStaleHours(row['hours']) ? row['hours'] : null };
}

/**
 * The limits in force: ASHLR_BUILD_STALE_COMMITS / ASHLR_BUILD_STALE_HOURS win (a one-off override; junk is ignored),
 * then the saved Settings value, then the default.
 */
export function resolveBuildStaleLimits(saved: SavedBuildStaleLimits, env: Record<string, string | undefined> = {}): BuildStaleLimits & { envOverride: { commits: boolean; hours: boolean } } {
  const fromEnv = (raw: string | undefined): number | null => { const n = Number(raw); return raw && Number.isFinite(n) && n >= 0 ? n : null; };
  const commits = fromEnv(env['ASHLR_BUILD_STALE_COMMITS']);
  const hours = fromEnv(env['ASHLR_BUILD_STALE_HOURS']);
  return {
    commits: commits ?? saved.commits ?? BUILD_STALE_COMMITS,
    hours: hours ?? saved.hours ?? BUILD_STALE_HOURS,
    envOverride: { commits: commits !== null, hours: hours !== null },
  };
}

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
