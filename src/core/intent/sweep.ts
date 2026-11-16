import { IntentError, MAX_EVIDENCE, type IntentItem, type IntentStatus } from './schema.js';
import { readLedger, transactIntentLedger } from './store.js';

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

const overdue = (item: IntentItem, now: number): boolean =>
  !terminal.has(item.status) && now - Date.parse(item.lastTouchedAt) > item.staleAfterMs;

/** Refresh local tracking only; recommendations never close or dispatch work. */
export async function sweepStale(opts: { root?: string; apply?: boolean; now?: string } = {}): Promise<{ stale: SweepRow[]; applied: boolean; updated: number }> {
  const at = opts.now ?? new Date().toISOString();
  const now = Date.parse(at);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(now)) {
    throw new IntentError('Time must be an ISO timestamp.');
  }
  if (!opts.apply) {
    const items = (await readLedger(opts.root)).items.filter(item => overdue(item, now));
    return { stale: items.map(item => ({ id: item.id, title: item.title, status: item.status, action: actionFor(item) })), applied: false, updated: 0 };
  }
  // This unlocked read only skips the no-op case: an apply with nothing stale
  // still writes nothing (and never creates a ledger), exactly as the old
  // unlocked path behaved. The read-modify-write below recomputes against the
  // freshest ledger inside transactIntentLedger, so a concurrent
  // addIntent/updateIntent committed before the lock is seen and preserved.
  if (!(await readLedger(opts.root)).items.some(item => overdue(item, now))) {
    return { stale: [], applied: opts.apply === true, updated: 0 };
  }
  const stale = await transactIntentLedger(opts.root, (ledger) => {
    const items = ledger.items.filter(item => overdue(item, now));
    const actions = items.map(actionFor);
    for (const [index, item] of items.entries()) {
      const action = actions[index]!;
      if (action === 'requeue') item.status = 'queued';
      item.evidence = [...item.evidence, { at, kind: 'sweep' as const, ref: action, note: 'Local stale tracking refreshed; no job dispatched.' }].slice(-MAX_EVIDENCE);
      item.lastTouchedAt = at;
      item.updatedAt = at;
    }
    // Rows report the persisted status: post-apply when applying, untouched on preview.
    return items.map((item, index) => ({ id: item.id, title: item.title, status: item.status, action: actions[index]! }));
  });
  return { stale, applied: opts.apply === true, updated: stale.length };
}
