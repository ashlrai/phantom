/**
 * Fleet snapshot -> intent ledger bridge, recovered from PR #4235's automatic
 * merge observation caller. It records merge facts only: matching open
 * directives become `merged` and gain one `pr` evidence row. It never ships,
 * verifies, closes, dispatches or sends anything, and it never throws.
 */
import { linkMergedPull, type EvidenceItem } from './evidence.js';
import type { IntentItem } from './schema.js';
import { readLedger, writeLedger } from './store.js';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_ROWS = 200;

export interface ObservedMerge { repo: string; number: number; title: string; mergedAt?: string | null }
export interface ObserveFleetMergesOptions {
  /** Runs directory the snapshot was built from (the intent store root). */
  runsDir: string;
  /** Snapshot clock, used when a row carries no valid merge time. */
  now: Date;
}
export interface ObserveFleetMergesResult { updated: number; persisted: boolean }

function valid(row: unknown): row is ObservedMerge {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return typeof r['repo'] === 'string' && REPO_RE.test(r['repo']) && typeof r['number'] === 'number'
    && Number.isSafeInteger(r['number']) && r['number'] > 0 && typeof r['title'] === 'string' && r['title'].length > 0;
}

function recorded(item: IntentItem, ref: string): boolean {
  const [repo, number] = [ref.slice(0, ref.lastIndexOf('#')).toLowerCase(), Number(ref.slice(ref.lastIndexOf('#') + 1))];
  return item.evidence.some((row) => row.kind === 'pr' && row.ref.toLowerCase() === ref.toLowerCase())
    && item.prs.some((pr) => pr.repo.toLowerCase() === repo && pr.number === number && pr.state === 'merged');
}

/**
 * Link observed merged pulls to tracked directives. Rows that were already
 * recorded leave the ledger untouched, so repeated snapshots are byte-stable.
 * An absent ledger is never created; an unreadable or corrupt one is left as is.
 */
export async function observeFleetMerges(rows: readonly unknown[], opts: ObserveFleetMergesOptions): Promise<ObserveFleetMergesResult> {
  const none = { updated: 0, persisted: false };
  try {
    const pulls = rows.slice(0, MAX_ROWS).filter(valid);
    if (pulls.length === 0) return none;
    const ledger = await readLedger(opts.runsDir);
    if (ledger.items.length === 0) return none;
    const touched = new Set<string>();
    for (const pull of pulls) {
      const ref = `${pull.repo}#${pull.number}`;
      const when = typeof pull.mergedAt === 'string' && !Number.isNaN(Date.parse(pull.mergedAt)) ? pull.mergedAt : opts.now.toISOString();
      // Link on a copy so already-recorded directives keep their exact bytes.
      const trial = structuredClone(ledger);
      const matched = linkMergedPull(trial, { repo: pull.repo, number: pull.number, title: pull.title }, when) as (EvidenceItem & IntentItem)[];
      for (const next of matched) {
        const index = ledger.items.findIndex((item) => item.id === next.id);
        if (index < 0 || recorded(ledger.items[index]!, ref)) continue;
        ledger.items[index] = next;
        touched.add(next.id);
      }
    }
    if (touched.size === 0) return none;
    await writeLedger(ledger, opts.runsDir);
    return { updated: touched.size, persisted: true };
  } catch {
    // Intent storage is advisory here: snapshot success never depends on it.
    return none;
  }
}
