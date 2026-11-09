/** Recorded, advisory morning brief for the existing owner-channel delivery. */
import { readNeedsMason } from '../fleet/needs-mason-resolve.js';
import { BUDGET_POOLS, type PoolBudgetSnapshot } from '../fleet/pool-budget.js';
import { readPoolBudgets } from '../fleet/pool-budget-store.js';
import { listProposalsDetailed } from '../inbox/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { gatherBriefFacts, type BriefFacts } from './leader-brief.js';

export interface LeaderDailySources {
  facts: () => Promise<BriefFacts>;
  needs: () => { status: string; items: Array<{ text: string }> };
  budgets: () => Promise<PoolBudgetSnapshot>;
  proposals: () => { complete: boolean; proposals: Array<{ id: string; title: string }> };
}

/** No new execution or approval authority is conveyed by this text. */
export async function leaderDailyBrief(runsDir: string, now: Date, overrides: Partial<LeaderDailySources> = {}): Promise<string> {
  const sources: LeaderDailySources = {
    facts: () => gatherBriefFacts(now.getTime() - 12 * 3600_000, now.getTime()),
    needs: () => readNeedsMason({ runsDir }),
    budgets: () => readPoolBudgets(undefined, now),
    proposals: () => listProposalsDetailed({ status: 'pending' }),
    ...overrides,
  };
  const clean = (s: string, limit = 110): string => scrubSecrets(s).replace(/\s+/g, ' ').trim().slice(0, limit);
  const lines = ['Morning leader brief'];
  try {
    const facts = await sources.facts();
    const shipped = facts.shipped.slice(0, 3).map(item => clean(item.text));
    lines.push(`Shipped (last 12h): ${shipped.length ? shipped.join('; ') : facts.mergeCountUnavailable ? 'unavailable' : 'none'}${facts.mergeCountUnavailable && shipped.length ? ' (incomplete)' : ''}`);
  } catch { lines.push('Shipped (last 12h): unavailable'); }
  try {
    const needs = sources.needs();
    const items = needs.items.filter(item => /\b(?:2fa|mfa|password|payment|billing)\b/i.test(item.text)).slice(0, 3);
    lines.push(`Needs you: ${needs.status !== 'available' ? 'unavailable' : items.map(item => clean(item.text)).join('; ') || 'none identified'}`);
  } catch { lines.push('Needs you: unavailable'); }
  try {
    const budgets = await sources.budgets();
    lines.push(`Quota: ${BUDGET_POOLS.map(pool => {
      const view = budgets.pools[pool];
      const values = Object.entries(view.buckets).map(([name, bucket]) => `${name}=${bucket.remaining ?? '?'}${name === 'weeklyPct' && bucket.remaining !== null ? '%' : ''}`);
      return `${pool} ${values.join(',')}${view.mode === 'held' ? ' (held)' : ''}`;
    }).join('; ')}`);
  } catch { lines.push('Quota: unavailable'); }
  try {
    const result = sources.proposals();
    const proposals = result.proposals.slice(0, 2).map(p => `${clean(p.title, 80)} [${clean(p.id, 80)}]`);
    lines.push(`Pending proposals (newest): ${proposals.join('; ') || (result.complete ? 'none' : 'unavailable')}${!result.complete && proposals.length ? ' (incomplete)' : ''}`);
  } catch { lines.push('Pending proposals: unavailable'); }
  return lines.join('\n');
}
