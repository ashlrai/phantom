import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import type { DockPaneId } from '../shell/dock-catalog.js';

export const STORAGE_KEY = 'phantom.fleet-workspace.auto';
export const FLEET_PANES = ['fleet-hub', 'fleet-lanes', 'fleet-merges', 'fleet-inbox'] as const satisfies readonly DockPaneId[];
const CHANGE_EVENT = 'phantom:fleet-workspace-auto';

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>;

export function readOptOut(storage: StorageReader): boolean {
  try { return storage.getItem(STORAGE_KEY) === 'off'; } catch { return false; }
}

export function writeOptOut(storage: StorageWriter, optOut: boolean): void {
  try {
    if (optOut) storage.setItem(STORAGE_KEY, 'off');
    else storage.removeItem(STORAGE_KEY);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch { /* Storage may be unavailable in a private or restricted window. */ }
}

export function subscribeOptOut(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

let ranThisSession = false;
export function hasAutoOpened(): boolean { return ranThisSession; }
export function markAutoOpened(): void { ranThisSession = true; }
export function resetAutoOpenForTests(): void { ranThisSession = false; }

export function fleetPanesPresent(registeredIds: readonly string[]): DockPaneId[] {
  return FLEET_PANES.filter(id => registeredIds.includes(id));
}

export function shouldAutoOpen({ runs, dockTabs, optOut, alreadyRanThisSession }: {
  runs: Pick<FleetRunsV1, 'workers' | 'leaders'> | null | undefined;
  dockTabs: readonly DockPaneId[];
  optOut: boolean;
  alreadyRanThisSession: boolean;
}): boolean {
  return !optOut && !alreadyRanThisSession && !!runs
    && Array.isArray(runs.workers) && Array.isArray(runs.leaders)
    && !FLEET_PANES.some(id => dockTabs.includes(id))
    && (runs.workers.length > 0 || runs.leaders.some(leader =>
      typeof leader.ageSeconds === 'number' && leader.ageSeconds < 1800));
}
