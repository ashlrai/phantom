/**
 * routes/verse/ops/OpsLaneConsole.tsx : the per-lane projection the dispatch
 * queue dir already computes (GET /api/fleet/lanes → fleet.lanes.v1) —
 * credit left, queue depth, live jobs and merges/hour per router lane.
 * Mounted as the first block of Ops ▸ "Fleet & router". Every cell may be
 * null: "—" / "no reading", never an invented zero. Read-only.
 */
import { useRefetch, useQuery } from '../../../data/hooks.js';
import { fleetLanesQuery } from '../../../data/queries.js';
import { readFailureReason } from '../../../data/client.js';
import { Button } from '../../../components/primitives/Button.js';
import { SkeletonRow } from '../../../components/primitives/Skeleton.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import type { FleetLaneView } from '../../../data/api-types.js';
import { creditBarLabel, creditLine, creditTone, laneChipText, sourceNotes, updatedText } from './ops-lane-model.js';
import styles from './ops.module.css';
import meter from './ops-lane-console.module.css';

function LaneRow({ lane }: { lane: FleetLaneView }) {
  const barLabel = creditBarLabel(lane);
  return (
    <div className={styles.row}>
      <p className={styles.rowTitle}>
        <strong>{lane.lane}</strong>
        {laneChipText(lane).map((chip) => (
          <span key={chip.text} className={styles.chip} data-tone={chip.tone}>{chip.text}</span>
        ))}
      </p>
      <p className={styles.rowMeta}>{creditLine(lane)}</p>
      {barLabel !== null ? (
        <span className={meter.track} role="img" aria-label={barLabel} data-tone={creditTone(lane.credit.remainingPct)}>
          <span className={meter.fill} style={{ width: `${Math.min(100, Math.max(0, lane.credit.remainingPct ?? 0))}%` }} />
        </span>
      ) : null}
    </div>
  );
}

export function OpsLaneConsole() {
  const read = useQuery(fleetLanesQuery);
  const refetch = useRefetch(fleetLanesQuery);
  usePollWhileVisible(refetch, 15_000);
  const snapshot = read.data;
  const updated = snapshot ? updatedText(snapshot.generatedAt) : null;
  const notes = snapshot ? sourceNotes(snapshot) : [];

  return (
    <section className={styles.panel} aria-labelledby="ops-lanes-title">
      <div className={styles.header}>
        <div>
          <h2 id="ops-lanes-title">Lanes on this Mac</h2>
          <p>Credit left, queue depth, live jobs and merges/hour per router lane, read from the dispatch queue dir.</p>
          {updated ? <p>{updated}</p> : null}
        </div>
        <div className={styles.actions}>
          <Button size="sm" variant="ghost" onClick={refetch}>Refresh</Button>
        </div>
      </div>
      {read.status === 'error' ? (
        <p role="alert">
          {readFailureReason(read.error)}{' '}
          <Button size="sm" variant="ghost" onClick={refetch}>Retry</Button>
        </p>
      ) : !snapshot ? (
        <div role="status" aria-label="Reading lane state">
          {[0, 1, 2].map((i) => <SkeletonRow key={i} />)}
        </div>
      ) : (
        <>
          {snapshot.lanes.length === 0
            ? <p className={styles.empty}>No lanes reported by the queue dir</p>
            : <div className={styles.list}>{snapshot.lanes.map((lane) => <LaneRow key={lane.lane} lane={lane} />)}</div>}
          {notes.length > 0 ? <p className={styles.note}>{notes.join(' · ')}</p> : null}
        </>
      )}
    </section>
  );
}
