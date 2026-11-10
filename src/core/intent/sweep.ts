import { IntentError, MAX_EVIDENCE, type IntentItem, type IntentStatus } from './schema.js';
import { readLedger, writeLedger } from './store.js';

export interface SweepRow {
  id: string;
  title: string;
  status: IntentStatus;
  action: 'requeue' | 'propose-superseded' | 'await-verification';
}

const terminal = new Set<IntentStatus>(['shipped', 'verified', 'closed', 'superseded']);

function actionFor(item: IntentItem): SweepRow['action'] {
  if (item.status === 'merged') return 'await-verification';
  if (item.status === 'in-progress') return 'requeue';
  if (item.closureProposal === 'superseded' || item.evidence.some(row => row.kind === 'sweep' && row.ref === 'requeue') || (!item.rq.length && !item.prs.length)) return 'propose-superseded';
  return 'requeue';
}

/** Refresh local tracking only; recommendations never close or dispatch work. */
export async function sweepStale(opts: { root?: string; apply?: boolean; now?: string } = {}): Promise<{ stale: SweepRow[]; applied: boolean; updated: number }> {
  const at = opts.now ?? new Date().toISOString();
  const now = Date.parse(at);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(now)) {
    throw new IntentError('Time must be an ISO timestamp.');
  }
  const ledger = await readLedger(opts.root);
  const items = ledger.items.filter(item => !terminal.has(item.status) && now - Date.parse(item.lastTouchedAt) > item.staleAfterMs);
  const actions = items.map(actionFor);
  if (opts.apply) {
    for (const [index, item] of items.entries()) {
      const action = actions[index]!;
      if (action === 'requeue') item.status = 'queued';
      item.evidence = [...item.evidence, { at, kind: 'sweep' as const, ref: action, note: 'Local stale tracking refreshed; no job dispatched.' }].slice(-MAX_EVIDENCE);
      item.lastTouchedAt = at;
      item.updatedAt = at;
    }
    if (items.length) await writeLedger(ledger, opts.root);
  }
  // Rows report the persisted status: post-apply when applying, untouched on preview.
  const stale = items.map((item, index) => ({ id: item.id, title: item.title, status: item.status, action: actions[index]! }));
  return { stale, applied: opts.apply === true, updated: opts.apply ? items.length : 0 };
}
