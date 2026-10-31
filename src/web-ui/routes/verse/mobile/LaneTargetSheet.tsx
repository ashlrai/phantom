import { useId, useState } from 'react';
import { postLaneTarget } from '../ops/lane-targets-queries.js';
import { describeActionError, useGuardState } from '../shell/guard-store.js';
import { pauseTransition, resumeTransition } from '../fleet-lanes/lane-pause-model.js';
import { clampTarget, confirmText, pauseState, readPauseRecord, writePauseRecord, type MobileLaneRow } from './lane-target-model.js';
import { runMobileAction } from './mobile-actions.js';
import { canShowActions, useMobile } from './mobile-context.js';
import { showMobileToast } from './mobile-toast.js';
import { BottomSheet } from './sheet.js';
import { Button } from './ui.js';
import { ui } from './ui-parts.js';

export interface LaneTargetSheetProps {
  row: MobileLaneRow;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function LaneTargetSheet({ row, open, onClose, onDone }: LaneTargetSheetProps) {
  const [draft, setDraft] = useState(String(row.target ?? row.floor));
  const [busy, setBusy] = useState(false);
  const id = useId();
  const guard = useGuardState();
  const { permissions, reachability } = useMobile();
  const target = clampTarget(Number(draft), row.floor, row.ceiling);
  const pause = pauseState(row, readPauseRecord());
  const disabled = !row.writable || !canShowActions(permissions) || busy
    || reachability === 'offline' || reachability === 'unreachable';
  const submit = () => {
    if (disabled || target === row.target) return;
    const text = confirmText(row.lane, row.target ?? row.floor, target);
    runMobileAction({
      title: text.title, consequences: text.body, confirmLabel: text.confirmLabel,
      run: async () => {
        setBusy(true);
        try { await postLaneTarget(row.lane, target); }
        catch (error) {
          showMobileToast(describeActionError(error), 'danger');
          throw error;
        } finally { setBusy(false); }
      },
      success: text.done,
      onDone: () => { onDone(); onClose(); },
    });
  };
  const togglePause = () => {
    if (disabled) return;
    const transition = pause.paused
      ? resumeTransition(row.lane, readPauseRecord(), row.floor)
      : pauseTransition(row.lane, row.target ?? 0, readPauseRecord());
    runMobileAction({
      title: `${pause.paused ? 'Resume' : 'Pause'} ${row.lane}?`,
      consequences: pause.paused
        ? `Restore the ${row.lane} target to ${transition.target}. Your Mac will launch workers to match.`
        : `Running workers finish; nothing new starts on it. Target goes to 0; the old target ${row.target} is remembered.`,
      confirmLabel: pause.paused ? 'Resume lane' : 'Pause lane',
      run: async () => {
        setBusy(true);
        try {
          await postLaneTarget(row.lane, transition.target);
          writePauseRecord(transition.record);
        } catch (error) {
          showMobileToast(describeActionError(error), 'danger');
          throw error;
        } finally { setBusy(false); }
      },
      success: `${row.lane} target is now ${transition.target}.`,
      onDone: () => { onDone(); onClose(); },
    });
  };
  return (
    <BottomSheet open={open && !guard.request} onClose={onClose} title={`${row.lane} lane target`} busy={busy}
      footer={<Button variant="primary" disabled={disabled || target === row.target} onClick={submit}>Set target</Button>}>
      {pause.label ? <p>{pause.label}</p> : null}
      <p>Running {row.running ?? '—'} · Target {row.target ?? '—'} · Queued {row.queued ?? '—'}</p>
      <label className={ui.label} htmlFor={id}>Worker target</label>
      <div className={ui.buttonRow}>
        <Button aria-label="Decrease target" disabled={disabled || target <= row.floor} onClick={() => setDraft(String(target - 1))}>−</Button>
        <input id={id} className={ui.input} type="number" min={row.floor} max={row.ceiling} step={1}
          value={draft} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onBlur={() => setDraft(String(target))} />
        <Button aria-label="Increase target" disabled={disabled || target >= row.ceiling} onClick={() => setDraft(String(target + 1))}>+</Button>
      </div>
      {pause.paused || (row.target ?? 0) > 0 ? <Button disabled={disabled} onClick={togglePause}>
        {pause.paused ? `Resume lane · back to ${pause.resumeTarget}` : 'Pause lane'}
      </Button> : null}
      <p>Floor {row.floor} · Ceiling {row.ceiling}</p>
      {row.held ? <p>Held: {row.heldReason || 'reason unavailable'}. Targets can't change until it clears.</p>
        : !row.writable ? <p>Lane targets are not in this build. Update Phantom on your Mac.</p> : null}
    </BottomSheet>
  );
}
