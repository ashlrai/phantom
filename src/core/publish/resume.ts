/**
 * `phm publish resume` and `phm publish orphans`: finish a publish that pushed
 * its fork branch and then stopped before a PR existed (for example the shallow
 * fetch race that ended jobs with "RESULT ABORT default-fetch").
 *
 * Everything goes through the autopilot `Gh` wrapper, so tests inject a fake
 * and there is no new credential, scope or bypass path. The only writes are
 * "open a PR" and "turn on auto-merge through the merge queue" (`gh pr merge
 * --auto --squash --match-head-commit`, never `--admin`); callers that cannot
 * prove a branch is safe to arm pass `armAutoMerge: false` and the merge
 * queue's own gated path decides instead. Branches must live
 * under `codex-bridge/` on the signed-in user's own fork.
 *
 * Reads retry transient GitHub failures a bounded number of times (see
 * `retry.ts`). If GitHub stays down the result is `deferred`: the pushed branch
 * is untouched, the reason is plain, and the same command is safe to run again.
 */
import { assertRepo, createPr, defaultGh, queuePrMerge, readViewer, type Gh } from '../autopilot/github.js';
import { scrubSecrets } from '../util/scrub.js';
import { FetchDeferredError, retryReads, type RetryOptions } from './retry.js';

export const PUBLISH_RESUME_SCHEMA = 'publish.resume.v1';
export const PUBLISH_ORPHANS_SCHEMA = 'publish.orphans.v1';
export const PUBLISH_BRANCH_PREFIX = 'codex-bridge/';
export const PUBLISH_UPSTREAM_OWNER = 'ashlrai';
/** Same allowlist as the pinned publisher. */
export const PUBLISH_REPOS = ['phantom', 'phantom-secrets', 'ashlr-plugin', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack'] as const;
export const ORPHAN_WINDOW_MS = 48 * 3_600_000;
const BRANCH = /^codex-bridge\/[A-Za-z0-9._-]{1,80}$/;

export type PublishResumeStatus = 'opened' | 'already-open' | 'already-merged' | 'already-on-main' | 'missing' | 'deferred';

export interface PublishResumeResult {
  schema: typeof PUBLISH_RESUME_SCHEMA;
  status: PublishResumeStatus;
  pr_url: string | null;
  branch: string;
  repo: string;
  /** Only for `opened`: whether auto-merge is now on, and one plain sentence why not. */
  auto_merge?: { on: boolean; detail: string };
  /** Only for `deferred`: why, how many tries were made, and the command to run later. The branch is kept. */
  deferred?: { reason: string; attempts: number; retry: string };
}

export interface PublishOrphan { branch: string; sha: string; pushed_at: string; age_hours: number }
export interface PublishOrphansResult {
  schema: typeof PUBLISH_ORPHANS_SCHEMA;
  repo: string;
  window_hours: 48;
  orphans: PublishOrphan[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const get = async (gh: Gh, path: string): Promise<unknown> =>
  JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', path]));

/** `phantom` or `ashlrai/phantom` → `phantom`; anything outside the allowlist throws. */
export function resolveRepoName(input = 'phantom'): string {
  const name = input.startsWith(`${PUBLISH_UPSTREAM_OWNER}/`) ? input.slice(PUBLISH_UPSTREAM_OWNER.length + 1) : input;
  if (!(PUBLISH_REPOS as readonly string[]).includes(name)) {
    throw new Error(`Repo "${input}" is not one of: ${PUBLISH_REPOS.join(', ')}.`);
  }
  return name;
}

/** A bare job id means `codex-bridge/<job>`; other prefixes are refused. */
export function resolveBranch(input: string): string {
  const branch = input.includes('/') ? input : `${PUBLISH_BRANCH_PREFIX}${input}`;
  if (!BRANCH.test(branch) || branch.includes('..')) throw new Error(`Branch must look like ${PUBLISH_BRANCH_PREFIX}<job>.`);
  return branch;
}

interface PrHit { number: number; url: string; state: 'open' | 'closed'; merged: boolean }

/** Every PR (any state) opened from `fork-owner:branch` into the upstream repo. */
async function prsForHead(gh: Gh, upstream: string, forkOwner: string, branch: string): Promise<PrHit[]> {
  const raw = await get(gh, `repos/${upstream}/pulls?state=all&head=${encodeURIComponent(`${forkOwner}:${branch}`)}&per_page=20`);
  if (!Array.isArray(raw)) throw new Error('GitHub returned an unexpected PR list.');
  return raw.map(obj)
    .filter((p) => str(obj(p['head'])['ref']) === branch)
    .map((p) => ({ number: Number(p['number']), url: str(p['html_url']), state: p['state'] === 'open' ? 'open' as const : 'closed' as const, merged: p['merged_at'] != null }))
    .filter((p) => Number.isSafeInteger(p.number) && p.number > 0);
}

async function forkRef(gh: Gh, fork: string, branch: string): Promise<string | null> {
  const raw = await get(gh, `repos/${fork}/git/matching-refs/heads/${branch}`);
  if (!Array.isArray(raw)) throw new Error('GitHub returned an unexpected branch list.');
  const hit = raw.map(obj).find((r) => str(r['ref']) === `refs/heads/${branch}`);
  const sha = str(obj(hit?.['object'])['sha']);
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Same title shape as the publisher: `bridge(<job>): <subject>`. */
export function prTitle(branch: string, commitSubjects: string[]): string {
  const job = branch.slice(PUBLISH_BRANCH_PREFIX.length);
  const subject = (commitSubjects[commitSubjects.length - 1] ?? '').trim();
  if (subject.startsWith('bridge(')) return scrubSecrets(subject).slice(0, 200);
  return scrubSecrets(`bridge(${job}): ${subject || job}`).slice(0, 200);
}

/** Open the PR for a pushed fork branch; a persistent GitHub outage returns `deferred` and keeps the branch.
 * `armAutoMerge: false` opens the PR without queueing auto-merge, leaving arming to the merge queue's gated path. */
export async function resumePublish(
  opts: { branch: string; repo?: string; retry?: RetryOptions; armAutoMerge?: boolean },
  rawGh: Gh = defaultGh,
): Promise<PublishResumeResult> {
  const gh = retryReads(rawGh, opts.retry);
  const name = resolveRepoName(opts.repo);
  const branch = resolveBranch(opts.branch);
  const upstream = assertRepo(`${PUBLISH_UPSTREAM_OWNER}/${name}`);
  const base = (result: PublishResumeStatus, pr_url: string | null): PublishResumeResult =>
    ({ schema: PUBLISH_RESUME_SCHEMA, status: result, pr_url, branch, repo: upstream });
  try {
    const owner = await readViewer(gh);
    return await resumeChecked(gh, { owner, fork: assertRepo(`${owner}/${name}`), upstream, branch, armAutoMerge: opts.armAutoMerge !== false, base });
  } catch (error) {
    if (!(error instanceof FetchDeferredError)) throw error;
    const result = base('deferred', null);
    result.deferred = { reason: scrubSecrets(error.reason), attempts: error.attempts, retry: `phm publish resume --branch ${branch}` };
    return result;
  }
}

async function resumeChecked(
  gh: Gh,
  c: { owner: string; fork: string; upstream: string; branch: string; armAutoMerge: boolean; base: (s: PublishResumeStatus, url: string | null) => PublishResumeResult },
): Promise<PublishResumeResult> {
  const { owner, fork, upstream, branch, armAutoMerge, base } = c;

  // 1. The branch must still be on the fork, and must not already have a live PR.
  const headSha = await forkRef(gh, fork, branch);
  if (!headSha) return base('missing', null);
  const prs = await prsForHead(gh, upstream, owner, branch);
  const open = prs.find((p) => p.state === 'open');
  if (open) return base('already-open', open.url);
  const merged = prs.find((p) => p.merged);
  if (merged) return base('already-merged', merged.url);

  // 2. Is anything on the branch still missing from the default branch?
  const defaultBranch = str(obj(await get(gh, `repos/${upstream}`))['default_branch']) || 'master';
  const compare = obj(await get(gh, `repos/${upstream}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(`${owner}:${branch}`)}`));
  const files = Array.isArray(compare['files']) ? compare['files'] : null;
  if (Number(compare['ahead_by']) === 0 || (files !== null && files.length === 0)) return base('already-on-main', null);

  // 3. Open the PR the way the publisher does, then queue it for auto-merge.
  const commits = (Array.isArray(compare['commits']) ? compare['commits'] : []).map((c) => str(obj(obj(c)['commit'])['message']));
  const subjects = commits.map((m) => m.split('\n')[0] ?? '');
  const tipBody = (commits[commits.length - 1] ?? '').split('\n').slice(1).join('\n').trim();
  const body = scrubSecrets([
    tipBody || subjects.map((s) => `- ${s}`).join('\n'),
    `\nResumed publish of \`${branch}\` from the fork after the first publish stopped before opening a PR.`,
  ].join('\n').trim()).slice(0, 60_000);
  const number = await createPr(upstream, { title: prTitle(branch, subjects), head: `${owner}:${branch}`, base: defaultBranch, body }, gh);
  const result = base('opened', `https://github.com/${upstream}/pull/${number}`);
  if (!armAutoMerge) {
    result.auto_merge = { on: false, detail: 'Auto-merge not armed; the merge queue evaluates the PR.' };
    return result;
  }
  try {
    await queuePrMerge(upstream, number, headSha, gh);
    result.auto_merge = { on: true, detail: 'Queued for auto-merge; required checks still decide.' };
  } catch (error) {
    // The PR exists; say so plainly rather than failing the whole resume.
    result.auto_merge = { on: false, detail: scrubSecrets(error instanceof Error ? error.message : 'Auto-merge could not be turned on.').slice(0, 200) };
  }
  return result;
}

/** Fork `codex-bridge/*` branches pushed in the last 48 h that have no PR in any state. */
export async function listPublishOrphans(
  opts: { repo?: string; now?: () => Date; retry?: RetryOptions } = {},
  rawGh: Gh = defaultGh,
): Promise<PublishOrphansResult> {
  const gh = retryReads(rawGh, opts.retry);
  const name = resolveRepoName(opts.repo);
  const upstream = assertRepo(`${PUBLISH_UPSTREAM_OWNER}/${name}`);
  const owner = await readViewer(gh);
  const fork = assertRepo(`${owner}/${name}`);
  const now = (opts.now ?? (() => new Date()))().getTime();
  const refs = await get(gh, `repos/${fork}/git/matching-refs/heads/${PUBLISH_BRANCH_PREFIX}`);
  if (!Array.isArray(refs)) throw new Error('GitHub returned an unexpected branch list.');
  const orphans: PublishOrphan[] = [];
  for (const ref of refs.map(obj)) {
    const branch = str(ref['ref']).replace(/^refs\/heads\//, '');
    const sha = str(obj(ref['object'])['sha']);
    if (!BRANCH.test(branch) || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const commit = obj(await get(gh, `repos/${fork}/commits/${sha}`));
    const pushedAt = str(obj(obj(commit['commit'])['committer'])['date']);
    const age = now - Date.parse(pushedAt);
    if (!Number.isFinite(age) || age < 0 || age > ORPHAN_WINDOW_MS) continue;
    if ((await prsForHead(gh, upstream, owner, branch)).length > 0) continue;
    orphans.push({ branch, sha, pushed_at: pushedAt, age_hours: Math.round(age / 360_000) / 10 });
  }
  orphans.sort((a, b) => a.age_hours - b.age_hours || a.branch.localeCompare(b.branch));
  return { schema: PUBLISH_ORPHANS_SCHEMA, repo: upstream, window_hours: 48, orphans };
}
