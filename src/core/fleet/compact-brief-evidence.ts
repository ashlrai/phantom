/** Bounded local evidence missing from the dispatch status projection. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLedgerTs } from '../metrics/loop.js';
import { ledgerEventName, ledgerPhase, ledgerPrUrl, ledgerRows } from './empty-cause.js';
import { localTimestamp, readSource } from './runs-parked-queue.js';
import { readGitMergeLatency } from './git-merge-latency.js';

export const objectRow = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function dispatchTick(text: string, now: number): { running: Record<string, number>; why: string } {
  const line = text.split('\n').filter(l => l.includes(' tick run=')).at(-1);
  const match = line?.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) tick run=(\{.*\}) q=\d+ launched=\d+ reap=\d+ pause=(?:True|False) wall=\d+s\s*$/);
  try {
    if (!match) throw new Error();
    const age = now - localTimestamp(match[1]!).ms;
    if (!Number.isFinite(age) || age < 0 || age > 120_000) return { running: {}, why: 'latest tick is stale or in the future' };
    const running = objectRow(JSON.parse(match[2]!));
    if (!Object.keys(running).length || Object.values(running).some(n => !Number.isSafeInteger(n) || Number(n) < 0)) throw new Error();
    return { running: running as Record<string, number>, why: 'latest tick in the bounded log tail' };
  } catch { return { running: {}, why: 'no valid tick in the bounded log tail' }; }
}

export async function compactMergeLatency(root: string, ledger: string, now: number, prs: unknown, gitFallback = prs === null, repoRoot?: string) {
  const snapshot = (Array.isArray(prs) ? prs : []).map(value => objectRow(value)).filter(pr => pr.mergedAt && pr.createdAt)
    .map(pr => JSON.stringify({ ...pr, event: 'merged', ts: pr.mergedAt, briefSource: 'fleet/open-prs.json' }));
  const rows = ledgerRows([ledger, ...snapshot].join('\n'), now, 24 * 8, true).rows;
  const merged = new Map<string, typeof rows[number]>();
  for (const r of rows) if (ledgerPhase(r.row) === 'MERGED' || ledgerEventName(r.row) === 'merged') {
    const key = ledgerPrUrl(r.row)?.replace(/\/$/, '') ?? r.id;
    merged.set(key, { ...r, row: { ...merged.get(key)?.row, ...r.row } });
  }
  const samples: number[] = [], bases = new Set<string>();
  for (const r of [...merged.values()].slice(-200)) {
    const end = parseLedgerTs(r.row.mergedAt ?? r.row.pr_merged_at ?? r.row.merged_at);
    if (end === null || end > now || end < now - 86_400_000) continue;
    const url = ledgerPrUrl(r.row);
    let start = parseLedgerTs(r.row.createdAt ?? r.row.prCreatedAt ?? r.row.pr_created_at), basis = r.row.briefSource === 'fleet/open-prs.json' ? 'fleet/open-prs.json' : 'PR timestamps in metrics/jobs.jsonl';
    if (start === null) {
      const publications = rows.filter(p => (ledgerEventName(p.row) === 'publish' || ledgerPhase(p.row) === 'PUBLISHED') && ledgerPhase(p.row) !== 'MERGED'
        && ledgerPhase(p.row) !== 'CLOSED' && p.at <= end && (url ? ledgerPrUrl(p.row) === url : p.id === r.id));
      start = publications.length ? Math.min(...publications.map(p => p.at)) : null;
      basis = 'publication to mergedAt in metrics/jobs.jsonl';
      if (start === null && r.id) {
        const file = join(root, `${r.id}.publish`), source = await readSource(file, 4096, true);
        const publishedUrl = source.text.match(/^RESULT PR (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?)(?:\s|$)/m)?.[1];
        if (publishedUrl && (!url || publishedUrl.replace(/\/$/, '') === url.replace(/\/$/, ''))) {
          const info = await lstat(file).catch(() => null);
          start = info?.isFile() ? info.mtimeMs : null;
          basis = '*.publish mtime to mergedAt in metrics/jobs.jsonl';
        }
      }
    }
    if (start !== null && start <= end) { samples.push((end - start) / 1000); bases.add(basis); }
  }
  samples.sort((a, b) => a - b);
  if (gitFallback) {
    const git = await readGitMergeLatency(root, ledger, now, repoRoot);
    if (git.paired || !samples.length) return { ...git, source: 'git', why: git.reason ?? `${git.paired} merged PRs in 24h from local git; bounded ledger and at most 200 publication files` };
  }
  const middle = Math.floor(samples.length / 2);
  return { p90Seconds: samples[Math.ceil(samples.length * 0.9) - 1] ?? null, paired: samples.length, stillOpen: null, oldestOpenAgeSeconds: null,
    seconds: samples.length ? Math.round(samples.length % 2 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2) : null,
    source: samples.length ? [...bases].join('; ') : null, why: samples.length ? `${samples.length} merged PRs in 24h; at most 200 inspected` : 'no mergedAt paired with PR creation or publication evidence in the bounded ledger' };
}
