import { useEffect, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { readReleaseStages, releaseNotesUrl, releaseStageRows, type ReleaseStagesView } from './release-stages-model.js';

export const RELEASE_STAGES_PATH = '/api/verse/release/stages';
const RELEASE_STAGES_POLL_MS = 15_000;
const RELEASE_STAGES_READ_TIMEOUT_MS = 25_000;

type Load = { phase: 'loading' } | { phase: 'error' } | { phase: 'ready'; view: ReleaseStagesView };

/** Fetches the newest release's stages; the server caches, so a refresh never spams GitHub. */
function useReleaseStages(refreshKey = 0): Load {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RELEASE_STAGES_READ_TIMEOUT_MS)]);
        const view = readReleaseStages(await apiGet<unknown>(RELEASE_STAGES_PATH, signal));
        if (!controller.signal.aborted) setLoad(view ? { phase: 'ready', view } : { phase: 'error' });
      } catch {
        if (!controller.signal.aborted) setLoad({ phase: 'error' });
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => { void read(); }, RELEASE_STAGES_POLL_MS);
    return () => { clearInterval(timer); controller.abort(); };
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
  const notes = releaseNotesUrl(view.tag);
  return <>
    <ul role="list" aria-label="Newest release">
      {releaseStageRows(view, installedVersion).map(row => <li key={row.label} data-state={row.state}>
        <strong>{row.label}</strong>: {row.text}
      </li>)}
    </ul>
    {notes && <p><a href={notes} target="_blank" rel="noopener noreferrer">What shipped in {view.tag} ↗</a></p>}
  </>;
}
