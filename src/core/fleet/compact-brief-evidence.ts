/** Bounded local evidence missing from the dispatch status projection. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLedgerTs } from '../metrics/loop.js';
import { ledgerEventName, ledgerPhase, ledgerPrUrl, ledgerRows } from './empty-cause.js';
import { localTimestamp, readSource } from './runs-parked-queue.js';

export const objectRow = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function parseDispatchTick(line: string) {
  const match = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) tick run=(\{.*\}) q=(\d+) launched=(\d+) reap=(\d+) pause=(?:True|False) wall=(\d+(?:\.\d+)?)s(?: why=([\w-]+))?\s*$/);
  try {
    if (!match) throw new Error();
    const at = localTimestamp(match[1]!).ms;
    const running = objectRow(JSON.parse(match[2]!));
    if (!Number.isFinite(at) || Object.values(running).some(n => !Number.isSafeInteger(n) || Number(n) < 0)
      || !match.slice(3, 6).every(n => Number.isSafeInteger(Number(n))) || !Number.isFinite(Number(match[6]))) throw new Error();
    return { at, running: running as Record<string, number>, launched: Number(match[4]), wall: Number(match[6]), why: match[7] ?? null };
  } catch { return null; }
}
export function dispatchTick(text: string, now: number): { running: Record<string, number>; why: string } {
  const tick = parseDispatchTick(text.split('\n').filter(l => l.includes(' tick run=')).at(-1) ?? '');
  if (!tick) return { running: {}, why: 'no valid tick in the bounded log tail' };
  if (now - tick.at < 0 || now - tick.at > 120_000) return { running: {}, why: 'latest tick is stale or in the future' };
  return { running: tick.running, why: 'latest tick in the bounded log tail' };
}

export async function compactMergeLatency(root: string, ledger: string, now: number, prs: unknown) {
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
  const middle = Math.floor(samples.length / 2);
  return { seconds: samples.length ? Math.round(samples.length % 2 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2) : null,
    source: samples.length ? [...bases].join('; ') : null, why: samples.length ? `${samples.length} merged PRs in 24h; at most 200 inspected` : 'no mergedAt paired with PR creation or publication evidence in the bounded ledger' };
}
