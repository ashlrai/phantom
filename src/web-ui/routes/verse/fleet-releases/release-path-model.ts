import type { OpsRepoReleaseV1 } from '../../../../core/verse/ops-types.js';
import { formatRelative, UNKNOWN as NO_TIME } from '../autonomy/format.js';
import type { ReleasePr } from '../fleet/release-pr-query.js';
import { releaseLabel, runTone } from './fleet-releases-model.js';

/**
 * The four stations a change passes on its way out, in order. Each station is
 * one recorded fact; a fact the reads do not hold is `unknown`, which draws a
 * hollow ring. `idle` means the read says nothing is there (no commits waiting,
 * no PR open), which is a known answer and not the same as unknown.
 */
export type StationTone = 'unknown' | 'idle' | 'active' | 'ok' | 'warn' | 'danger';
export interface Station { id: 'unreleased' | 'pr' | 'run' | 'published'; label: string; value: string; detail: string | null; tone: StationTone }

/** `undefined` = the release PR read holds nothing for this repo; `null` = it says no PR is open. */
export type ReleasePrFact = { pr: ReleasePr | null; blockMerge: boolean } | undefined;

const UNKNOWN = 'unknown';
/** A time the read does not hold says so in words; a dash under a station reads as a blank. */
const ago = (iso: string | null | undefined, nowMs: number) => {
  const text = formatRelative(iso, nowMs);
  return text === NO_TIME ? 'time unknown' : text;
};
const words = (value: string) => value.replace(/_/g, ' ');
const commits = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

function prStation(fact: ReleasePrFact, nowMs: number): Omit<Station, 'id' | 'label'> {
  if (fact === undefined) return { value: UNKNOWN, detail: null, tone: 'unknown' };
  const pr = fact.pr;
  if (pr === null) return { value: 'none open', detail: null, tone: 'idle' };
  const opened = `open since ${ago(pr.openedAt, nowMs)}`;
  const state = fact.blockMerge ? 'version downgrade' : pr.mergeable === 'CONFLICTING' ? 'merge conflicts'
    : pr.blocked || pr.failing.length > 0 ? 'blocked' : pr.pending > 0 ? 'checks running' : 'checks green';
  const tone = state === 'checks green' ? 'ok' : state === 'checks running' ? 'warn' : 'danger';
  return { value: `#${pr.number} ${state}`, detail: opened, tone };
}

export function releasePath(repo: OpsRepoReleaseV1, fact: ReleasePrFact, nowMs: number): Station[] {
  const count = repo.commitsSinceTag;
  const unreleased: Omit<Station, 'id' | 'label'> = count == null ? { value: UNKNOWN, detail: null, tone: 'unknown' }
    : { value: commits(count), detail: `since ${repo.latestTag ?? 'unknown tag'}`, tone: count > 0 ? 'active' : 'idle' };
  const run = repo.gh?.latestRun;
  const runTones = { ok: 'ok', warn: 'warn', danger: 'danger', neutral: 'active' } as const;
  const runStation: Omit<Station, 'id' | 'label'> = repo.gh === null ? { value: UNKNOWN, detail: null, tone: 'unknown' }
    : !run ? { value: 'none recorded', detail: null, tone: 'idle' }
    : { value: words(run.conclusion ?? run.status), detail: `${run.workflow} · ${ago(run.at, nowMs)}`, tone: runTones[runTone(run)] };
  const release = repo.gh?.latestRelease;
  const label = release ? releaseLabel(release) : null;
  const published: Omit<Station, 'id' | 'label'> = repo.gh === null ? { value: UNKNOWN, detail: null, tone: 'unknown' }
    : !release || !label ? { value: 'none', detail: null, tone: 'idle' }
    : { value: label.badge ? `${release.tag} ${label.badge}` : release.tag, tone: label.badge ? 'warn' : 'ok',
      detail: [release.name && release.name !== release.tag ? release.name : null, ago(release.publishedAt, nowMs)].filter(Boolean).join(' · ') };
  return [
    { id: 'unreleased', label: 'Unreleased', ...unreleased },
    { id: 'pr', label: 'Release PR', ...prStation(fact, nowMs) },
    { id: 'run', label: 'Release run', ...runStation },
    { id: 'published', label: 'Published', ...published },
  ];
}

/** One sentence over every repo: how many hold commits no release carries yet. Unknown counts are named, never folded into zero. */
export function waitingHeadline(repos: readonly OpsRepoReleaseV1[]): string {
  if (repos.length === 0) return 'No repos reported.';
  const unknown = repos.filter(repo => repo.commitsSinceTag == null).length;
  if (unknown === repos.length) return 'Unreleased commits are unknown for every repo.';
  const waiting = repos.filter(repo => (repo.commitsSinceTag ?? 0) > 0);
  const total = waiting.reduce((sum, repo) => sum + (repo.commitsSinceTag ?? 0), 0);
  const lead = waiting.length === 0 ? 'Nothing is waiting for a release'
    : `${commits(total)} waiting for a release in ${waiting.length} of ${repos.length} repo${repos.length === 1 ? '' : 's'}`;
  return `${lead}${unknown ? `, ${unknown} unknown` : ''}.`;
}
