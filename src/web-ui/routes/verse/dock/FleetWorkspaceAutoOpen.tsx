import { useEffect } from 'react';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { listPanes } from '../panes/index.js';
import { useDocumentVisible } from '../shell/section-visibility.js';
import { getDockState, hydrateDockState, openFleetWorkspace } from './dock-store.js';
import { fleetPanesPresent, hasAutoOpened, markAutoOpened, readOptOut, shouldAutoOpen, writeOptOut } from './fleet-workspace-auto.js';

const fleetRunsQuery: QueryDef<FleetRunsV1> = {
  key: 'verse-fleet-runs',
  fetch: signal => apiGet('/api/verse/fleet/runs', signal),
};

export function FleetWorkspaceAutoOpen() {
  const visible = useDocumentVisible();
  const runs = useQuery(fleetRunsQuery, { freshMs: 10_000, enabled: visible });
  const toast = useToast();

  useEffect(() => {
    if (!visible || !runs.data || !Array.isArray(runs.data.workers) || !Array.isArray(runs.data.leaders)) return;
    const snapshot = getDockState();
    if (query.error || !shouldAutoOpen({ runs: runs.data, dockTabs: snapshot.tabs, optOut: readOptOut(localStorage), alreadyRanThisSession: hasAutoOpened() })) return;
    const present = fleetPanesPresent(listPanes().map(pane => pane.id));
    if (present.length === 0) return;
    markAutoOpened();
    openFleetWorkspace(present);
    toast.show('Fleet is running on this Mac. Opened the fleet workspace.', 'neutral', [
      { label: 'Undo', onClick: () => hydrateDockState(snapshot) },
      { label: "Don't do this again", onClick: () => writeOptOut(localStorage, true) },
    ]);
  }, [runs.data, toast, visible]);
  return null;
}
