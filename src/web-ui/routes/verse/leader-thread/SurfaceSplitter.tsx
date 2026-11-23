/** Standalone recovery of #8223's divider; surface integration remains with #8444. */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import styles from './leader-roster.module.css';

const DEFAULT = 44, MIN = 28, MAX = 64;
// Kept here until the separately owned surface-layout changes land.
function bounds(width: number): [number, number] {
  if (!Number.isFinite(width) || width <= 0) return [MIN, MAX];
  const low = Math.max(MIN, Math.ceil(340 / width * 100));
  const high = Math.min(MAX, Math.floor((1 - 420 / width) * 100));
  return low > high ? [DEFAULT, DEFAULT] : [low, high];
}
function clamp(value: number, width: number): number {
  const [low, high] = bounds(width);
  return Math.min(high, Math.max(low, Math.round(Number.isFinite(value) ? value : DEFAULT)));
}
interface Props {
  /** Session conversation's share of the pane, in percent. */
  split: number;
  paneWidth: () => number;
  onSplit: (split: number) => void;
  /** Persistence is the caller's responsibility; no storage contract is imported. */
  onKeep: (split: number) => void;
}
interface Drag { pointerId: number; originX: number; start: number; width: number; target: HTMLDivElement }

export function SurfaceSplitter(props: Props) {
  const { split, paneWidth } = props;
  const current = useRef(props);
  current.current = props;
  const value = clamp(split, paneWidth());
  const latest = useRef(value);
  latest.current = value;
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const release = useCallback(() => {
    const state = drag.current;
    if (!state) return;
    drag.current = null; // Clear before releasing: lostcapture may fire synchronously.
    delete document.body.dataset.verseResizing;
    try { state.target.releasePointerCapture?.(state.pointerId); } catch { /* Already lost. */ }
  }, []);
  const finish = useCallback((rollback = false) => {
    const state = drag.current;
    if (!state) return;
    const next = rollback ? state.start : latest.current;
    release();
    setDragging(false);
    latest.current = next;
    if (rollback) current.current.onSplit(next);
    current.current.onKeep(next);
  }, [release]);

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId || !Number.isFinite(event.clientX)) return;
      latest.current = clamp(state.start - (event.clientX - state.originX) / state.width * 100, state.width);
      current.current.onSplit(latest.current);
    };
    const end = (event: globalThis.PointerEvent) => {
      if (event.pointerId === drag.current?.pointerId) finish();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (drag.current && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    };
    const blur = () => finish();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      release(); // Unmount cancels without writing storage or setting state.
    };
  }, [finish, release]);

  function down(event: PointerEvent<HTMLDivElement>) {
    const width = paneWidth();
    if (drag.current || event.button !== 0 || !Number.isFinite(width) || width <= 0 || !Number.isFinite(event.clientX)) return;
    event.preventDefault(); // A pointer resize leaves the composer's focus alone.
    drag.current = { pointerId: event.pointerId, originX: event.clientX, start: value, width, target: event.currentTarget };
    setDragging(true);
    document.body.dataset.verseResizing = 'true';
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Window listeners cover capture failure. */ }
  }
  function change(to: number) {
    const next = clamp(to, paneWidth());
    latest.current = next;
    current.current.onSplit(next);
    current.current.onKeep(next);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (drag.current || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? 8 : 2;
    const to = event.key === 'ArrowLeft' ? value + step : event.key === 'ArrowRight' ? value - step
      : event.key === 'Home' ? MIN : event.key === 'End' ? MAX : event.key === 'Enter' ? DEFAULT : null;
    if (to === null) return;
    event.preventDefault();
    change(to);
  }
  const [low, high] = bounds(paneWidth());
  return <div className={styles.splitter} role="separator" aria-orientation="vertical" tabIndex={0}
    aria-label="Resize the session conversation" aria-valuemin={low} aria-valuemax={high} aria-valuenow={value}
    aria-valuetext={`Session conversation takes ${value} percent of the pane`} data-dragging={dragging || undefined}
    title="Drag, or use ← and → (Enter or double-click for the default)"
    onPointerDown={down} onLostPointerCapture={event => { if (event.pointerId === drag.current?.pointerId) finish(); }}
    onKeyDown={keyDown} onDoubleClick={() => { finish(); change(DEFAULT); }} />;
}
