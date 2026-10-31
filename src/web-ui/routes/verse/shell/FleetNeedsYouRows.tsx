/**
 * routes/verse/shell/FleetNeedsYouRows.tsx — "Fleet on this Mac", the
 * Needs-you drawer's local group (unit C1): one row per thing only Mason
 * can fix on the fleet running here, derived in the browser by
 * fleet-needs-you.ts from GET /api/verse/fleet/runs.
 *
 * The rows are NOT NeedsYouItems — C0's kind union cannot carry them, so
 * they sit ABOVE the split's listbox instead of pretending to be options:
 * J / K triage and the batch picks stay with the server items untouched,
 * and each row carries its own Open button to the surface that can act
 * (Fleet ▸ Switches, Ops ▸ Live runs, Settings ▸ Connection). The whole
 * row clicks the same way, so the pointer cursor .row already pays for is
 * honest.
 *
 * Polls every 15 s — only while mounted (the drawer is open) and the
 * window is in view (usePollWhileVisible). A 404 means this build has no
 * live runs: nothing renders, and it reports answered:true with no items,
 * so "All clear" is decided by the server producers exactly as before. Any
 * other missing reading is reported as NOT answered — silence never earns
 * an all-clear.
 */
import { useEffect, useMemo } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { closeVerseOverlay, setVerseSection, type NeedsYouSplit } from '../verse-ui-store.js';
import {
  deriveFleetNeedsYou,
  FLEET_NEEDS_YOU_POLL_MS,
  type FleetNeedsYouItem,
  type FleetNeedsYouResult,
} from './fleet-needs-you.js';
import { fleetRunsNeedsYouQuery } from './fleet-needs-you-query.js';
import { usePollWhileVisible } from './section-visibility.js';
import styles from './NeedsYouDrawer.module.css';

/**
 * What the drawer needs back: the derived result plus — when the snapshot
 * did not answer — how to read the silence for the split's coverage line
 * (a failed read "failed to answer"; anything else "isn't reporting").
 */
export interface FleetNeedsYouReport extends FleetNeedsYouResult {
  silent: 'unavailable' | 'error' | null;
}

const SEVERITY: Readonly<Record<FleetNeedsYouItem['severity'], { tone: 'high' | 'warn'; word: string }>> = {
  urgent: { tone: 'high', word: 'Urgent' },
  attention: { tone: 'warn', word: 'Attention' },
};

const SURFACE_NAME: Readonly<Record<FleetNeedsYouItem['target'], string>> = {
  fleet: 'Fleet',
  ops: 'Ops',
  settings: 'Settings',
};

const ANSWERED_NONE: FleetNeedsYouResult = { answered: true, items: [] };

/** The item's target is a section — the drawer's own hand-off: close, then switch. */
function openSurface(target: FleetNeedsYouItem['target']): void {
  closeVerseOverlay();
  setVerseSection(target);
}

export function FleetNeedsYouRows({ split, nowMs, onResult }: {
  /** The drawer's current split; the group renders only on All and Fleet. */
  split: NeedsYouSplit;
  /** The drawer's ticking clock, so the stall rule ages while it is open. */
  nowMs: number;
  onResult: (report: FleetNeedsYouReport) => void;
}) {
  const read = useQuery(fleetRunsNeedsYouQuery);
  const refetch = useRefetch(fleetRunsNeedsYouQuery);
  const notFound = read.error instanceof ApiError && read.error.status === 404;
  usePollWhileVisible(refetch, FLEET_NEEDS_YOU_POLL_MS, { enabled: !notFound });

  // A refresh that failed keeps its last data — that reading still stands
  // (Ops shows it the same way); only a read with NOTHING to show is silent.
  const result = useMemo(
    () => (notFound ? ANSWERED_NONE : deriveFleetNeedsYou(read.data, nowMs)),
    [notFound, read.data, nowMs],
  );
  const silent: FleetNeedsYouReport['silent'] = result.answered ? null : read.error ? 'error' : 'unavailable';
  useEffect(() => {
    onResult({ ...result, silent });
  }, [onResult, result, silent]);

  if ((split !== 'all' && split !== 'fleet') || result.items.length === 0) return null;

  return (
    <section aria-label="Fleet on this Mac">
      <div className={styles.batch}>
        <p className={styles.rowKind}>Fleet on this Mac</p>
      </div>
      {result.items.map((item) => {
        const severity = SEVERITY[item.severity];
        const open = () => openSurface(item.target);
        return (
          <div key={item.id} className={styles.row} data-severity={severity.tone} onClick={open}>
            <span className={styles.rule} aria-hidden="true" />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{item.title}</span>
              <span className={styles.runFacts}>{item.detail}</span>
              <span className={styles.runFacts}>Next: {item.nextStep}</span>
              <span className={styles.rowMeta}>
                <span className={styles.severity} data-severity={severity.tone}>{severity.word}</span>
                <span>{SURFACE_NAME[item.target]}</span>
              </span>
            </span>
            <Button size="sm" variant="subtle" aria-label={`Open ${SURFACE_NAME[item.target]}`} onClick={(event) => { event.stopPropagation(); open(); }}>
              Open
            </Button>
          </div>
        );
      })}
    </section>
  );
}
