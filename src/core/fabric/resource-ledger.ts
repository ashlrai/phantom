import type { ResourceSnapshot } from './resource-monitor.js';
import { BUDGET_POOLS, type BudgetPool, type PoolBudgetSnapshot } from '../fleet/pool-budget.js';

// Accounts and quota units stay separate: a backend's active window can be 5h
// while its pool budget is weekly. Never sum them or substitute one for another.
const BACKEND: Record<BudgetPool, string> = {
  'codex-cmp': 'codex', 'codex-personal': 'codex', claude: 'claude', devin: 'devin-cli',
  'grok-build': 'grok-cli', 'grok-ultra': 'grok-cli', 'local-omlx': 'local-coder',
};

/** Read-only derived ledger; pool-budget owns history, precedence and projections. */
export function buildResourceLedger(snapshot: ResourceSnapshot, budgets: PoolBudgetSnapshot) {
  const now = Date.parse(budgets.timestamp);
  const backends = [...new Set([...snapshot.backends.map(b => b.backend), ...Object.values(BACKEND)])];
  return { schema: 'resource.ledger.v1' as const, generatedAt: budgets.timestamp, sourceState: budgets.sourceState,
    backends: backends.map(backend => {
      const state = snapshot.backends.find(b => b.backend === backend);
      const resetMs = state?.resetsAt == null ? NaN : state.resetsAt * 1000;
      const resetAt = Number.isFinite(resetMs) && Math.abs(resetMs) <= 8.64e15 ? new Date(resetMs).toISOString() : null;
      const used = state?.usedPct;
      const known = state && state.availability !== 'unknown' && typeof used === 'number' && Number.isFinite(used) &&
        used >= 0 && used <= 100 && (resetAt === null || resetMs > now);
      return { backend, availability: state?.availability ?? 'unknown',
        monitor: { leftPct: known ? 100 - used : null, resetAt, observedAt: state?.snapshotAt ?? null },
        pools: BUDGET_POOLS.filter(pool => BACKEND[pool] === backend).map(pool => ({ pool, ...budgets.pools[pool] })) };
    }) };
}

export async function getResourceLedger(cfg: unknown) {
  const [{ getResourceSnapshot }, { readPoolBudgets }] = await Promise.all([
    import('./resource-monitor.js'), import('../fleet/pool-budget-store.js'),
  ]);
  const snapshot = await getResourceSnapshot(cfg);
  return buildResourceLedger(snapshot, await readPoolBudgets());
}
