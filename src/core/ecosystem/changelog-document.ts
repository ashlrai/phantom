/**
 * Deterministic rendering for collected ecosystem changelog evidence.
 *
 * Turns an `EcosystemChangelog` (src/core/ecosystem/changelog.ts) into the
 * `ecosystem-changelog.v1` JSON document emitted by `phm ecosystem changelog
 * --json` and written to docs/ecosystem-changelog.json, plus the llms-style
 * Markdown document written to ECOSYSTEM_CHANGELOG.md. Both renders share a
 * fixed "Last 14 days" summary section.
 *
 * No clock reads and no I/O happen here: the caller supplies `asOf`, so the
 * same inputs always produce byte-identical output.
 */

import type { EcosystemChangelog, EcosystemChange } from './changelog.js';
import type { StrategicTier } from './focus.js';

export const ECOSYSTEM_CHANGELOG_SCHEMA = 'ecosystem-changelog.v1';
export const ECOSYSTEM_CHANGELOG_MARKDOWN_PATH = 'ECOSYSTEM_CHANGELOG.md';
export const ECOSYSTEM_CHANGELOG_JSON_PATH = 'docs/ecosystem-changelog.json';
/** Fixed size of the rolling recent-activity summary window. */
export const ECOSYSTEM_CHANGELOG_RECENT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EcosystemChangelogWindow {
  /** ISO instant the `--since` filter resolved to; null when unfiltered. */
  since: string | null;
}

export interface EcosystemChangelogTotals {
  repositories: number;
  changes: number;
  changelog: number;
  releases: number;
  pullRequests: number;
  crossRepo: number;
}

export interface EcosystemChangelogRecent {
  days: number;
  /** asOf - days; the intended inclusive lower bound of the dated summary window. */
  since: string;
  changes: number;
  changelogEntries: number;
  releases: number;
  pullRequests: number;
  crossRepo: number;
  /** Repositories with at least one dated change inside the window. */
  repositories: number;
}

/** Document entries are an index: `url` carries the full body, so `body` is omitted. */
export type EcosystemChangelogEntry = Omit<EcosystemChange, 'body'>;

export interface EcosystemChangelogDocument {
  schema: typeof ECOSYSTEM_CHANGELOG_SCHEMA;
  generatedAt: string;
  complete: boolean;
  window: EcosystemChangelogWindow;
  totals: EcosystemChangelogTotals;
  recent14d: EcosystemChangelogRecent;
  repositories: Array<{
    repository: string;
    directory: string;
    tier: StrategicTier;
    sources: EcosystemChangelog['repositories'][number]['sources'];
    changes: EcosystemChangelogEntry[];
  }>;
}

export interface RenderEcosystemChangelogOptions {
  /** ISO instant the document claims as generation time; required for determinism. */
  asOf: string;
  /** Inclusive ISO cutoff for dated changes; undated entries always pass. */
  since?: string | null;
}

function parseInstant(value: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new Error(`Invalid ${what}: ${value}`);
  }
  const day = value.slice(0, 10);
  // Date.parse normalizes impossible days (February 30) instead of rejecting.
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid ${what}: ${value}`);
  }
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${what}: ${value}`);
  return new Date(ms).toISOString();
}

/**
 * Resolve a `--since` value against `asOf`. Accepts `<N>d` or `<N>h` windows or
 * an ISO date/datetime. Returns an ISO instant, or null when `since` is unset.
 */
export function parseEcosystemChangelogSince(since: string | undefined, asOf: string): string | null {
  const anchor = parseInstant(asOf, '--as-of timestamp');
  if (since === undefined) return null;
  const window = /^(\d+)([dh])$/.exec(since);
  if (window) {
    const amount = Number(window[1]);
    const ms = amount * (window[2] === 'd' ? DAY_MS : 60 * 60 * 1000);
    if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`Invalid --since window: ${since}`);
    return new Date(Date.parse(anchor) - ms).toISOString();
  }
  return parseInstant(since, '--since timestamp');
}

function inWindow(entry: EcosystemChange, since: string | null): boolean {
  // Undated changelog sections (pending releases) are not dated history; they
  // always pass the --since filter so pending notes stay visible.
  return since === null || entry.date === null || entry.date >= since;
}

function totals(repositories: EcosystemChangelogDocument['repositories']): EcosystemChangelogTotals {
  const sum: EcosystemChangelogTotals = {
    repositories: repositories.length, changes: 0, changelog: 0, releases: 0, pullRequests: 0, crossRepo: 0,
  };
  for (const repo of repositories) {
    for (const entry of repo.changes) {
      sum.changes += 1;
      if (entry.source === 'changelog') sum.changelog += 1;
      else if (entry.source === 'release') sum.releases += 1;
      else sum.pullRequests += 1;
      if (entry.crossRepo) sum.crossRepo += 1;
    }
  }
  return sum;
}

function recent(repositories: EcosystemChangelogDocument['repositories'], asOf: string): EcosystemChangelogRecent {
  const since = new Date(Date.parse(asOf) - ECOSYSTEM_CHANGELOG_RECENT_DAYS * DAY_MS).toISOString();
  const summary: EcosystemChangelogRecent = {
    days: ECOSYSTEM_CHANGELOG_RECENT_DAYS, since,
    changes: 0, changelogEntries: 0, releases: 0, pullRequests: 0, crossRepo: 0, repositories: 0,
  };
  for (const repo of repositories) {
    const hits = repo.changes.filter((entry) => entry.date !== null && entry.date >= since);
    if (hits.length > 0) summary.repositories += 1;
    for (const entry of hits) {
      summary.changes += 1;
      if (entry.source === 'changelog') summary.changelogEntries += 1;
      else if (entry.source === 'release') summary.releases += 1;
      else summary.pullRequests += 1;
      if (entry.crossRepo) summary.crossRepo += 1;
    }
  }
  return summary;
}

/** Apply the window and derive totals; never mutates the collected report. */
export function renderEcosystemChangelogDocument(
  report: EcosystemChangelog,
  options: RenderEcosystemChangelogOptions,
): EcosystemChangelogDocument {
  const asOf = parseInstant(options.asOf, 'as-of timestamp');
  const since = options.since == null ? null : parseInstant(options.since, '--since timestamp');
  const repositories = report.repositories.map((repo) => ({
    repository: repo.repository,
    directory: repo.directory,
    tier: repo.tier,
    sources: repo.sources,
    changes: repo.changes.filter((entry) => inWindow(entry, since))
      .map(({ body: _body, ...entry }) => entry),
  }));
  return {
    schema: ECOSYSTEM_CHANGELOG_SCHEMA,
    generatedAt: asOf,
    complete: report.complete,
    window: { since },
    totals: totals(repositories),
    recent14d: recent(repositories, asOf),
    repositories,
  };
}

// ---------------------------------------------------------------------------
// Markdown render (llms-style: link lists under a small set of headings)
// ---------------------------------------------------------------------------

function linkText(title: string): string {
  return title.replace(/\s+/g, ' ').trim().replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/[\u2010-\u2015]/g, '-');
}

function safe(value: string): string {
  return value.replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
}

function day(date: string | null): string {
  return date === null ? 'undated' : date.slice(0, 10);
}

function bullet(entry: EcosystemChangelogEntry): string {
  const title = entry.source === 'pull-request' && entry.number !== undefined
    ? `#${entry.number} ${entry.title}`
    : entry.title;
  const meta = [entry.source, day(entry.date)];
  if (entry.prerelease) meta.push('prerelease');
  if (entry.unreleased) meta.push('unreleased');
  if (entry.crossRepo) meta.push(`cross-repo ${entry.relatedPullRequests.join(', ')}`);
  return `- [${linkText(title)}](${entry.url}): ${safe(meta.join('; '))}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function sourceStatus(repo: EcosystemChangelogDocument['repositories'][number]): string {
  return repo.sources
    .map((source) => `${source.source} ${source.status}${source.reason ? ` (${source.reason})` : ''}`)
    .join('; ');
}

function heading(repository: string, tier: StrategicTier): string {
  return `### ${repository} (${tier})`;
}

/**
 * Render the document as llms-style Markdown: a header, a fixed 14-day
 * activity summary, pending (undated) release notes, then per-repository
 * listings in strategic tier order. Pure; contains no em dashes.
 */
export function renderEcosystemChangelogMarkdown(document: EcosystemChangelogDocument): string {
  const out: string[] = [];
  out.push('# Ashlr.AI ecosystem changelog');
  out.push('');
  out.push(
    `> ${plural(document.totals.repositories, 'repository', 'repositories')}, ${plural(document.totals.changes, 'change')} ` +
    `(${plural(document.totals.pullRequests, 'merged pull request')}, ${plural(document.totals.releases, 'published release')}, ` +
    `${plural(document.totals.changelog, 'changelog entry', 'changelog entries')}; ${document.totals.crossRepo} cross-repo). ` +
    `Generated ${document.generatedAt} by \`phm ecosystem changelog\`; deterministic for the same inputs. ` +
    `Machine-readable form: [docs/ecosystem-changelog.json](docs/ecosystem-changelog.json) (\`${document.schema}\`).` +
    (document.window.since ? ` Window: dated changes since ${document.window.since}.` : ''),
  );
  if (!document.complete) {
    const degraded = document.repositories.flatMap((repo) =>
      repo.sources.filter((source) => source.status !== 'complete')
        .map((source) => `${repo.repository} ${source.source} ${source.status}${source.reason ? ` (${source.reason})` : ''}`));
    out.push('');
    out.push(`> Coverage incomplete: ${degraded.join('; ')}.`);
  }
  out.push('');

  out.push(`## Last ${document.recent14d.days} days`);
  out.push('');
  out.push(
    `Activity since ${document.recent14d.since}: ${plural(document.recent14d.changes, 'change')} across ` +
    `${plural(document.recent14d.repositories, 'repository', 'repositories')} (${plural(document.recent14d.pullRequests, 'pull request')}, ` +
    `${plural(document.recent14d.releases, 'release')}, ${plural(document.recent14d.changelogEntries, 'changelog entry', 'changelog entries')}).`,
  );
  out.push('');
  let anyRecent = false;
  for (const repo of document.repositories) {
    const hits = repo.changes.filter((entry) => entry.date !== null && entry.date >= document.recent14d.since);
    if (hits.length === 0) continue;
    anyRecent = true;
    out.push(heading(repo.repository, repo.tier));
    out.push('');
    out.push(...hits.map(bullet));
    out.push('');
  }
  if (!anyRecent) {
    out.push(`_No dated ecosystem changes in the last ${document.recent14d.days} days._`);
    out.push('');
  }

  out.push('## Pending release notes');
  out.push('');
  out.push('Changelog sections without a release date.');
  out.push('');
  let anyPending = false;
  for (const repo of document.repositories) {
    const pending = repo.changes.filter((entry) => entry.date === null);
    if (pending.length === 0) continue;
    anyPending = true;
    out.push(heading(repo.repository, repo.tier));
    out.push('');
    out.push(...pending.map(bullet));
    out.push('');
  }
  if (!anyPending) {
    out.push('_No pending release notes._');
    out.push('');
  }

  out.push('## Repositories');
  out.push('');
  for (const repo of document.repositories) {
    out.push(heading(repo.repository, repo.tier));
    out.push('');
    const degraded = repo.sources.some((source) => source.status !== 'complete');
    if (degraded) {
      out.push(`Source status: ${sourceStatus(repo)}`);
      out.push('');
    }
    if (repo.changes.length === 0) {
      out.push('_No changes in scope._');
    } else {
      out.push(...repo.changes.map(bullet));
    }
    out.push('');
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Stable wire formatting for docs/ecosystem-changelog.json. */
export function renderEcosystemChangelogJson(document: EcosystemChangelogDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
