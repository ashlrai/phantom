import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadConfigAt } from '../config.js';
import { getLocalReleaseStatus, type ReleaseSummary } from '../fleet/release-chain-status.js';
export { getLocalReleaseStatus } from '../fleet/release-chain-status.js';
import { scrubSecrets } from '../util/scrub.js';
import { AUTONOMY_REPOS } from './autonomy-audit.js';
import { readBehindReleases, type InstalledBuild } from './drift.js';

export interface ReleaseStatusRow {
  repo: string;
  defaultBranch: string | null;
  latestTag: string | null;
  ageDays: number | null;
  unreleasedCommits: number | null;
  /** False when there is no local clone to read, so a null tag means unknown, not "no release yet". */
  readable: boolean;
  taggedAt: string | null;
  mergedPrsSinceTag: number | null;
  /** Merged PRs since the tag, newest first, or null when unknown. Not capped here; the cadence report shows the newest 5. */
  mergedPrs: ReleasePrTitle[] | null;
  /** The clone that was read, or null when none was found. */
  path?: string | null;
  /** Every clone path tried, in order. Listed when the repo is not found. */
  tried?: string[];
  /** Plain reason this row is unknown, or null when it was read fine. */
  reason?: string | null;
}
/** One merged PR as plain text: its number and title. */
export interface ReleasePrTitle { number: number; title: string }
export interface ReleaseStatusReport { schema: 'phantom.release-status.v2'; repos: ReleaseStatusRow[]; release: ReleaseSummary }
export interface ReleaseStatusDeps { root?: string; roots?: readonly string[]; repos?: readonly string[]; now?: number; repoPath?: string; runsDir?: string; cadenceMinutes?: number; installed?: () => InstalledBuild }
const DAY_MS = 86_400_000;
export const RELEASE_PR_TITLES_SHOWN = 5;

const plainTitle = (text: string): string => {
  // eslint-disable-next-line no-control-regex
  const clean = scrubSecrets(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 100 ? `${clean.slice(0, 99)}…` : clean;
};

/** Merged PRs from first-parent subjects (merge commits and squash titles ending in a PR number), newest first, once per number. */
export function parseMergedPrs(subjects: string): ReleasePrTitle[] {
  const seen = new Map<number, ReleasePrTitle>();
  for (const line of subjects.split('\n')) {
    const merge = /^Merge pull request #(\d+)\b\s*(.*)$/.exec(line);
    const squash = merge ? null : /^(.*?)\s*\(#(\d+)\)$/.exec(line);
    const number = Number(merge?.[1] ?? squash?.[2]);
    if (!Number.isSafeInteger(number) || seen.has(number)) continue;
    seen.set(number, { number, title: plainTitle(merge ? merge[2]!.replace(/^from\s+/, '') : squash![1]!) || `PR #${number}` });
  }
  return [...seen.values()];
}

/**
 * Folders to look for clones in, first match wins: the repo roots in ~/.ashlr/config.json (read only, never
 * written), then ~/Projects/ashlrai. A test or caller can pass `root` or `roots` instead.
 */
export function releaseRoots(deps: Pick<ReleaseStatusDeps, 'root' | 'roots'> = {}): string[] {
  if (deps.roots) return [...new Set(deps.roots)];
  if (deps.root) return [deps.root];
  let configured: string[] = [];
  try { configured = loadConfigAt(join(homedir(), '.ashlr')).roots.filter((root): root is string => typeof root === 'string' && isAbsolute(root)); } catch { /* no readable config: default only */ }
  return [...new Set([...configured, join(homedir(), 'Projects', 'ashlrai')])];
}

/** Reads local clones only. Local refs can be stale; missing or incomplete evidence is reported as null. */
export function readReleaseRows(deps: ReleaseStatusDeps = {}): ReleaseStatusRow[] {
  const roots = releaseRoots(deps);
  return (deps.repos ?? AUTONOMY_REPOS).map((name): ReleaseStatusRow => {
    const tried = roots.map(root => join(root, name));
    const path = tried.find(candidate => existsSync(join(candidate, '.git'))) ?? tried[0] ?? name;
    const git = (...args: string[]): string | null => {
      try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
      catch { return null; }
    };
    const empty: ReleaseStatusRow = { repo: `ashlrai/${name}`, defaultBranch: null, latestTag: null, ageDays: null, unreleasedCommits: null, readable: false, taggedAt: null, mergedPrsSinceTag: null, mergedPrs: null, path: null, tried, reason: null };
    if (!existsSync(join(path, '.git'))) return { ...empty, reason: `not found (tried ${tried.join(', ') || 'no folders'})` };
    const remoteHead = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD') || null;
    const defaultBranch = remoteHead?.startsWith('origin/') ? remoteHead.slice(7) : null;
    // The newest tag reachable from the default branch (a tag on a side branch is not "the latest release");
    // without a default-branch ref, fall back to the newest tag by date.
    const reachable = remoteHead ? git('describe', '--tags', '--abbrev=0', `refs/remotes/${remoteHead}`) : null;
    const tag = git('for-each-ref', ...(reachable ? [`refs/tags/${reachable}`] : ['--sort=-creatordate', '--count=1', 'refs/tags']), '--format=%(refname:strip=2)%09%(creatordate:unix)');
    const [latestTag, seconds] = tag?.split('\t') ?? [];
    const timestamp = seconds && /^\d+$/.test(seconds) ? Number(seconds) * 1000 : NaN;
    const ageDays = Number.isFinite(timestamp) ? Math.max(0, Math.floor(((deps.now ?? Date.now()) - timestamp) / DAY_MS)) : null;
    const shallow = git('rev-parse', '--is-shallow-repository') !== 'false';
    const range = latestTag && remoteHead ? `refs/tags/${latestTag}..refs/remotes/${remoteHead}` : null;
    const count = range && !shallow ? git('rev-list', '--count', range) : null;
    // Same subject rule as the release chain: merge commits and squash titles that end in a PR number.
    let log = range ? git('log', '--first-parent', '--format=%H%x09%s', range) : null;
    if (log !== null && shallow) {
      // A shallow clone still counts exactly when the mainline since the tag never reaches a cut-off commit.
      const cut = git('rev-parse', '--git-path', 'shallow');
      let cuts: string[] | null = null;
      try { cuts = cut ? readFileSync(isAbsolute(cut) ? cut : join(path, cut), 'utf8').split('\n').filter(Boolean) : null; } catch { /* unknown below */ }
      if (!cuts || cuts.some(sha => log!.includes(sha))) log = null;
    }
    const mergedPrs = log === null ? null : parseMergedPrs(log.replace(/^[0-9a-f]+\t/gm, ''));
    const reason = tag === null ? 'could not read tags' : !latestTag ? 'no tags in this clone' : !remoteHead ? 'no default-branch ref (origin/HEAD is not set; fetch or set it)'
      : latestTag && mergedPrs === null ? 'clone is shallow or incomplete, so PRs since the tag cannot be counted' : null;
    return { ...empty, path, reason, readable: tag !== null && !(shallow && !latestTag), defaultBranch, latestTag: latestTag || null, ageDays,
      unreleasedCommits: count !== null && /^\d+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null,
      taggedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      mergedPrsSinceTag: mergedPrs === null ? null : mergedPrs.length, mergedPrs };
  });
}

/**
 * One plain line per repo from the rows: "phantom: v0.42.1, 3 days ago, 212 commits since". A missing clone reads
 * "not checked out here", a clone without tags "never released", and anything unreadable "unknown", never 0.
 */
export function releaseTagLines(rows: readonly ReleaseStatusRow[]): string[] {
  return rows.map(row => {
    const name = row.repo.replace(/^ashlrai\//, '');
    if (!row.path) return `${name}: not checked out here`;
    if (!row.readable) return `${name}: unknown${row.reason ? ` (${row.reason})` : ''}`;
    if (!row.latestTag) return row.reason === 'no tags in this clone' ? `${name}: never released` : `${name}: unknown${row.reason ? ` (${row.reason})` : ''}`;
    const age = row.ageDays === null ? 'unknown age' : row.ageDays === 0 ? 'today' : `${count(row.ageDays, 'day')} ago`;
    return `${name}: ${row.latestTag}, ${age}, ${row.unreleasedCommits === null ? 'unknown' : count(row.unreleasedCommits, 'commit')} since`;
  });
}

export async function getReleaseStatus(deps: ReleaseStatusDeps = {}): Promise<ReleaseStatusReport> {
  return { schema: 'phantom.release-status.v2', repos: readReleaseRows(deps), release: await getLocalReleaseStatus(deps) };
}

export const RELEASES_SCHEMA = 'phantom.releases.v1';
export const RELEASE_DUE = { days: 7, mergedPrs: 50 } as const;
export type ReleaseVerdict = 'fresh' | 'due' | 'no release yet' | 'unknown';
/** One repo's release facts, gathered by the caller. `readable: false` means the facts could not be read at all. */
export interface ReleaseCadenceInput {
  repo: string; latestTag: string | null; taggedAt: string | null; mergedPrsSinceTag: number | null; readable?: boolean;
  /** Plain reason the facts are missing, shown after "unknown". */
  reason?: string | null;
  /** Merged PRs since the tag, newest first; absent or null reads as unknown. */
  mergedPrs?: readonly ReleasePrTitle[] | null;
  /** Releases the installed build trails (Phantom only, from `phm self drift`); unknown or absent adds nothing. */
  behindReleases?: number | 'unknown' | null;
}
export interface ReleaseCadenceRow {
  repo: string; latestTag: string | null; taggedAt: string | null; ageDays: number | null; mergedPrsSince: number | null; verdict: ReleaseVerdict; suggestion: string;
  /** Why the verdict is unknown (not found, no default-branch ref, shallow clone), or null. */
  reason: string | null;
  /** The newest merged PRs since the tag (at most 5), or null when unknown. Compare with `mergedPrsSince` for the total. */
  recentPrs: ReleasePrTitle[] | null;
  /** Present only when the installed build is known to trail this repo's releases. */
  behindReleases?: number;
}
export interface ReleasesReport {
  schema: typeof RELEASES_SCHEMA; version: 1; checkedAt: string; dueWhen: typeof RELEASE_DUE;
  counts: Record<ReleaseVerdict, number>; repos: ReleaseCadenceRow[];
  /** The single most overdue repo, or null when nothing is due. This report never tags or publishes. */
  next: (ReleaseCadenceRow & { action: string }) | null;
}

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
// Each release the installed build trails adds one full "due" unit, so an overdue Phantom the fleet is not
// even running yet ranks above repos that are merely due by age or PR count.
const overdue = (row: ReleaseCadenceRow): number =>
  Math.max((row.ageDays ?? 0) / RELEASE_DUE.days, (row.mergedPrsSince ?? 0) / RELEASE_DUE.mergedPrs) + (row.behindReleases ?? 0);

/**
 * Pure release cadence verdicts. A repo is due when its latest tag is over 7 days old or over 50 PRs
 * merged since it. An old tag with nothing merged since is fresh: there is nothing to release.
 */
export function releaseCadence(inputs: readonly ReleaseCadenceInput[], now: number): ReleasesReport {
  const repos = inputs.map((input): ReleaseCadenceRow => {
    const name = input.repo.replace(/^ashlrai\//, '');
    const merged = typeof input.mergedPrsSinceTag === 'number' && Number.isSafeInteger(input.mergedPrsSinceTag) && input.mergedPrsSinceTag >= 0 ? input.mergedPrsSinceTag : null;
    const at = input.taggedAt === null ? NaN : Date.parse(input.taggedAt);
    const ageDays = input.latestTag !== null && Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / DAY_MS)) : null;
    const behind = typeof input.behindReleases === 'number' && Number.isSafeInteger(input.behindReleases) && input.behindReleases > 0 ? input.behindReleases : null;
    const recentPrs = input.latestTag !== null && Array.isArray(input.mergedPrs) ? input.mergedPrs.slice(0, RELEASE_PR_TITLES_SHOWN).map(({ number, title }) => ({ number, title })) : null;
    const reason = input.reason ?? null;
    const row = { repo: input.repo, reason, latestTag: input.latestTag, taggedAt: ageDays === null ? null : input.taggedAt, ageDays, mergedPrsSince: merged, recentPrs, ...(behind ? { behindReleases: behind } : {}) };
    const lag = behind ? `; installed build ${count(behind, 'release')} behind` : '';
    if (input.readable === false) return { ...row, verdict: 'unknown', suggestion: `${name}: ${reason ?? 'release state unknown (local clone missing or incomplete)'}` };
    if (input.latestTag === null) return { ...row, verdict: 'no release yet', suggestion: `${name}: no release yet${reason ? ` (${reason})` : ''}${merged === null ? '' : `; ${count(merged, 'PR')} merged`}` };
    const facts = `${merged === null ? 'unknown PRs' : count(merged, 'PR')} since ${input.latestTag}${ageDays === null ? ', tag age unknown' : ` ${count(ageDays, 'day')} ago`}`;
    const byCount = merged !== null && merged > RELEASE_DUE.mergedPrs;
    const byAge = ageDays !== null && ageDays > RELEASE_DUE.days && merged !== 0;
    const verdict: ReleaseVerdict = byCount || byAge ? 'due' : merged === 0 || (merged !== null && ageDays !== null) ? 'fresh' : 'unknown';
    return { ...row, verdict, suggestion: `${name}: ${facts}; ${verdict === 'due' ? 'release due' : verdict === 'fresh' ? merged === 0 ? 'nothing to release' : 'fresh' : `cannot tell if a release is due${reason ? ` (${reason})` : ''}`}${lag}` };
  });
  const counts: Record<ReleaseVerdict, number> = { fresh: 0, due: 0, 'no release yet': 0, unknown: 0 };
  for (const row of repos) counts[row.verdict] += 1;
  const worst = repos.filter(row => row.verdict === 'due').sort((a, b) => overdue(b) - overdue(a) || a.repo.localeCompare(b.repo))[0];
  return { schema: RELEASES_SCHEMA, version: 1, checkedAt: new Date(now).toISOString(), dueWhen: RELEASE_DUE, counts, repos,
    next: worst ? { ...worst, action: `Open a release PR for ${worst.repo} through its own release workflow. phm releases only reports; it never tags or publishes.` } : null };
}

/** Release cadence for the Ashlr repos from local clones: no network, no writes. */
export function getReleases(deps: ReleaseStatusDeps = {}): ReleasesReport {
  const rows = readReleaseRows(deps);
  const phantom = rows.find(row => row.repo === 'ashlrai/phantom' && row.readable);
  // Only a readable Phantom clone is asked: the boost reads its tags and the installed manifest, never the network.
  const behindReleases = phantom?.path ? readBehindReleases({ repo: phantom.path, installed: deps.installed }) : null;
  return releaseCadence(rows.map(row => row === phantom ? { ...row, behindReleases } : row), deps.now ?? Date.now());
}

/**
 * The one line on the Leader card (desktop and phone): the most overdue repo, or "all fresh".
 * "Release due: locus (23 PRs since v1.4.0, 9 days)" | "Releases: all fresh" | "Releases: none due (1 unknown)" | "Releases: unknown".
 */
export function releasesLeaderLine(report: ReleasesReport | null | undefined): string {
  if (!report || !Array.isArray(report.repos) || !report.repos.length || report.counts.unknown === report.repos.length) return 'Releases: unknown';
  const next = report.next;
  if (next) return `Release due: ${next.repo.replace(/^ashlrai\//, '')} (${next.mergedPrsSince === null ? 'unknown PRs' : count(next.mergedPrsSince, 'PR')} since ${next.latestTag ?? 'unknown'}, ${next.ageDays === null ? 'unknown days' : count(next.ageDays, 'day')})`;
  if (report.counts.fresh === report.repos.length) return 'Releases: all fresh';
  const other = report.counts.unknown + report.counts['no release yet'];
  return `Releases: none due${other ? ` (${report.counts.unknown ? `${report.counts.unknown} unknown` : ''}${report.counts.unknown && report.counts['no release yet'] ? ', ' : ''}${report.counts['no release yet'] ? `${report.counts['no release yet']} with no release yet` : ''})` : ''}`;
}

/**
 * The one digest line: "Release due: <repo>, <N> PRs since <tag>, <D> days" for the most overdue repo,
 * "Release due: none" when nothing is due, and "Release due: unknown" when nothing could be read.
 */
export function releaseDueLine(report: ReleasesReport | null | undefined): string {
  if (!report || !report.repos.length) return 'Release due: unknown';
  const next = report.next;
  if (next) return `Release due: ${next.repo.replace(/^ashlrai\//, '')}, ${next.mergedPrsSince === null ? 'unknown PRs' : count(next.mergedPrsSince, 'PR')} since ${next.latestTag ?? 'unknown'}, ${next.ageDays === null ? 'unknown days' : count(next.ageDays, 'day')}`;
  if (report.counts.unknown === report.repos.length) return 'Release due: unknown';
  return `Release due: none${report.counts.unknown ? ` (${report.counts.unknown} unknown)` : ''}`;
}

export function formatReleases(report: ReleasesReport): string {
  if (!report.repos.length) return 'Releases: no repos to check.\n';
  const lines = report.repos.flatMap(row => [`  ${row.suggestion}`, ...(row.recentPrs ?? []).map(pr => `    #${pr.number} ${pr.title}`),
    ...(row.recentPrs && row.mergedPrsSince !== null && row.mergedPrsSince > row.recentPrs.length ? [`    and ${row.mergedPrsSince - row.recentPrs.length} more`] : [])]);
  return `Releases: ${report.counts.due} due, ${report.counts.fresh} fresh, ${report.counts['no release yet']} with no release yet, ${report.counts.unknown} unknown\n${lines.join('\n')}\n${report.next ? `Next: ${report.next.repo}. ${report.next.action}` : 'Next: nothing is due.'}\nRead from local clones; fetch them first for current numbers.\n`;
}

export function formatReleaseStatus(report: ReleaseStatusReport): string {
  const r = report.release;
  return `Published: ${r.latestPublishedTag ?? 'unknown'} at ${r.publishedAt ?? 'unknown'}\nSigned assets: ${r.signedAssets === null ? 'unknown' : r.signedAssets ? 'complete' : 'missing'}; updater HTTP: ${r.updaterHttp ?? 'unknown'} (recorded ${r.recordedAt ?? 'unknown'})\nMerged PRs since tag: ${r.mergedPrsSinceTag ?? 'unknown'}\nNext: ${r.nextCandidate.version ?? 'unknown'}; earliest ${r.nextCandidate.eta ?? 'unknown'}\nAutorun rc: ${r.autorun.rc ?? 'unknown'}; ${r.autorun.reason ?? 'Reason: unknown (log unavailable or no Reason line)'}`;
}
