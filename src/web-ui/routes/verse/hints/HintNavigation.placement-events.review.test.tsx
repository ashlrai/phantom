import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HintNavigation from './HintNavigation.js';
import { setHintSettings } from './hint-settings.js';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
let unplaceable = false;
const observers: ReviewResizeObserver[] = [];
class ReviewResizeObserver {
  callback: ResizeObserverCallback;
  observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
  constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this); }
}
function key(key: string, options: KeyboardEventInit = {}, type = 'keydown') {
  const event = new KeyboardEvent(type, { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...options });
  act(() => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return event;
}
const enter = () => key('h', { code: 'KeyH', ctrlKey: true, shiftKey: true });
function Fixture({ id = 'fixture.b.old', activate }: { id?: string; activate: () => void }) {
  return <><textarea aria-label="Synthetic review draft" defaultValue="Invented draft remains intact." data-phantom-hint="fixture.a.editor" data-phantom-hint-action="focus" />
    <button type="button" data-phantom-hint={id} data-phantom-hint-action="press" onClick={activate}>Harmless review target</button><HintNavigation /></>;
}

beforeEach(() => {
  unplaceable = false; observers.length = 0; localStorage.clear();
  setHintSettings({ enabled: true, chord: 'ctrl-shift-h' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.stubGlobal('ResizeObserver', ReviewResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-hint-label')) return rect(20, 20, unplaceable ? window.innerWidth + 1 : 26, 20);
    if (this.getAttribute('role') === 'status') return rect(400, 600, 200, 30);
    return rect(20, 20, 80, 30);
  });
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('independent placement event cleanup review', () => {
  it('restores the original draft and permits normal typing after actual measured placement cannot fit', async () => {
    const activate = vi.fn(); render(<Fixture activate={activate} />);
    const draft = screen.getByRole('textbox') as HTMLTextAreaElement; draft.focus(); draft.setSelectionRange(draft.value.length, draft.value.length); unplaceable = true;
    expect(enter().defaultPrevented).toBe(true);
    expect(screen.queryByRole('group', { name: 'Phantom keyboard hints' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Controls are too crowded to label clearly.');
    expect(draft).toHaveFocus();
    expect(draft.value).toBe('Invented draft remains intact.');
    key('h', { code: 'KeyH' }, 'keyup');
    await userEvent.setup().keyboard(' ordinary f');
    expect(draft.value).toBe('Invented draft remains intact. ordinary f');
    expect(activate).not.toHaveBeenCalled();
  });
  it('ignores a queued old observer callback after a different session starts', () => {
    const activate = vi.fn(); const view = render(<Fixture activate={activate} />);
    const draft = screen.getByRole('textbox') as HTMLTextAreaElement; draft.focus(); enter();
    const oldObserver = observers[0]; expect(oldObserver).toBeDefined();
    key('h', { code: 'KeyH' }, 'keyup'); key('Escape', { code: 'Escape' }); key('Escape', { code: 'Escape' }, 'keyup');
    expect(oldObserver.disconnect).toHaveBeenCalled();
    view.rerender(<Fixture id="fixture.b.new" activate={activate} />); draft.focus(); enter();
    const owner = screen.getByRole('group', { name: 'Phantom keyboard hints' });
    act(() => { oldObserver.callback([], oldObserver as unknown as ResizeObserver); });
    expect(screen.getByRole('group', { name: 'Phantom keyboard hints' })).toBe(owner);
    expect(owner).toHaveFocus(); expect(draft.value).toBe('Invented draft remains intact.');
    key('h', { code: 'KeyH' }, 'keyup'); key('s');
    expect(activate).toHaveBeenCalledTimes(1);
  });
});
