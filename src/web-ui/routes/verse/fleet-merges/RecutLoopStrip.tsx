import { StatusBadge } from '../../../components/primitives/index.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { narrowRecutLoop, recutLoopLine } from './recut-loop-model.js';
import styles from './release-strip.module.css';

const recutLoopQuery: QueryDef<ReturnType<typeof narrowRecutLoop>> = {
  key: 'verse-recut-loop',
  fetch: async signal => {
    try {
      const view = narrowRecutLoop(await apiGet<unknown>('/api/verse/health/recut-loop', signal));
      if (!view) throw new Error('Invalid recut loop response');
      return view;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export function RecutLoopStrip({ visible }: { visible: boolean }) {
  const read = useQuery(recutLoopQuery, { enabled: visible, freshMs: 60_000 });
  const refetch = useRefetch(recutLoopQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible });
  if (read.status === 'error') return <div className={styles.strip} role="status">Recut loop state unavailable.</div>;
  if (!read.data) return null;
  const line = recutLoopLine(read.data, Date.now());
  return <div className={styles.strip} aria-label="Recut loop"><StatusBadge status={line.text} tone={line.tone === 'ok' ? 'success' : line.tone === 'warn' ? 'warning' : 'neutral'} /></div>;
}
