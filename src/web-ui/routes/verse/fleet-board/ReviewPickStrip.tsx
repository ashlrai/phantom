/**
 * routes/verse/fleet-board/ReviewPickStrip.tsx — "Needs a reviewer": the one
 * open PR no live claim or running worker owns, or the honest reason there is
 * none. Read-only; renders nothing while the route is absent or unreadable.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { reviewPickQuery } from './review-pick-query.js';
import styles from './fleet-board.module.css';

const pad = (n: number): string => String(n).padStart(2, '0');

function clock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReviewPickStrip({ visible = true }: { visible?: boolean }) {
  const read = useQuery(reviewPickQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(reviewPickQuery);
  usePollWhileVisible(() => { refetch(); }, 15_000, { enabled: visible });

  const data = read.data;
  if (data === undefined || data.kind === 'unavailable') return null;
  return (
    <section className={styles.orderStrip} aria-label="Needs a reviewer">
      {data.kind === 'pick' ? (
        <p className={styles.orderNote}>
          Needs a reviewer: {data.prUrl === null
            ? `${data.repo}#${data.pr}`
            : <a href={data.prUrl} target="_blank" rel="noreferrer noopener">{data.repo}#{data.pr}</a>} · <span className={styles.mono}>{data.headShort}</span> · {data.title} · as of {clock(data.asOf)}
        </p>
      ) : (
        <p className={styles.orderNote}>
          Needs a reviewer: none — {data.reason}{data.unavailable.length > 0 ? ` · sources unavailable: ${data.unavailable.join(', ')}` : ''} · as of {clock(data.asOf)}
        </p>
      )}
    </section>
  );
}
