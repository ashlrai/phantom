// Pure shape of `phm releases`: no node imports, so the web bundle can use it.
/**
 * Release cadence in one place: for each enrolled Ashlr repo, the latest tag on
 * the default branch, how old it is, what merged since, whether the changelog's
 * Unreleased section covers it, and one plain next action. A field whose source
 * is missing is `{ state: 'unknown', reason }`, never zero. Read-only: nothing
 * here creates a tag, a release or a PR.
 */
import type { HomeField } from '../fleet/home.js';

export const RELEASES_SCHEMA = 'phantom.releases.v1';
export type Field<T> = HomeField<T>;
export const RELEASE_NEXT_ACTIONS = ['ready: open release PR', 'write changelog', 'nothing to release', 'unknown'] as const;
export type ReleaseNext = typeof RELEASE_NEXT_ACTIONS[number];
/** covers: the Unreleased section has entries and CHANGELOG.md changed since the tag (or there is no tag yet). */
export type ChangelogState = 'covers' | 'no-file' | 'no-unreleased-section' | 'unreleased-empty' | 'not-updated-since-tag';

export interface ReleaseRowV1 {
  repo: string;
  defaultBranch: Field<string>;
  /** null: the default branch has no tags yet. */
  latestTag: Field<{ name: string; ageDays: number } | null>;
  /** First-parent commits on the default branch since the tag (all of them when there is no tag). */
  commitsSinceTag: Field<number>;
  /** Distinct PR numbers named by those commits (squash `(#N)` or merge commits). */
  mergedPrsSinceTag: Field<number>;
  changelog: Field<ChangelogState>;
  next: ReleaseNext;
  /** One plain sentence explaining `next`. */
  why: string;
}
/** The field the Home summary reuses: repo names grouped by next action. */
export interface ReleasesSummaryV1 {
  headline: string;
  ready: string[]; writeChangelog: string[]; nothingToRelease: string[]; unknown: string[];
}
export interface ReleasesV1 { schema: typeof RELEASES_SCHEMA; asOf: string; repos: ReleaseRowV1[]; summary: ReleasesSummaryV1 }

const list = (names: string[]): string => names.join(', ');

/** Pure: group rows by next action and say the most important thing first. */
export function summarizeReleases(rows: readonly ReleaseRowV1[]): ReleasesSummaryV1 {
  const pick = (next: ReleaseNext) => rows.filter(row => row.next === next).map(row => row.repo);
  const ready = pick('ready: open release PR'), writeChangelog = pick('write changelog');
  const nothingToRelease = pick('nothing to release'), unknown = pick('unknown');
  const parts = [
    ready.length ? `Ready to release: ${list(ready)}.` : '',
    writeChangelog.length ? `Write a changelog first: ${list(writeChangelog)}.` : '',
    unknown.length ? `Unknown: ${list(unknown)}.` : '',
  ].filter(Boolean);
  const headline = parts.length ? parts.join(' ') : rows.length ? 'Nothing to release.' : 'No repos to check.';
  return { headline, ready, writeChangelog, nothingToRelease, unknown };
}

/** The Home summary field: the release summary, or unknown when the report could not be read. */
export function releasesHomeField(report: ReleasesV1 | null): Field<ReleasesSummaryV1> {
  return report ? { state: 'ok', value: report.summary } : { state: 'unknown', reason: 'The release report could not be read.' };
}

const show = <T>(field: Field<T>, text: (value: T) => string): string => field.state === 'ok' ? text(field.value) : 'unknown';

/** One plain line per repo, the same facts as the JSON. */
export function releaseRowLine(row: ReleaseRowV1): string {
  const tag = show(row.latestTag, tag => tag ? `${tag.name} (${tag.ageDays} day${tag.ageDays === 1 ? '' : 's'} old)` : 'no tags yet');
  return `${row.repo}: ${row.next}. ${row.why} Tag ${tag}; ${show(row.commitsSinceTag, String)} commits, ${show(row.mergedPrsSinceTag, String)} PRs since; changelog ${show(row.changelog, String)}.`;
}

const isField = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const field = value as Record<string, unknown>;
  return (field.state === 'ok' && 'value' in field) || (field.state === 'unknown' && typeof field.reason === 'string');
};
/** Narrow an untrusted response (web client) to the typed shape, or null. */
export function narrowReleases(raw: unknown): ReleasesV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const report = raw as Record<string, unknown>, summary = report.summary as Record<string, unknown> | undefined;
  const names = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
  const rowOk = (value: unknown) => {
    const row = value as Record<string, unknown> | null;
    return !!row && typeof row.repo === 'string' && typeof row.why === 'string' && (RELEASE_NEXT_ACTIONS as readonly unknown[]).includes(row.next)
      && [row.defaultBranch, row.latestTag, row.commitsSinceTag, row.mergedPrsSinceTag, row.changelog].every(isField);
  };
  return report.schema === RELEASES_SCHEMA && typeof report.asOf === 'string' && Array.isArray(report.repos) && report.repos.every(rowOk)
    && !!summary && typeof summary.headline === 'string' && ['ready', 'writeChangelog', 'nothingToRelease', 'unknown'].every(key => names(summary[key]))
    ? raw as ReleasesV1 : null;
}
