import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usageResourcesQuery } from '../usage/usage-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useNow } from '../autonomy/use-ticker.js';
import { paceForecastText } from './usage-pace-text.js';
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
  const given: unknown[] = Array.isArray(pace.pools) ? pace.pools : [];
  const named = given.filter((v): v is Record<string, unknown> & { pool: string } => object(v) && typeof v.pool === 'string');
  // Rows come from the API in the order given; core pools it omitted still show as unknown.
  const rows = [...named, ...pools.filter(p => !named.some(r => r.pool === p)).map(pool => ({ pool }))];
  return <section aria-label="Usage pace"><h3>Usage pace</h3><ul className={styles.subtle}>
    {rows.map(row => {
      const slots = (row as Record<string, unknown>).recommendedSlots;
      const slotText = fresh && typeof slots === 'number' && Number.isInteger(slots) && slots >= 0 ? String(slots) : 'unknown';
      return <li key={row.pool}><strong>{row.pool}</strong>: {paceForecastText(row, fresh)} · suggested running slots: {slotText}</li>;
    })}
  </ul></section>;
}
