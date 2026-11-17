/**
 * Release evidence for the enrolled repos, read from local Git checkouts. This is
 * the one source behind `phm releases` (phantom.releases.v1), `phm release status`
 * (phantom.release-status.v2) and the desktop Home Releases card. Read-only: it
 * never fetches, tags, releases or opens a PR. Local refs can be stale; anything
 * that cannot be read is unknown with a reason, never guessed.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { unreleasedSection } from '../fleet/changelog-fold.js';
import { AUTONOMY_REPOS } from './autonomy-audit.js';
import { parseNotesLog } from './notes.js';
import { RELEASES_SCHEMA, releaseRowLine, summarizeReleases, type ChangelogState, type Field, type ReleaseNext, type ReleaseRowV1, type ReleasesV1 } from './releases-shape.js';

export * from './releases-shape.js';

/** Raw facts for one repo, as a reader saw them. Tests inject fixtures; the default reads local Git. */
export interface RepoReleaseFacts {
  defaultBranch: Field<string>;
  /** null: the default branch has no tags yet. createdAt is an ISO time. */
  latestTag: Field<{ name: string; createdAt: string } | null>;
  /** First-parent commit subjects on the default branch since the tag (all history when there is no tag). */
  subjectsSinceTag: Field<string[]>;
  /** CHANGELOG.md on the default branch; null when the file does not exist. */
  changelog: Field<string | null>;
  /** Whether CHANGELOG.md changed on the default branch since the tag; null when there is no tag. */
  changelogChangedSinceTag: Field<boolean | null>;
}
export type ReleaseReader = (repo: string) => Promise<RepoReleaseFacts>;
export interface ReadReleasesOptions { root?: string; repos?: readonly string[]; now?: number; read?: ReleaseReader }

const DAY_MS = 86_400_000;
const run = promisify(execFile);
const TAG = /^[\w][\w./+-]*$/;
const ok = <T>(value: T): Field<T> => ({ state: 'ok', value });
const unknown = (reason: string): { state: 'unknown'; reason: string } => ({ state: 'unknown', reason });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const defaultReleasesRoot = (): string => join(homedir(), 'Projects', 'ashlrai');

/** The default reader: local Git refs under `root/<repo>`, against `refs/remotes/origin/HEAD`. */
export function gitReleaseReader(root: string): ReleaseReader {
  return async repo => {
    const path = join(root, repo);
    // Async so the desktop API stays responsive; `code` is Git's exit status, -1 when it did not run.
    const git = async (...args: string[]): Promise<{ code: number; out: string }> => {
      try { return { code: 0, out: (await run('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 })).stdout }; }
      catch (error) { const code = (error as { code?: unknown }).code; return { code: typeof code === 'number' ? code : -1, out: '' }; }
    };
    const missing = (reason: string): RepoReleaseFacts => ({ defaultBranch: unknown(reason), latestTag: unknown(reason), subjectsSinceTag: unknown(reason), changelog: unknown(reason), changelogChangedSinceTag: unknown(reason) });
    if (!existsSync(join(path, '.git'))) return missing(`No local checkout of ${repo} was found.`);
    const remoteHead = (await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).out.trim();
    if (!remoteHead.startsWith('origin/')) return missing('origin/HEAD is not set, so the default branch is unknown.');
    const head = `refs/remotes/${remoteHead}`;
    const tagRead = await git('for-each-ref', `--merged=${head}`, '--sort=-creatordate', '--count=1', '--format=%(refname:strip=2)%09%(creatordate:iso-strict)', 'refs/tags');
    const [name, created] = tagRead.out.trim().split('\t');
    const latestTag: RepoReleaseFacts['latestTag'] = tagRead.code !== 0 ? unknown('The tags could not be read.')
      : !name ? ok(null)
      : !TAG.test(name) || !Number.isFinite(Date.parse(created ?? '')) ? unknown('The latest tag has an unreadable name or date.')
      : ok({ name, createdAt: new Date(created!).toISOString() });
    const shallow = (await git('rev-parse', '--is-shallow-repository')).out.trim();
    const tagRef = latestTag.state === 'ok' && latestTag.value ? `refs/tags/${latestTag.value.name}` : null;
    const readSubjects = async (): Promise<RepoReleaseFacts['subjectsSinceTag']> => {
      if (latestTag.state === 'unknown') return latestTag;
      if (shallow !== 'false') return unknown('The checkout is shallow, so commits since the tag cannot be counted.');
      const log = await git('log', '--first-parent', '--format=%x1e%H%x00%an%x00%s%x00%b%x00', tagRef ? `${tagRef}..${head}` : head, '--');
      try { if (log.code === 0) return ok(parseNotesLog(log.out).map(commit => commit.subject)); } catch { /* malformed log */ }
      return unknown('The default branch history could not be read.');
    };
    const subjectsSinceTag = await readSubjects();
    // cat-file -e exits non-zero when the path is absent at that ref; the ref itself resolved above.
    const exists = (await git('cat-file', '-e', `${head}:CHANGELOG.md`)).code === 0;
    const text = exists ? await git('show', `${head}:CHANGELOG.md`) : null;
    const changelog: RepoReleaseFacts['changelog'] = !text ? ok(null) : text.code === 0 ? ok(text.out) : unknown('CHANGELOG.md could not be read.');
    const diff = tagRef ? (await git('diff', '--quiet', tagRef, head, '--', 'CHANGELOG.md')).code : null;
    const changelogChangedSinceTag: RepoReleaseFacts['changelogChangedSinceTag'] = latestTag.state === 'unknown' ? latestTag
      : diff === null ? ok(null) : diff === 0 ? ok(false) : diff === 1 ? ok(true) : unknown('CHANGELOG.md could not be compared with the tag.');
    return { defaultBranch: ok(remoteHead.slice('origin/'.length)), latestTag, subjectsSinceTag, changelog, changelogChangedSinceTag };
  };
}

function changelogState(facts: RepoReleaseFacts): Field<ChangelogState> {
  if (facts.changelog.state === 'unknown') return facts.changelog;
  if (facts.changelog.value === null) return ok('no-file');
  const section = unreleasedSection(facts.changelog.value);
  if (section === null) return ok('no-unreleased-section');
  if (!section.split('\n').some(line => /^\s*[-*] \S/.test(line))) return ok('unreleased-empty');
  if (facts.changelogChangedSinceTag.state === 'unknown') return facts.changelogChangedSinceTag;
  return ok(facts.changelogChangedSinceTag.value === false ? 'not-updated-since-tag' : 'covers');
}

const CHANGELOG_WHY: Record<Exclude<ChangelogState, 'covers'>, string> = {
  'no-file': 'there is no CHANGELOG.md',
  'no-unreleased-section': 'CHANGELOG.md has no Unreleased section at the top',
  'unreleased-empty': 'the Unreleased section has no entries',
  'not-updated-since-tag': 'CHANGELOG.md has not changed since the tag',
};

/** Pure: one row from one repo's facts at `now`. */
export function buildReleaseRow(repo: string, facts: RepoReleaseFacts, now: number): ReleaseRowV1 {
  const latestTag: ReleaseRowV1['latestTag'] = facts.latestTag.state === 'unknown' ? facts.latestTag
    : ok(facts.latestTag.value && { name: facts.latestTag.value.name, ageDays: Math.max(0, Math.floor((now - Date.parse(facts.latestTag.value.createdAt)) / DAY_MS)) });
  const subjects = facts.subjectsSinceTag;
  const commitsSinceTag: Field<number> = subjects.state === 'ok' ? ok(subjects.value.length) : subjects;
  const prs = (subject: string) => subject.match(/\(#(\d+)\)\s*$/)?.[1] ?? subject.match(/^Merge pull request #(\d+)\b/)?.[1];
  const mergedPrsSinceTag: Field<number> = subjects.state === 'ok' ? ok(new Set(subjects.value.flatMap(subject => prs(subject) ?? [])).size) : subjects;
  const changelog = changelogState(facts);
  const since = latestTag.state === 'ok' && latestTag.value ? `since ${latestTag.value.name}` : 'and no tags yet';
  let next: ReleaseNext, why: string;
  if (commitsSinceTag.state === 'unknown') { next = 'unknown'; why = commitsSinceTag.reason; }
  else if (commitsSinceTag.value === 0) { next = 'nothing to release'; why = latestTag.state === 'ok' && latestTag.value ? `No commits since ${latestTag.value.name}.` : 'The default branch has no commits.'; }
  else {
    const work = `${plural(commitsSinceTag.value, 'commit')} (${plural(mergedPrsSinceTag.state === 'ok' ? mergedPrsSinceTag.value : 0, 'PR')}) ${since}`;
    if (changelog.state === 'unknown') { next = 'unknown'; why = `${work}; the changelog is unknown: ${changelog.reason}`; }
    else if (changelog.value === 'covers') { next = 'ready: open release PR'; why = `${work}; the Unreleased section covers them.`; }
    else { next = 'write changelog'; why = `${work}, but ${CHANGELOG_WHY[changelog.value]}.`; }
  }
  return { repo, defaultBranch: facts.defaultBranch, latestTag, commitsSinceTag, mergedPrsSinceTag, changelog, next, why };
}

/** Read every enrolled repo once (in a fixed order) and build the report. A reader that throws leaves its row unknown. */
export async function readReleases(opts: ReadReleasesOptions = {}): Promise<ReleasesV1> {
  const now = opts.now ?? Date.now(), read = opts.read ?? gitReleaseReader(opts.root ?? defaultReleasesRoot());
  const repos = await Promise.all((opts.repos ?? AUTONOMY_REPOS).map(async repo => {
    const facts = await read(repo).catch((): RepoReleaseFacts => {
      const reason = `The release reader failed for ${repo}.`;
      return { defaultBranch: unknown(reason), latestTag: unknown(reason), subjectsSinceTag: unknown(reason), changelog: unknown(reason), changelogChangedSinceTag: unknown(reason) };
    });
    return buildReleaseRow(repo, facts, now);
  }));
  return { schema: RELEASES_SCHEMA, asOf: new Date(now).toISOString(), repos, summary: summarizeReleases(repos) };
}

/** Plain lines for a terminal: the headline, then one line per repo. */
export function releasesText(report: ReleasesV1): string[] {
  return [report.summary.headline, ...report.repos.map(row => `  ${releaseRowLine(row)}`)];
}

// phantom.release-status.v2: the older `phm release status` view over the same reader.
export interface ReleaseStatusRow {
  repo: string;
  defaultBranch: string | null;
  latestTag: string | null;
  ageDays: number | null;
  unreleasedCommits: number | null;
}
export interface ReleaseStatusReport { schema: 'phantom.release-status.v2'; repos: ReleaseStatusRow[] }
export interface ReleaseStatusDeps { root?: string; repos?: readonly string[]; now?: number; read?: ReleaseReader }

export async function getReleaseStatus(deps: ReleaseStatusDeps = {}): Promise<ReleaseStatusReport> {
  const report = await readReleases(deps);
  const value = <T>(field: Field<T>): T | null => field.state === 'ok' ? field.value : null;
  return {
    schema: 'phantom.release-status.v2',
    repos: report.repos.map(row => {
      const tag = value(row.latestTag);
      return { repo: `ashlrai/${row.repo}`, defaultBranch: value(row.defaultBranch), latestTag: tag?.name ?? null, ageDays: tag?.ageDays ?? null, unreleasedCommits: tag ? value(row.commitsSinceTag) : null };
    }),
  };
}

export function formatReleaseStatus(report: ReleaseStatusReport): string {
  return report.repos.map((r) => `${r.repo}: latest tag ${r.latestTag ?? 'unknown'}, age ${r.ageDays === null ? 'unknown' : `${r.ageDays} days`}, commits since tag ${r.unreleasedCommits ?? 'unknown'}.`).join('\n');
}
