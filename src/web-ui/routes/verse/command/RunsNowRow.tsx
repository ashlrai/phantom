import { useEffect, useRef, useState } from 'react';
import { StatTile } from '../../../components/charts/StatTile.js';
import { SkeletonCardGrid } from '../../../components/primitives/Skeleton.js';
import { ApiError } from '../../../data/client.js';
import { evict, getQuerySnapshot } from '../../../data/cache.js';
import { DEFAULT_QUERY_FRESH_MS } from '../../../data/hooks.js';
import { useDocumentVisible, useSectionVisible } from '../shell/section-visibility.js';
import { describeRunsNow, runsNowTiles, type RunsNow } from './runs-now-model.js';
import { fetchRunsNow, runsNowQuery } from './runs-now-queries.js';
import styles from './command.module.css';

export function RunsNowRow({ now }: { now: number }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const missing = useRef(false);
  const [data, setData] = useState<RunsNow | null | undefined>(() => {
    const cached = getQuerySnapshot<RunsNow | null>(runsNowQuery.key);
    return cached.updatedAt !== null && Date.now() - cached.updatedAt < DEFAULT_QUERY_FRESH_MS ? cached.data : undefined;
  });
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
      } finally {
        // A direct poll supersedes any earlier warm-up snapshot.
        if (!controller.signal.aborted) evict(runsNowQuery.key);
        pending = false;
      }
    };
    const cached = getQuerySnapshot<RunsNow | null>(runsNowQuery.key);
    if (cached.data !== undefined && cached.updatedAt !== null && Date.now() - cached.updatedAt < DEFAULT_QUERY_FRESH_MS) {
      setData(cached.data);
    } else {
      void read();
    }
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
