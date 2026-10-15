import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HintNavigation from './HintNavigation.js';
import { discoverHintTargets } from './hint-model.js';
import { setHintSettings } from './hint-settings.js';

const rectangle = (left = 20, top = 20, width = 80, height = 30) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
const originalRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');

function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...options });
  act(() => { (document.activeElement ?? document.body).dispatchEvent(event); });
  return event;
}
function enter() { return press('h', { code: 'KeyH', ctrlKey: true, shiftKey: true }); }
function fixture() {
  const activate = vi.fn();
  const view = render(<><textarea aria-label="Fixture draft" defaultValue="retain draft" />
    <button type="button" data-phantom-hint="fixture.navigation" data-phantom-hint-action="press" onClick={activate}>Harmless navigation</button>
    <HintNavigation /></>);
  return { ...view, activate, button: screen.getByRole('button'), draft: screen.getByRole('textbox') as HTMLTextAreaElement };
}

beforeEach(() => {
  localStorage.clear(); setHintSettings({ enabled: true, chord: 'ctrl-shift-h' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rectangle());
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
});
afterEach(() => {
  cleanup(); document.body.replaceChildren(); vi.restoreAllMocks();
  if (originalRatio) Object.defineProperty(window, 'devicePixelRatio', originalRatio); else Reflect.deleteProperty(window, 'devicePixelRatio');
  if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport); else Reflect.deleteProperty(window, 'visualViewport');
  localStorage.clear();
});

describe('independent offline hint reliability review', () => {
  it('stands down for an open native dialog without explicit ARIA attributes', () => {
    const { activate } = fixture();
    const dialog = document.createElement('dialog'); dialog.open = true; dialog.append(document.createElement('input')); document.body.append(dialog);
    expect(enter().defaultPrevented).toBe(false);
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    expect(activate).not.toHaveBeenCalled();
  });
  it('yields to a newly opened modal without refocusing its background draft', async () => {
    const { draft, activate } = fixture(); draft.focus(); enter();
    const focus = vi.spyOn(draft, 'focus');
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.append(document.createElement('input'));
    await act(async () => { document.body.append(dialog); });
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    expect(focus).not.toHaveBeenCalled(); expect(draft).not.toHaveFocus(); expect(activate).not.toHaveBeenCalled();
  });
  it('cancels when display scale changes even if every target rectangle stays unchanged', () => {
    const { activate } = fixture(); enter();
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    expect(press('a').defaultPrevented).toBe(true);
    expect(activate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });
  it('cancels on a visual viewport resize without a layout-window resize', () => {
    const viewport = Object.assign(new EventTarget(), { width: 1024, height: 768, offsetLeft: 0, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const { activate } = fixture(); enter();
    act(() => { viewport.scale = 1.5; viewport.width = 680; viewport.dispatchEvent(new Event('resize')); });
    press('a');
    expect(activate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });
  it('rechecks inert ancestry synchronously before a selected control can activate', () => {
    const { button, activate } = fixture(); enter();
    const parent = button.parentElement!; const next = button.nextSibling;
    const unavailable = document.createElement('div'); unavailable.setAttribute('inert', ''); document.body.append(unavailable);
    try {
      act(() => { unavailable.append(button); press('a'); });
      expect(activate).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    } finally { parent.insertBefore(button, next); }
  });
  it('refuses a replacement node with identical identity, action and geometry', () => {
    const { button, activate } = fixture(); enter();
    const replacement = button.cloneNode(true) as HTMLButtonElement; const replaced = vi.fn(); replacement.addEventListener('click', replaced);
    try {
      act(() => { button.replaceWith(replacement); press('a'); });
      expect(activate).not.toHaveBeenCalled(); expect(replaced).not.toHaveBeenCalled();
    } finally { replacement.replaceWith(button); }
  });
  it('removes keyboard ownership on teardown without consuming later normal or repeated typing', () => {
    const { unmount, draft } = fixture(); draft.focus(); enter(); press('Escape', { code: 'Escape' });
    unmount();
    expect(press('Escape', { code: 'Escape', repeat: true }).defaultPrevented).toBe(false);
    expect(press('f').defaultPrevented).toBe(false);
    expect(enter().defaultPrevented).toBe(false);
  });
  it('does not enumerate actionable controls in an embedded document', () => {
    fixture();
    const frame = document.createElement('iframe'); document.body.append(frame);
    const foreign = frame.contentDocument!.createElement('button'); foreign.type = 'button'; foreign.dataset.phantomHint = 'foreign'; foreign.dataset.phantomHintAction = 'press'; frame.contentDocument!.body.append(foreign);
    expect(discoverHintTargets().map(target => target.id)).toEqual(['fixture.navigation']);
  });
  it('does not focus or edit a disabled draft during cancellation', () => {
    const { draft, activate } = fixture(); draft.focus(); enter(); draft.disabled = true;
    press('Escape', { code: 'Escape' });
    expect(draft).not.toHaveFocus(); expect(draft.value).toBe('retain draft'); expect(activate).not.toHaveBeenCalled();
  });
  it('forgets held modal keys when document visibility changes without a window blur', () => {
    fixture(); enter(); press('Shift', { code: 'ShiftLeft', shiftKey: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(press('Shift', { code: 'ShiftLeft', shiftKey: true, repeat: true }).defaultPrevented).toBe(false);
    expect(press('f').defaultPrevented).toBe(false);
  });
  it('provides described hint semantics without exposing target text, tooltips or draft values', () => {
    const { button, draft } = fixture();
    button.textContent = 'Fictional confidential target text'; button.title = 'Fictional confidential tooltip'; draft.value = 'Fictional confidential draft';
    enter();
    const owner = screen.getByRole('group', { name: 'Phantom keyboard hints' });
    expect(owner).toHaveFocus(); expect(owner).toHaveAccessibleDescription('1 controls. Type a hint · Escape cancels');
    const choices = within(owner).getByRole('list', { name: 'Available keyboard hint targets' });
    expect(choices).toHaveTextContent('A — Open fixture navigation');
    expect(owner.textContent).not.toContain('Fictional confidential');
    expect(draft.value).toBe('Fictional confidential draft');
  });
  it('leaves fresh typing, modified entry and editing events untouched while its retained owner is disabled', () => {
    setHintSettings({ enabled: false, chord: 'ctrl-shift-h' });
    const { draft, activate } = fixture(); draft.focus();
    expect(press('f').defaultPrevented).toBe(false); expect(enter().defaultPrevented).toBe(false);
    const edit = new InputEvent('beforeinput', { inputType: 'insertText', data: 'f', bubbles: true, cancelable: true });
    act(() => { draft.dispatchEvent(edit); });
    expect(edit.defaultPrevented).toBe(false); expect(draft).toHaveFocus(); expect(activate).not.toHaveBeenCalled();
  });
});
