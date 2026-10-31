import { useEffect, useRef, useState } from 'react';
import { StatTile } from '../../../components/charts/StatTile.js';
import { SkeletonCardGrid } from '../../../components/primitives/Skeleton.js';
import { ApiError } from '../../../data/client.js';
import { useDocumentVisible, useSectionVisible } from '../shell/section-visibility.js';
import { describeRunsNow, runsNowTiles, type RunsNow } from './runs-now-model.js';
import { fetchRunsNow } from './runs-now-queries.js';
import styles from './command.module.css';

export function RunsNowRow({ now }: { now: number }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const missing = useRef(false);
  const [data, setData] = useState<RunsNow | null | undefined>(undefined);
  useEffect(() => {
    if (!sectionVisible) { missing.current = false; return; }
    if (!documentVisible || missing.current) return;
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (missing.current || pending) return;
      pending = true;
      try {
        const next = await fetchRunsNow(controller.signal);
        if (!controller.signal.aborted) setData(next);
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof ApiError && error.status === 404) { missing.current = true; clearInterval(timer); }
          if (error instanceof ApiError && (error.status === 404 || error.status === 503)) setData(null);
          else setData(previous => previous ?? null);
        }
      } finally { pending = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [sectionVisible, documentVisible]);
  if (data === undefined) return <SkeletonCardGrid count={4} />;
  if (data === null) return null;
  const tiles = runsNowTiles(data, now);
  return <div role="group" aria-label={describeRunsNow(tiles)} className={styles.kpis}>
    {tiles.map(tile => <div key={tile.id} style={tile.degraded ? { opacity: 0.65 } : undefined}>
      <StatTile label={tile.label} value={tile.value} caption={tile.caption} />
    </div>)}
  </div>;
}
