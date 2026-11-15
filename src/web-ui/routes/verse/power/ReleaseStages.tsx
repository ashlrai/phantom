import { useEffect, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { readReleaseStages, releaseStageRows, type ReleaseStagesView } from './release-stages-model.js';

export const RELEASE_STAGES_PATH = '/api/verse/release/stages';

type Load = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; view: ReleaseStagesView };

/** Fetches the newest release's stages; the server caches, so a refresh never spams GitHub. */
function useReleaseStages(refreshKey = 0): Load {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    apiGet<unknown>(RELEASE_STAGES_PATH, controller.signal).then(
      data => { const view = readReleaseStages(data); setLoad(view ? { phase: 'ready', view } : { phase: 'error' }); },
      () => { if (!controller.signal.aborted) setLoad({ phase: 'error' }); },
    );
    return () => { controller.abort(); };
  }, [refreshKey]);
  return load;
}

/** Read only: shows what the newest release has (published, update feed, installer assets). */
export function ReleaseStages({ installedVersion, refreshKey = 0, onView }: {
  installedVersion: string | null; refreshKey?: number; onView?: (view: ReleaseStagesView | null) => void;
}) {
  const load = useReleaseStages(refreshKey);
  const view = load.phase === 'ready' ? load.view : null;
  useEffect(() => { onView?.(view); }, [view, onView]);
  if (load.phase === 'loading') return <p>Checking the newest release…</p>;
  if (!view) return <p>The newest release could not be read.</p>;
  return <ul role="list" aria-label="Newest release">
    {releaseStageRows(view, installedVersion).map(row => <li key={row.label} data-state={row.state}>
      <strong>{row.label}</strong>: {row.text}
    </li>)}
  </ul>;
}
