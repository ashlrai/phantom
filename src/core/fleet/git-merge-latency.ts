import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ledgerEventName, ledgerPhase, ledgerPrUrl, ledgerRows } from './empty-cause.js';
import { readMergedPrFeed } from './merged-pr-feed.js';
import { readSource } from './runs-parked-queue.js';

export interface GitPublish { number: number; publishedAt: number }
export interface MasterCommit { subject: string; committedAt: number }
export interface GitMergeLatency {
  seconds: number | null; p90Seconds: number | null; paired: number;
  stillOpen: number | null; oldestOpenAgeSeconds: number | null; reason: string | null;
}
/** Epochs are seconds. Samples use merge time in the last 24 h; open ages include older publishes. */
export function mergeLatencyFromGit(publishes: readonly GitPublish[], masterCommits: readonly MasterCommit[], now: number): GitMergeLatency {
  const starts = new Map<number, number>(), ends = new Map<number, number>();
  for (const p of publishes) if (Number.isSafeInteger(p.number) && p.number > 0 && Number.isFinite(p.publishedAt) && p.publishedAt >= 0 && p.publishedAt <= now)
    starts.set(p.number, Math.min(starts.get(p.number) ?? Infinity, p.publishedAt));
  for (const c of masterCommits) {
    const number = Number(c.subject.match(/\(#([1-9]\d*)\)$/)?.[1]);
    if (Number.isSafeInteger(number) && number > 0 && Number.isFinite(c.committedAt) && c.committedAt >= 0 && c.committedAt <= now)
      ends.set(number, Math.min(ends.get(number) ?? Infinity, c.committedAt));
  }
  const samples: number[] = [], ages: number[] = [];
  for (const [number, start] of starts) {
    const end = ends.get(number);
    if (end === undefined) ages.push(now - start);
    else if (end >= start && end >= now - 86_400) samples.push(end - start);
  }
  samples.sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return { seconds: samples.length ? (samples[middle]! + samples[Math.floor((samples.length - 1) / 2)]!) / 2 : null,
    p90Seconds: samples[Math.ceil(samples.length * 0.9) - 1] ?? null, paired: samples.length,
    stillOpen: ages.length, oldestOpenAgeSeconds: ages.length ? ages.reduce((a, b) => Math.max(a, b)) : null,
    reason: samples.length ? null : 'no publications paired with master commits in the last 24 h' };
}

/** Bounded, no-follow publication reads; never fetches or calls gh. Repo numbers stay scoped to phantom. */
export async function readGitMergeLatency(root: string, ledger: string, now: number, repoRoot?: string): Promise<GitMergeLatency> {
  const publishes: GitPublish[] = [];
  const add = (url: string | null, at: number) => {
    const match = url?.match(/^https:\/\/github\.com\/ashlrai\/phantom\/pull\/([1-9]\d*)\/?$/);
    if (match) publishes.push({ number: Number(match[1]), publishedAt: at / 1000 });
  };
  for (const r of ledgerRows(ledger, now, 24 * 8, true).rows)
    if ((ledgerEventName(r.row) === 'publish' || ledgerPhase(r.row) === 'PUBLISHED') && !['MERGED', 'CLOSED'].includes(ledgerPhase(r.row) ?? '')) add(ledgerPrUrl(r.row), r.at);
  const files = (await readdir(root).catch(() => [])).filter(f => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.publish$/.test(f)).slice(-200);
  for (const name of files) {
    const file = join(root, name), source = await readSource(file, 4096, true);
    const info = source.state === 'healthy' ? await lstat(file).catch(() => null) : null;
    if (info?.isFile()) add(source.text.match(/^RESULT PR (\S+)(?:\s|$)/m)?.[1] ?? null, info.mtimeMs);
  }
  const feed = readMergedPrFeed({ repoRoot, now, since: publishes.reduce((since, p) => Math.min(since, p.publishedAt * 1000), now - 86_400_000) });
  const result = mergeLatencyFromGit(publishes, feed.prs.map(p => ({ subject: `(#${p.number})`, committedAt: Date.parse(p.mergedAt) / 1000 })), now / 1000);
  if (feed.state === 'unavailable') return { ...result, seconds: null, p90Seconds: null, paired: 0, stillOpen: null, oldestOpenAgeSeconds: null, reason: feed.reason };
  return feed.state === 'ok' ? result : { ...result, stillOpen: null, oldestOpenAgeSeconds: null, reason: feed.reason };
}

export function mergeLatencyLine(r: Omit<GitMergeLatency, 'reason'>): string {
  const age = (s: number | null): string => s === null ? 'unknown' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
  return `merge latency: median ${age(r.seconds)}, p90 ${age(r.p90Seconds)} (${r.paired} paired, ${r.stillOpen ?? 'unknown'} still open, oldest ${age(r.oldestOpenAgeSeconds)})`;
}
