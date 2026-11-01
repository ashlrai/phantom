/** Read-only release-please PR projection. Command failures remain unknown. */
import type { OpsRunner } from './ops-releases.js';
import { scrubSecrets } from '../util/scrub.js';

export interface ReleasePrCheckV1 {
  name: string;
  state: 'pass' | 'fail' | 'pending' | 'skipped';
  url: string | null;
}
export interface ReleasePrV1 {
  number: number;
  title: string;
  url: string | null;
  version: string | null;
  openedAt: string | null;
  updatedAt: string | null;
  mergeable: string | null;
  checks: ReleasePrCheckV1[];
  failing: string[];
  pending: number;
  blocked: boolean;
  summary: string;
}
const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' ? scrubSecrets(value).slice(0, max) : null;
const githubUrl = (value: unknown): string | null =>
  typeof value === 'string' && value.startsWith('https://github.com/') ? text(value, 2048) : null;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function check(row: Record<string, unknown>): ReleasePrCheckV1 {
  const conclusion = String(row.conclusion ?? row.state ?? '').toUpperCase();
  const legacyState = String(row.state ?? '').toUpperCase();
  const status = typeof row.status === 'string' ? row.status.toUpperCase() : null;
  const state = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR'].includes(conclusion)
    || ['ERROR', 'FAILURE'].includes(legacyState) ? 'fail'
    : (status !== null && status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(legacyState)
      ? 'pending'
      : ['SKIPPED', 'NEUTRAL'].includes(conclusion) ? 'skipped' : 'pass';
  return { name: text(row.name ?? row.context) ?? 'Unknown check', state, url: githubUrl(row.detailsUrl ?? row.targetUrl) };
}

export type ReleasePrMergeResult =
  | { ok: true; sha: string | null }
  | { ok: false; code: 'not-found' | 'not-green' | 'blocked' | 'gh-failed'; detail: string };

/** `owner/name` — the only repo shape mergeReleasePr will put on a gh argv. */
export function isReleasePrRepoName(repo: unknown): repo is string {
  return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    && !repo.split('/').some((part) => part === '.' || part === '..');
}

/** The merged head commit, best effort — null when gh cannot answer. Never throws. */
async function mergeCommitSha(repo: string, number: number, run: OpsRunner): Promise<string | null> {
  try {
    const raw = await run('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'mergeCommit']);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const oid = record(parsed) && record(parsed.mergeCommit) ? text(parsed.mergeCommit.oid, 64) : null;
    return oid !== null && /^[0-9a-f]{7,64}$/i.test(oid) ? oid : null;
  } catch { return null; }
}

/**
 * Merge the open release-please PR, re-probed so a row that went red or moved
 * numbers since the last read is refused instead of merged. `--merge` (not the
 * fleet's `--squash`): a release-please landing keeps its merge commit. argv
 * carries only a validated owner/name and a safe integer — never caller text.
 */
export async function mergeReleasePr(repo: string, number: number, run: OpsRunner): Promise<ReleasePrMergeResult> {
  const fail = (code: 'not-found' | 'not-green' | 'blocked' | 'gh-failed', detail: string): ReleasePrMergeResult =>
    ({ ok: false, code, detail: scrubSecrets(detail).slice(0, 300) });
  if (!isReleasePrRepoName(repo) || !Number.isSafeInteger(number) || number <= 0) return fail('not-found', 'no such release PR');
  const pr = await probeReleasePr(repo, run);
  if (pr === null || pr.number !== number) {
    return fail('not-found', pr === null ? 'no open release PR found' : `the open release PR is #${pr.number}, not #${number}`);
  }
  // Green but unmergeable on git grounds is a different fix than waiting on checks.
  if (pr.mergeable === 'CONFLICTING') return fail('blocked', `release PR #${number} has merge conflicts — rebase it first`);
  if (pr.blocked || pr.pending > 0 || pr.failing.length > 0) return fail('not-green', pr.summary);
  const merged = await run('gh', ['pr', 'merge', String(number), '--repo', repo, '--merge', '--delete-branch=false']);
  if (merged === null) return fail('gh-failed', `gh pr merge ${number} --repo ${repo} failed`);
  return { ok: true, sha: await mergeCommitSha(repo, number, run) };
}

/** Returns null for no matching PR or an unavailable/malformed source. Never throws. */
export async function probeReleasePr(repo: string, run: OpsRunner): Promise<ReleasePrV1 | null> {
  try {
    const raw = await run('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--search', 'release in:title',
      '--json', 'number,title,url,createdAt,updatedAt,mergeable,headRefName,statusCheckRollup', '-L', '10']);
    if (raw === null) return null;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r: unknown) => record(r) && typeof r.title === 'string'
      && /^chore\(.+\): release \d+\.\d+\.\d+/.test(r.title)
      && typeof r.headRefName === 'string' && r.headRefName.startsWith('release-please--')) as Record<string, unknown> | undefined;
    if (!row || !Number.isSafeInteger(row.number) || (row.number as number) <= 0) return null;
    const title = text(row.title, 300)!;
    const version = /^chore\(.+\): release (\d+\.\d+\.\d+)/.exec(title)?.[1]?.slice(0, 64) ?? null;
    const checks = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup.filter(record).map(check) : [];
    const failing = checks.filter((c) => c.state === 'fail').map((c) => c.name);
    const pending = checks.filter((c) => c.state === 'pending').length;
    const label = version ?? 'Release';
    return {
      number: row.number as number, title, url: githubUrl(row.url), version,
      openedAt: text(row.createdAt, 64), updatedAt: text(row.updatedAt, 64), mergeable: text(row.mergeable, 40),
      checks, failing, pending, blocked: failing.length > 0,
      summary: failing.length ? `${label} blocked by ${failing.join(', ')}`
        : pending ? `${label} waiting on ${pending} checks` : `${label} green, waiting for merge`,
    };
  } catch { return null; }
}
