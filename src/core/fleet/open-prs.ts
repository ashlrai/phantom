/** GitHub reads only; the sole write is the private local fleet snapshot. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';
import { readSource } from './runs-parked-queue.js';

export interface OpenPr {
  repo: string; number: number; mergeStateStatus: string; mergeable: string;
  createdAt: string | null; ageHours: number | null; jobId: string | null;
}
export interface OpenPrSnapshot {
  schema: 'fleet.open-prs.v1'; v: 1; repo: string; generatedAt: string;
  observedAt: string | null; state: 'ready' | 'fallback' | 'unavailable';
  total: number | null; items: OpenPr[] | null;
}
export const OPEN_PRS_FILE = 'fleet/open-prs.json';
export const OPEN_PRS_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const MERGE_STATES = ['CLEAN', 'DIRTY', 'BEHIND', 'BLOCKED', 'UNSTABLE', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN'];
const MERGEABLE = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];
const row = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};

/** Reject stale, failed or malformed counts; null means unknown, never zero. */
export function openPrCount(value: unknown, now: number): number | null {
  const s = row(value), age = now - Date.parse(String(s.observedAt));
  return s.schema === 'fleet.open-prs.v1' && s.state === 'ready' && OPEN_PRS_REPO.test(String(s.repo))
    && age >= 0 && age <= 300_000 && Array.isArray(s.items) && Number.isSafeInteger(s.total)
    && typeof s.total === 'number' && s.total === s.items.length && s.total >= 0
    && s.items.every(value => { const r = row(value); return r.repo === s.repo && typeof r.number === 'number' && Number.isSafeInteger(r.number) && r.number > 0
      && typeof r.mergeStateStatus === 'string' && MERGE_STATES.includes(r.mergeStateStatus) && typeof r.mergeable === 'string' && MERGEABLE.includes(r.mergeable)
      && (r.createdAt === null || typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)))
      && (r.ageHours === null || typeof r.ageHours === 'number' && Number.isFinite(r.ageHours) && r.ageHours >= 0)
      && (r.jobId === null || typeof r.jobId === 'string' && /^RQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(r.jobId)); }) ? s.total : null;
}

export async function refreshOpenPrs(root: string, repo: string, now = Date.now(), run: GitRunner = defaultGitRunner): Promise<OpenPrSnapshot> {
  if (!OPEN_PRS_REPO.test(repo)) throw new Error('Use owner/name for the repository.');
  const file = join(root, OPEN_PRS_FILE);
  const snapshot: OpenPrSnapshot = { schema: 'fleet.open-prs.v1', v: 1, repo, generatedAt: new Date(now).toISOString(),
    observedAt: null, state: 'unavailable', total: null, items: null };
  try {
    const result = await run('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json',
      'number,mergeStateStatus,mergeable,createdAt,title,headRefName'], { cwd: tmpdir(), timeoutMs: 30_000, maxStdoutBytes: 1024 * 1024 });
    if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('GitHub unavailable');
    const rows: unknown = JSON.parse(result.stdout), seen = new Set<number>();
    if (!Array.isArray(rows) || rows.length >= 1000) throw new Error('Incomplete PR list');
    snapshot.items = rows.map(value => {
      const r = row(value), number = r.number;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || seen.has(number)) throw new Error('Invalid PR');
      seen.add(number);
      const opened = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
      const createdAt = Number.isFinite(opened) && opened <= now ? new Date(opened).toISOString() : null;
      const jobIds = new Set(`${String(r.title ?? '')} ${String(r.headRefName ?? '')}`.match(/\bRQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g));
      return { repo, number, createdAt, ageHours: createdAt ? (now - opened) / 3_600_000 : null,
        mergeStateStatus: MERGE_STATES.includes(String(r.mergeStateStatus)) ? String(r.mergeStateStatus) : 'UNKNOWN',
        mergeable: MERGEABLE.includes(String(r.mergeable)) ? String(r.mergeable) : 'UNKNOWN',
        jobId: jobIds.size === 1 ? [...jobIds][0]! : null };
    });
    snapshot.state = 'ready'; snapshot.observedAt = snapshot.generatedAt; snapshot.total = snapshot.items.length;
  } catch {
    try {
      const source = await readSource(file, 1024 * 1024, false), previous: unknown = JSON.parse(source.text);
      const p = row(previous);
      if (source.state === 'healthy' && p.repo === repo && ['ready', 'fallback'].includes(String(p.state))
        && openPrCount({ ...p, state: 'ready', total: Array.isArray(p.items) ? p.items.length : null }, now) !== null) {
        snapshot.items = (p.items as OpenPr[]).map(({ repo, number, mergeStateStatus, mergeable, createdAt, ageHours, jobId }) => ({ repo, number, mergeStateStatus, mergeable, createdAt, ageHours, jobId })); snapshot.observedAt = p.observedAt as string; snapshot.state = 'fallback';
      }
    } catch { /* No usable cache: preserve unknown. Never expose API errors. */ }
  }
  await mkdir(join(root, 'fleet'), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(file, JSON.stringify(snapshot) + '\n');
  return snapshot;
}
