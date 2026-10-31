import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openDockPane, openFleetWorkspace } from '../dock/dock-store.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { usePanes, type PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { curatedWorkspace, hubTiles, snapshotAge } from './fleet-hub-model.js';
import styles from './fleet-hub.module.css';

export function FleetHubPane({ visible }: Pick<PaneProps, 'visible'>) {
  const panes = usePanes();
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(opsRunsQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible, refreshOnShow: false });
  const tiles = hubTiles(read.data ?? null, panes);
  const presentIds = tiles.filter((tile) => tile.present).map((tile) => tile.id);
  const workspaceIds = curatedWorkspace(presentIds);

  return <section className={styles.pane} aria-label="Fleet">
    <button type="button" className={styles.primary} disabled={workspaceIds.length === 0} onClick={() => openFleetWorkspace(workspaceIds)}>Open fleet workspace</button>
    <button type="button" className={styles.secondary} disabled={presentIds.length === 0} onClick={() => openFleetWorkspace(presentIds)}>Open all fleet panes</button>
    {read.status === 'error' ? <p role="status">Fleet counts are unavailable. Showing the last reading.</p> : null}
    <p role="status" className={styles.count}>{snapshotAge(read.data?.generatedAt ?? null, Date.now())}</p>
    <div className={styles.tiles}>
      {tiles.map((tile) => <button type="button" key={tile.id} className={styles.tile} disabled={!tile.present} onClick={() => openDockPane(tile.id)}>
        <strong>{tile.title}</strong>
        <span className={styles.count}>{tile.count}</span>
        {!tile.present ? <span>not in this build</span> : null}
      </button>)}
    </div>
  </section>;
}
