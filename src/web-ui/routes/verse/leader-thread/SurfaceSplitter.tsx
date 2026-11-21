/**
 * The divider between the Leader chat and the session conversation open
 * beside it. Drag it, or focus it and use the arrow keys, to give either side
 * more room. It follows the same rules as the shell's ChatResizer: it is a
 * focusable `separator` (arrows, Home/End, Enter or double-click for the
 * default), and a drag is ended from `window`, so a pointer released outside
 * the pane, a lost capture, Escape (which puts the divider back) or the window
 * losing focus can never leave a drag stuck.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { clampSplit, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, SPLIT_STEP, SPLIT_STEP_COARSE } from './surface-layout.js';
import styles from './leader-roster.module.css';

interface Drag { pointerId: number; originX: number; start: number; width: number }

/** The shell's own flag: its stylesheet stops text selection app-wide while it is set. */
function markBody(on: boolean): void {
  try {
    if (on) document.body.dataset.verseResizing = 'true';
    else delete document.body.dataset.verseResizing;
  } catch { /* A detached document in a test teardown. */ }
}

export function SurfaceSplitter({ split, paneWidth, onSplit, onKeep }: {
  /** The share of the pane the session's conversation takes, in percent. */
  split: number;
  /** The pane's width right now, in pixels; 0 when it is not laid out. */
  paneWidth: () => number;
  /** Called with every new share while moving. */
  onSplit: (split: number) => void;
  /** Called once a move is finished, with the share to remember. */
  onKeep: (split: number) => void;
}) {
  const drag = useRef<Drag | null>(null);
  const latest = useRef(split);
  latest.current = split;
  const [dragging, setDragging] = useState(false);

  /** The one way a drag ends; `to` is where the divider is left. */
  const endDrag = useCallback((to?: number) => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    markBody(false);
    if (to !== undefined) onSplit(to);
    onKeep(to ?? latest.current);
  }, [onKeep, onSplit]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    const width = paneWidth();
    if (event.button !== 0 || width <= 0) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, originX: event.clientX, start: split, width };
    setDragging(true);
    markBody(true);
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* The window listeners below cover it. */ }
  }

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: globalThis.PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      // The conversation is on the right: dragging left gives it more of the pane.
      onSplit(clampSplit(state.start - ((event.clientX - state.originX) / state.width) * 100, state.width));
    };
    const onEnd = (event: globalThis.PointerEvent) => {
      if (drag.current && event.pointerId !== drag.current.pointerId) return;
      endDrag();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (drag.current && event.key === 'Escape') { event.stopPropagation(); endDrag(drag.current.start); }
    };
    const onBlur = () => endDrag();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      markBody(false);
    };
  }, [dragging, endDrag, onSplit]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? SPLIT_STEP_COARSE : SPLIT_STEP;
    const width = paneWidth();
    const to = event.key === 'ArrowLeft' ? split + step : event.key === 'ArrowRight' ? split - step
      : event.key === 'Home' ? SPLIT_MIN : event.key === 'End' ? SPLIT_MAX : event.key === 'Enter' ? SPLIT_DEFAULT : null;
    if (to === null) return;
    event.preventDefault();
    const next = clampSplit(to, width);
    onSplit(next);
    onKeep(next);
  }

  return <div className={styles.splitter} role="separator" aria-orientation="vertical" tabIndex={0} data-dragging={dragging || undefined}
    aria-label="Resize the session conversation" aria-valuemin={SPLIT_MIN} aria-valuemax={SPLIT_MAX} aria-valuenow={split}
    aria-valuetext={`Session conversation takes ${split} percent of the pane`}
    title="Drag, or use ← and → (Enter or double-click for the default)"
    onPointerDown={onPointerDown} onPointerUp={() => endDrag()} onPointerCancel={() => endDrag()} onLostPointerCapture={() => endDrag()}
    onKeyDown={onKeyDown} onDoubleClick={() => { onSplit(SPLIT_DEFAULT); onKeep(SPLIT_DEFAULT); }} />;
}
