import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usageResourcesQuery } from '../usage/usage-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useNow } from '../autonomy/use-ticker.js';
import styles from './ResourcesDrawer.module.css';

const pools = ['zai', 'gemini', 'claude', 'codex-personal'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function UsagePace() {
  const read = useQuery(usageResourcesQuery, { freshMs: 30_000 });
  const refetch = useRefetch(usageResourcesQuery);
  usePollWhileVisible(refetch, 30_000);
  const clock = useNow(1_000);
  const now = Math.max(clock, Date.now());
  const raw = read.status === 'success' && read.error === undefined && read.data?.available ? read.data.raw : null;
  const pace = object(raw) && object(raw.pace) ? raw.pace : {};
  const tick = typeof pace.asOf === 'string' ? Date.parse(pace.asOf) : NaN;
  const fresh = pace.v === 1 && Number.isFinite(tick) && now >= tick && now - tick <= 120_000;
  const rows = Array.isArray(pace.pools) ? pace.pools : [];
  return <section aria-label="Usage pace"><h3>Usage pace</h3><ul className={styles.subtle}>
    {pools.map(pool => {
      const row: unknown = rows.find((value: unknown) => object(value) && value.pool === pool);
      const pct = object(row) ? row.projectedPercent : null;
      const hours = object(row) ? row.hoursLeft : null;
      const slots = object(row) ? row.recommendedSlots : null;
      const known = fresh && typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100
        && typeof hours === 'number' && Number.isFinite(hours) && hours > 0;
      const slotText = fresh && typeof slots === 'number' && Number.isInteger(slots) && slots >= 0 ? String(slots) : 'unknown';
      return <li key={pool}><strong>{pool}</strong>: {known ? `on pace to use ${pct}% before reset (${hours} h left)` : 'unknown'} · suggested running slots: {slotText}</li>;
    })}
  </ul></section>;
}
