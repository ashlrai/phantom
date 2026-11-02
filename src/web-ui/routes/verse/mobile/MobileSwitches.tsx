/**
 * routes/verse/mobile/MobileSwitches.tsx — the "Switches on the Mac" card on
 * the Fleet screen: the runs-directory switch files (HOLD, PAUSE, ORCH_OFF,
 * OPUS_LEADER_OFF, PUBLISH_HOLD, queue/DISABLE) the Mac observes, and — when
 * this build has the control route — the way to flip them.
 *
 * Reads, both the workbench's own cache keys:
 *   snapshot   verse-fleet-runs                    GET /api/verse/fleet/runs
 *   control    verse-fleet-control-switches        GET /api/verse/fleet/control/switches
 * Polled every 15 s while visible; once the control route has answered 404
 * (not in this build) only the snapshot keeps polling.
 *
 * Writes go through the one guarded path (mobile-actions.ts → guard-store):
 * the switch's own confirmation wording, the mutation token if the hold has
 * lapsed, then POST { id, on } — the phone never holds more authority than
 * that gate grants. Nothing is optimistic: a failure keeps the shown state,
 * toasts the server's reason, and the state only changes when the refetch
 * says so.
 */
import { useCallback } from 'react';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { describeActionError } from '../shell/guard-store.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { canShowActions, useMobile } from './mobile-context.js';
import { runMobileAction } from './mobile-actions.js';
import { showMobileToast } from './mobile-toast.js';
import { confirmText, readSwitches, type SwitchRow } from './mobile-switches-model.js';
import { fleetControlSwitchesQuery, fleetRunsSnapshotQuery } from './mobile-switches-queries.js';
import { SkeletonList } from './ui.js';
import { Badge, Section, ui } from './ui-parts.js';

const POLL_MS = 15_000;
const READ_ONLY_NOTE = 'Switches can be changed from the Mac in this build.';

function StateBadge({ on, tone }: { on: boolean | null; tone: SwitchRow['tone'] }) {
  if (on === null) return <Badge>—</Badge>;
  return <Badge tone={on ? tone : 'neutral'}>{on ? 'On' : 'Off'}</Badge>;
}

function SwitchLine({ row }: { row: SwitchRow }) {
  return (
    <>
      <span className={ui.rowBody}>
        <span className={ui.rowTitle}>{row.label}</span>
        <span className={ui.rowSub}>{row.meaning}</span>
      </span>
      <span className={ui.rowTrail}><StateBadge on={row.on} tone={row.tone} /></span>
    </>
  );
}

export function MobileSwitches() {
  const { permissions, reachability } = useMobile();
  const runs = useQuery(fleetRunsSnapshotQuery);
  const control = useQuery(fleetControlSwitchesQuery);
  const refetchRuns = useRefetch(fleetRunsSnapshotQuery);
  const refetchControl = useRefetch(fleetControlSwitchesQuery);
  const refreshRuns = useRefresh(fleetRunsSnapshotQuery);
  const refreshControl = useRefresh(fleetControlSwitchesQuery);
  const controlMissing = control.error instanceof ApiError && control.error.status === 404;
  const poll = useCallback(() => {
    refetchRuns();
    if (!controlMissing) refetchControl();
  }, [refetchRuns, refetchControl, controlMissing]);
  usePollWhileVisible(poll, POLL_MS);

  const view = readSwitches(runs.data ?? null, control.data ?? null);
  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  const controlPending = !control.data && (control.status === 'idle' || control.status === 'loading');
  const nothingYet = !runs.data && !control.data;
  const loading = nothingYet && (runs.status === 'idle' || runs.status === 'loading' || controlPending);

  const flip = (row: SwitchRow) => {
    if (row.on === null) return;
    const next = !row.on;
    const text = confirmText(row.id, next);
    runMobileAction({
      title: text.title,
      consequences: text.body,
      confirmLabel: text.confirmLabel,
      run: async () => {
        try {
          const { postRunsSwitch } = await import('../fleet/runs-switches-queries.js');
          await postRunsSwitch(row.id, next);
        } catch (error) {
          showMobileToast(describeActionError(error), 'danger');
          throw error;
        }
      },
      success: text.done,
      onDone: () => {
        refreshRuns();
        refreshControl();
      },
    });
  };

  const notes: string[] = [];
  if (!view.writable && !controlPending) {
    notes.push(control.error && !controlMissing
      ? `Switches can’t be changed right now — ${readFailureReason(control.error)}`
      : READ_ONLY_NOTE);
  }
  if (!canAct && permissions.actReason) notes.push(permissions.actReason);
  if (view.sourceState === 'degraded') notes.push('The switch source is degraded — states may be incomplete.');

  let body;
  if (loading) {
    body = <SkeletonList rows={3} label="Loading the Mac’s switches" />;
  } else {
    body = (
      <div className={ui.group} role="group" aria-label="Switches on the Mac">
        {view.rows.map((row) => {
          if (!view.writable || !canAct || row.on === null) {
            return <div key={row.id} className={ui.row}><SwitchLine row={row} /></div>;
          }
          return (
            <button
              key={row.id}
              type="button"
              role="switch"
              aria-checked={row.on}
              aria-label={row.label}
              className={ui.row}
              disabled={offline}
              onClick={() => flip(row)}
            >
              <SwitchLine row={row} />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <Section title="Switches on the Mac" flat footer={notes.length > 0 ? notes.join(' ') : undefined}>
      {body}
    </Section>
  );
}
