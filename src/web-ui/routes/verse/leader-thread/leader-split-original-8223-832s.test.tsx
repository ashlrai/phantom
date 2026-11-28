import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceSplitter } from './SurfaceSplitter.js';

const keep = vi.fn();
function Harness({ width = 1280, initial = 44 }: { width?: number; initial?: number }) {
  const [split, setSplit] = useState(initial);
  return <><textarea aria-label="Draft" /><SurfaceSplitter split={split} paneWidth={() => width}
    onSplit={next => setSplit(next)} onKeep={next => keep(next)} /><output>{split}%</output></>;
}
function pointer(type: string, target: Element | Window, x = 700, id = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  act(() => { target.dispatchEvent(event); });
}
const line = () => screen.getByRole('separator', { name: 'Resize the session conversation' });
const value = (expected: number) => expect(line()).toHaveAttribute('aria-valuenow', String(expected));
afterEach(() => { cleanup(); vi.restoreAllMocks(); keep.mockClear(); delete document.body.dataset.verseResizing; });

describe('original #8223 standalone divider interactions', () => {
  it('is focusable and handles both arrows, Shift-arrows, Home/End, Enter and double-click', () => {
    render(<Harness />);
    line().focus();
    expect(line()).toHaveFocus();
    expect(line()).toHaveAttribute('aria-orientation', 'vertical');
    expect(line()).toHaveAttribute('aria-valuemin', '28');
    expect(line()).toHaveAttribute('aria-valuemax', '64');
    for (const [key, shiftKey, expected] of [
      ['ArrowLeft', false, 46], ['ArrowRight', false, 44], ['ArrowLeft', true, 52],
      ['ArrowRight', true, 44], ['Home', false, 28], ['ArrowRight', false, 28],
      ['End', false, 64], ['ArrowLeft', false, 64], ['Enter', false, 44],
    ] as const) {
      fireEvent.keyDown(line(), { key, shiftKey });
      value(expected);
      expect(keep).toHaveBeenLastCalledWith(expected);
    }
    expect(line()).toHaveAttribute('aria-valuetext', 'Session conversation takes 44 percent of the pane');
    fireEvent.keyDown(line(), { key: 'End' });
    fireEvent.doubleClick(line());
    value(44);
    keep.mockClear();
    for (const args of [{ key: 'a' }, { key: 'ArrowLeft', ctrlKey: true },
      { key: 'ArrowLeft', metaKey: true }, { key: 'ArrowLeft', altKey: true }]) fireEvent.keyDown(line(), args);
    expect(keep).not.toHaveBeenCalled();
  });

  it('reports reachable bounds at 900px, clamps reset, and sanitizes missing dimensions/values', () => {
    const view = render(<Harness width={900} />);
    expect(line()).toHaveAttribute('aria-valuemin', '38');
    expect(line()).toHaveAttribute('aria-valuemax', '53');
    fireEvent.keyDown(line(), { key: 'Home' }); value(38);
    fireEvent.keyDown(line(), { key: 'End' }); value(53);
    view.unmount();
    const small = render(<Harness width={700} />);
    fireEvent.doubleClick(line()); value(44);
    expect(line()).toHaveAttribute('aria-valuemin', '44');
    expect(line()).toHaveAttribute('aria-valuemax', '44');
    small.unmount();
    for (const width of [0, -1, Number.NaN, Infinity]) {
      const invalid = render(<Harness width={width} initial={Number.NaN} />);
      value(44);
      pointer('pointerdown', line());
      expect(document.body.dataset.verseResizing).toBeUndefined();
      fireEvent.keyDown(line(), { key: 'End' }); value(64);
      invalid.unmount();
    }
  });

  it('captures the pointer, follows only its moves, commits once on window release and preserves a sibling draft', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'Unsent fixture draft' } });
    box.focus();
    const target = line();
    const capture = vi.fn(), release = vi.fn();
    Object.assign(target, { setPointerCapture: capture, releasePointerCapture: release });
    pointer('pointerdown', target);
    expect(capture).toHaveBeenCalledWith(1);
    pointer('pointermove', window, 572, 2); value(44);
    pointer('pointerup', window, 572, 2);
    pointer('pointermove', window, 572); value(54);
    expect(document.body.dataset.verseResizing).toBe('true'); // Includes parent rerender/new callbacks.
    expect(keep).not.toHaveBeenCalled();
    pointer('pointerup', window, 572);
    expect(release).toHaveBeenCalledWith(1);
    expect(keep).toHaveBeenCalledExactlyOnceWith(54);
    expect(document.body.dataset.verseResizing).toBeUndefined();
    expect(target).not.toHaveAttribute('data-dragging');
    pointer('pointermove', window, 0); value(54);
    expect(screen.getByRole('textbox')).toBe(box);
    expect(box).toHaveValue('Unsent fixture draft');
    expect(box).toHaveFocus();
  });

  it('Escape rolls back and stops propagation before a containing conversation closes', () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><Harness /></div>);
    pointer('pointerdown', line());
    pointer('pointermove', window, 0); value(64);
    pointer('pointermove', window, 2000); value(28);
    fireEvent.keyDown(line(), { key: 'Escape' });
    value(44);
    expect(keep).toHaveBeenCalledExactlyOnceWith(44);
    expect(outer).not.toHaveBeenCalled();
    expect(document.body.dataset.verseResizing).toBeUndefined();
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'])('%s ends the drag and removes the body flag', type => {
    render(<Harness />);
    pointer('pointerdown', line());
    pointer('pointermove', window, 572);
    if (type === 'blur') act(() => { window.dispatchEvent(new Event('blur')); });
    else pointer(type, type === 'lostpointercapture' ? line() : window);
    expect(document.body.dataset.verseResizing).toBeUndefined();
    expect(line()).not.toHaveAttribute('data-dragging');
    expect(keep).toHaveBeenCalledExactlyOnceWith(54);
    pointer('pointermove', window, 0); value(54);
  });

  it('rejects secondary buttons, survives unavailable capture, and releases on unmount without keeping', () => {
    const view = render(<Harness />);
    pointer('pointerdown', line(), 700, 1, 2);
    expect(document.body.dataset.verseResizing).toBeUndefined();
    const release = vi.fn();
    Object.assign(line(), { setPointerCapture: () => { throw new Error('fixture capture unavailable'); }, releasePointerCapture: release });
    pointer('pointerdown', line());
    pointer('pointermove', window, 572); value(54);
    view.unmount();
    expect(release).toHaveBeenCalledWith(1);
    expect(document.body.dataset.verseResizing).toBeUndefined();
    pointer('pointermove', window, 0);
    pointer('pointerup', window);
    expect(keep).not.toHaveBeenCalled();
  });
});
