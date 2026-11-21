/**
 * "What shipped in the last hour", read from local git only (no GitHub): the first-parent history of the
 * default branch in every local clone. Each merged change gets one plain line and one of five buckets
 * (fleet, desktop/phone, docs/site, tests, other). The report keeps the `fleet.shipped.v1` shape and adds
 * `window`, `headline`, `buckets` and a per-item `bucket`, so readers of the 24h feed keep working.
 * Behind `phm shipped --since 1h`, `GET /api/verse/shipped?since=1h`, the desktop Home line and the leader brief.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { areaOf, type ShippedAreaId } from '../release/shipped.js';
import { scrubSecrets } from '../util/scrub.js';

export type ShippedBucketId = 'fleet' | 'desktop-phone' | 'docs-site' | 'tests' | 'other';
export const SHIPPED_BUCKETS: ReadonlyArray<{ id: ShippedBucketId; label: string }> = [
  { id: 'fleet', label: 'fleet' }, { id: 'desktop-phone', label: 'desktop/phone' }, { id: 'docs-site', label: 'docs/site' },
  { id: 'tests', label: 'tests' }, { id: 'other', label: 'other' },
];
export interface HourItem {
  repo: string; number: number | null; title: string; url: string; mergedAt: string;
  jobId: string | null; lane: null; openToMergeSeconds: null; bucket: ShippedBucketId;
}
export interface HourBucket { id: ShippedBucketId; label: string; count: number }
export interface HourShippedReport {
  schema: 'fleet.shipped.v1'; window: '1h'; since: string; generatedAt: string; complete: boolean; headline: string;
  items: HourItem[]; buckets: HourBucket[]; byRepo: Record<string, number>; total: number | null;
}
export interface HourCommit { sha: string; mergedAt: string; subject: string; paths: string[] }
/** One clone's history, or null when it could not be read. */
export type HourRepoRead = { repo: string; commits: HourCommit[] } | null;

const HOUR_MS = 3_600_000;
const JOB_RE = /\b(RQ-[A-Z0-9-]{3,80})\b/;
const TESTISH = /(^|\/)(tests?|__tests__|fixtures)\/|\.(test|spec)\.[a-z]+$/;

/** `bridge(RQ-X): Add a card (#12)` and `feat(web): add a card` both read "Add a card". */
export function plainTitle(subject: string, number: number | null): string {
  const text = scrubSecrets(subject).replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/^Merge pull request #\d+ from \S+\s*/, '')
    .replace(/^bridge(\([^)]*\))?:?\s*/i, '')
    .replace(/^(feat|fix|docs|test|tests|chore|refactor|perf|ci|build|style)(\([^)]*\))?!?:\s*/i, '')
    .replace(/\s+/g, ' ').trim();
  if (!text) return number === null ? 'Change merged' : `Change #${number}`;
  return (text[0]!.toUpperCase() + text.slice(1)).slice(0, 140);
}

/** Tests only when every file is a test or fixture; otherwise the biggest product area decides, then the title. */
export function bucketOf(paths: string[], subject: string, repo: string): ShippedBucketId {
  if (paths.length > 0 && paths.every(path => TESTISH.test(path))) return 'tests';
  const area: ShippedAreaId = areaOf(paths, { repo });
  if (area === 'fleet') return 'fleet';
  if (area === 'desktop' || area === 'mobile') return 'desktop-phone';
  if (area === 'docs') return 'docs-site';
  if (area !== 'other' && area !== 'unknown') return 'other';
  // No product path decided it (or only unknown ones): the title's own words.
  const title = subject.toLowerCase();
  if (/^(bridge|fleet)\b|\b(fleet|lane|queue|daemon|leader)\b/.test(title)) return 'fleet';
  if (/\b(desktop|phone|mobile|ios|verse|home)\b/.test(title)) return 'desktop-phone';
  if (/^docs?\b|\b(docs|readme|website|site)\b/.test(title)) return 'docs-site';
  if (/^tests?\b|\btests?\b/.test(title)) return 'tests';
  return 'other';
}

export function hourHeadline(buckets: HourBucket[], total: number): string {
  if (total === 0) return 'Nothing shipped in the last hour.';
  const parts = buckets.filter(bucket => bucket.count > 0).map(bucket => `${bucket.count} ${bucket.label}`);
  return `Last hour: ${total} shipped (${parts.join(', ')})`;
}

export function buildHourShipped(reads: HourRepoRead[], now: number, windowMs = HOUR_MS): HourShippedReport {
  const since = now - windowMs;
  const seen = new Set<string>();
  const items: HourItem[] = [];
  for (const read of reads) for (const commit of read?.commits ?? []) {
    const at = Date.parse(commit.mergedAt);
    if (!(at >= since && at <= now)) continue;
    const number = /\(#(\d+)\)\s*$/.exec(commit.subject)?.[1] ?? /^Merge pull request #(\d+)/.exec(commit.subject)?.[1];
    const key = number ? `${read!.repo}#${number}` : commit.sha;
    if (seen.has(key)) continue; // the same clone listed twice, or a worktree of it
    seen.add(key);
    const n = number ? Number(number) : null;
    items.push({
      repo: read!.repo, number: n, title: plainTitle(commit.subject, n),
      url: n === null ? '' : `https://github.com/${read!.repo}/pull/${n}`, mergedAt: new Date(at).toISOString(),
      jobId: JOB_RE.exec(commit.subject)?.[1] ?? null, lane: null, openToMergeSeconds: null,
      bucket: bucketOf(commit.paths, commit.subject, read!.repo),
    });
  }
  items.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || a.repo.localeCompare(b.repo) || (b.number ?? 0) - (a.number ?? 0));
  const complete = reads.length > 0 && reads.every(read => read !== null);
  const buckets = SHIPPED_BUCKETS.map(({ id, label }) => ({ id, label, count: items.filter(item => item.bucket === id).length }));
  const repos = [...new Set(items.map(item => item.repo))].sort();
  return {
    schema: 'fleet.shipped.v1', window: '1h', since: new Date(since).toISOString(), generatedAt: new Date(now).toISOString(), complete,
    headline: !complete && items.length === 0 ? 'Unknown: the last hour could not be read.' : hourHeadline(buckets, items.length),
    items, buckets, byRepo: Object.fromEntries(repos.map(repo => [repo, items.filter(item => item.repo === repo).length])),
    total: complete ? items.length : null,
  };
}

const git = (root: string, args: string[]) => new Promise<string | null>(done => {
  execFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (error, stdout) => done(error ? null : stdout));
});

/** First-parent changes on origin's default branch (else master, main, HEAD) since `sinceMs`, with their files. */
export async function readCloneHistory(root: string, sinceMs: number): Promise<HourRepoRead> {
  const url = (await git(root, ['remote', 'get-url', 'origin']))?.trim() ?? '';
  const repo = /([^/:@]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? basename(root);
  let branch = '';
  for (const ref of ['refs/remotes/origin/master', 'refs/remotes/origin/main', 'refs/heads/master', 'refs/heads/main', 'HEAD']) {
    if (await git(root, ['rev-parse', '--verify', '--quiet', ref]) !== null) { branch = ref; break; }
  }
  if (!branch) return null;
  const log = await git(root, ['log', branch, '--first-parent', '--diff-merges=first-parent', `--since=${new Date(sinceMs).toISOString()}`,
    '--name-only', '--format=%x1e%H%x1f%cI%x1f%s', '--']);
  if (log === null) return null;
  const commits = log.split('\x1e').filter(Boolean).map((block): HourCommit => {
    const [head = '', ...files] = block.split('\n');
    const [sha = '', mergedAt = '', subject = ''] = head.split('\x1f');
    return { sha, mergedAt, subject, paths: files.map(f => f.trim()).filter(Boolean) };
  });
  return { repo, commits };
}

/** Clones directly under the checkout folder (`~/Projects/ashlrai`); job worktrees under `wt/` are skipped. */
export function findClones(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'wt' && existsSync(join(root, entry.name, '.git')))
      .map(entry => join(root, entry.name)).sort();
  } catch { return []; }
}

export interface ReadHourDeps { now?: number; roots?: string[]; read?: (root: string, sinceMs: number) => Promise<HourRepoRead> }
/** Clones come from `roots`, else ASHLR_CHECKOUT_ROOT, else ~/Projects/ashlrai. Never throws. */
export async function readHourShipped(deps: ReadHourDeps = {}): Promise<HourShippedReport> {
  const now = deps.now ?? Date.now();
  const roots = deps.roots ?? [process.env['ASHLR_CHECKOUT_ROOT']?.trim() || join(homedir(), 'Projects/ashlrai')];
  const clones = roots.flatMap(findClones);
  const read = deps.read ?? readCloneHistory;
  const reads = await Promise.all(clones.map(clone => read(clone, now - HOUR_MS).catch(() => null)));
  return buildHourShipped(reads, now);
}

/** Plain text for the terminal: the headline, then one line per change grouped by bucket. */
export function hourShippedText(report: HourShippedReport): string[] {
  const lines = [report.headline];
  for (const bucket of report.buckets.filter(b => b.count > 0)) {
    lines.push('', `${bucket.label} (${bucket.count})`);
    for (const item of report.items.filter(i => i.bucket === bucket.id)) {
      lines.push(`  ${item.title} (${item.repo.replace(/^.*\//, '')}${item.number === null ? '' : ` #${item.number}`})`);
    }
  }
  if (!report.complete && report.items.length > 0) lines.push('', 'Some clones could not be read, so this may be missing changes.');
  return lines;
}
