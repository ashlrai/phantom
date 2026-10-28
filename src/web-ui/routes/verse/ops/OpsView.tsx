/**
 * routes/verse/ops/OpsView.tsx : the Ops tray section body: the desktop
 * command center's four views behind one segmented switch.
 *
 *   Board       every task with its assignee, estimate and outcome
 *   Fleet       lanes, router holds and decisions, A/B calibration results
 *   Releases    read-only release status per enrolled repo
 *   Leaders     the leaders' channel on the shared team bus
 *
 * Each view reads a /api/verse/ops projection of the buses the CLI and
 * Telegram already share; the view adds no state of its own beyond which
 * pane is on screen.
 */
import { useState } from 'react';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { OpsBoard } from './OpsBoard.js';
import { OpsFleet } from './OpsFleet.js';
import { OpsLeaders } from './OpsLeaders.js';
import { OpsReleases } from './OpsReleases.js';
import styles from './ops.module.css';

type OpsView = 'board' | 'fleet' | 'releases' | 'leaders';

const VIEWS: ReadonlyArray<{ value: OpsView; label: string }> = [
  { value: 'board', label: 'Board' },
  { value: 'fleet', label: 'Fleet & router' },
  { value: 'releases', label: 'Releases' },
  { value: 'leaders', label: 'Leaders' },
];

export function OpsView() {
  const [view, setView] = useState<OpsView>('board');
  return (
    <div className={styles.section}>
      <Segmented<OpsView>
        options={VIEWS}
        value={view}
        onChange={setView}
        aria-label="Ops view"
      />
      {view === 'board' ? <OpsBoard />
        : view === 'fleet' ? <OpsFleet />
        : view === 'releases' ? <OpsReleases />
        : <OpsLeaders />}
    </div>
  );
}
