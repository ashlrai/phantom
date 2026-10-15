// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import HintNavigation from '../src/web-ui/routes/verse/hints/HintNavigation.js';
import { discoverHintTargets, hintLabels, sameHintTargets } from '../src/web-ui/routes/verse/hints/hint-model.js';
import { matchesHintChord, setHintSettings } from '../src/web-ui/routes/verse/hints/hint-settings.js';

function control(id = 'navigation', action = 'press'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.phantomHint = id;
  button.dataset.phantomHintAction = action;
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ left: 20, top: 20, right: 60, bottom: 40, width: 40, height: 20, x: 20, y: 20, toJSON: () => ({}) });
  document.body.append(button);
  return button;
}
function key(target: EventTarget, key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  act(() => { target.dispatchEvent(event); });
  return event;
}
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLSpanElement) {
    // jsdom has no annotation layout. Supply positive synthetic badge/status
    // measurements while preserving each control's independent geometry spy.
    if (this.hasAttribute('data-hint-label')) return { left: 20, top: 20, right: 46, bottom: 40, width: 26, height: 20, x: 20, y: 20, toJSON: () => ({}) };
    return originalBounds.call(this);
  });
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLDivElement) {
    if (this.getAttribute('role') === 'status') return { left: 400, top: 600, right: 600, bottom: 630, width: 200, height: 30, x: 400, y: 600, toJSON: () => ({}) };
    return originalBounds.call(this);
  });
  setHintSettings({ enabled: true, chord: 'ctrl-shift-h' });
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); localStorage.clear(); });

describe('independent frontend keyboard hint regressions', () => {
  it('keeps every supported label inventory unique and prefix-free', () => {
    for (const count of [1, 9, 10, 81, 82, 200]) {
      const labels = hintLabels(count);
      expect(new Set(labels).size).toBe(count);
      for (const a of labels) for (const b of labels) if (a !== b) expect(a.startsWith(b)).toBe(false);
    }
    expect(hintLabels(201)).toEqual([]);
  });
  it('refuses duplicate stable identities and stale replacement elements', () => {
    const first = control('same');
    const before = discoverHintTargets();
    control('same');
    expect(discoverHintTargets()).toEqual([]);
    document.body.replaceChildren();
    control('same');
    expect(sameHintTargets(before, discoverHintTargets())).toBe(false);
    expect(first.isConnected).toBe(false);
  });
  it('adapts known shell navigation while excluding unregistered approval and unknown section controls', () => {
    const rail = document.createElement('nav'); rail.dataset.rail = 'collapsed'; document.body.append(rail);
    const navigation = control(); navigation.removeAttribute('data-phantom-hint'); navigation.removeAttribute('data-phantom-hint-action'); navigation.dataset.section = 'chat'; rail.append(navigation);
    const approval = control('approval'); approval.removeAttribute('data-phantom-hint'); approval.removeAttribute('data-phantom-hint-action'); approval.dataset.section = 'approve'; rail.append(approval);
    const unrelated = control('delete'); unrelated.removeAttribute('data-phantom-hint'); unrelated.removeAttribute('data-phantom-hint-action'); rail.append(unrelated);
    expect(discoverHintTargets().map(target => target.id)).toEqual(['rail.chat']);
    const approve = vi.fn(); const remove = vi.fn(); approval.addEventListener('click', approve); unrelated.addEventListener('click', remove);
    render(createElement(HintNavigation));
    key(navigation, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true }); key(navigation, 'a', { code: 'KeyA' });
    expect(approve).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it('does not touch typing while idle and blocks terminal/composer listeners while modal', () => {
    const button = control();
    const recipient = document.createElement('textarea'); document.body.append(recipient);
    const received = vi.fn(); recipient.addEventListener('keydown', received);
    render(createElement(HintNavigation));
    expect(key(recipient, 'f').defaultPrevented).toBe(false);
    expect(received).toHaveBeenCalledTimes(1);
    const click = vi.fn(); button.addEventListener('click', click);
    key(recipient, 'H', { ctrlKey: true, shiftKey: true });
    expect(key(recipient, 'Enter').defaultPrevented).toBe(true);
    expect(received).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    expect(key(recipient, 'f').defaultPrevented).toBe(false);
  });
  it('cancels stale geometry without activation or leaked selection letters', () => {
    const button = control();
    const click = vi.fn(); button.addEventListener('click', click);
    render(createElement(HintNavigation)); key(button, 'H', { ctrlKey: true, shiftKey: true });
    vi.mocked(button.getBoundingClientRect).mockReturnValue({ left: 200, top: 20, right: 240, bottom: 40, width: 40, height: 20, x: 200, y: 20, toJSON: () => ({}) });
    expect(key(button, 'a').defaultPrevented).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });
  it('forgets modal held keys on focus loss so subsequent ordinary repeats are untouched', () => {
    const button = control();
    for (let index = 1; index < 10; index++) control(`navigation-${index}`);
    render(createElement(HintNavigation));
    key(button, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true });
    key(button, 'a', { code: 'KeyA' });
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(key(button, 'a', { code: 'KeyA' }).defaultPrevented).toBe(false);
    expect(key(button, 'a', { code: 'KeyA', repeat: true }).defaultPrevented).toBe(false);
  });
  it('owns the selected key tail when navigation opens a blocked menu', () => {
    const button = control();
    const view = render(createElement(HintNavigation));
    button.addEventListener('click', () => view.rerender(createElement(HintNavigation, { blocked: true })));
    key(button, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true });
    key(button, 'a', { code: 'KeyA' });
    expect(key(button, 'a', { code: 'KeyA', repeat: true }).defaultPrevented).toBe(true);
    act(() => { button.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true })); });
    expect(key(button, 'a', { code: 'KeyA' }).defaultPrevented).toBe(false);
  });
  it('drains consumed keys when disabled and does not reenter until enabled with the new chord', () => {
    const button = control();
    for (let index = 1; index < 10; index++) control(`navigation-${index}`);
    render(createElement(HintNavigation));
    key(button, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true });
    key(button, 'a', { code: 'KeyA' });
    act(() => setHintSettings({ enabled: false, chord: 'ctrl-alt-h' }));
    expect(document.querySelector('[data-hint-label]')).toBeNull();
    expect(key(button, 'a', { code: 'KeyA', repeat: true }).defaultPrevented).toBe(true);
    act(() => { button.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true })); });
    expect(key(button, 'a', { code: 'KeyA' }).defaultPrevented).toBe(false);
    expect(key(button, 'H', { code: 'KeyH', ctrlKey: true, altKey: true }).defaultPrevented).toBe(false);
    act(() => setHintSettings({ enabled: true, chord: 'ctrl-alt-h' }));
    expect(key(button, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(key(button, 'H', { code: 'KeyH', ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
  });
  it('owns a selected focus key through disable and keyup without editing the focused draft', () => {
    const geometry = control(); geometry.remove();
    const draft = document.createElement('textarea');
    draft.dataset.phantomHint = 'composer'; draft.dataset.phantomHintAction = 'focus'; draft.value = 'preserve this draft';
    vi.spyOn(draft, 'getBoundingClientRect').mockImplementation(() => geometry.getBoundingClientRect());
    document.body.append(draft);
    const received = vi.fn(); draft.addEventListener('keydown', received);
    render(createElement(HintNavigation));
    key(draft, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true });
    key(draft, 'a', { code: 'KeyA' });
    expect(document.activeElement).toBe(draft);
    act(() => setHintSettings({ enabled: false, chord: 'ctrl-shift-h' }));
    expect(key(draft, 'a', { code: 'KeyA', repeat: true }).defaultPrevented).toBe(true);
    expect(received).not.toHaveBeenCalled();
    act(() => { draft.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true })); });
    expect(key(draft, 'f', { code: 'KeyF' }).defaultPrevented).toBe(false);
    expect(received).toHaveBeenCalledTimes(1);
    expect(draft.value).toBe('preserve this draft');
  });
  it('presses without a preparatory focus handler changing target identity', () => {
    const button = control();
    const click = vi.fn(); button.addEventListener('click', click);
    const focus = vi.fn(() => button.remove());
    button.addEventListener('focus', focus);
    render(createElement(HintNavigation)); key(document.body, 'H', { ctrlKey: true, shiftKey: true });
    key(document.body, 'a');
    expect(focus).not.toHaveBeenCalled();
    expect(button.isConnected).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });
  it('never requests the hint module before opt-in and retains its mounted owner across config changes', async () => {
    const requested = vi.fn();
    const mounts = vi.fn();
    vi.doMock('../src/web-ui/routes/verse/hints/HintNavigation.js', () => {
      requested();
      return { default: () => { mounts(); return createElement('span', { 'data-independent-hint-owner': true }); } };
    });
    try {
      const { GearTray } = await import('../src/web-ui/routes/verse/shell/GearTray.js');
      act(() => setHintSettings({ enabled: false, chord: 'ctrl-shift-h' }));
      const props = { open: false, anchorRef: createRef<HTMLButtonElement>(), onClose: vi.fn(), compact: false };
      const view = render(createElement(GearTray, props));
      // Flush effects and module promises: null output alone would not establish no fetch.
      await act(async () => { await Promise.resolve(); });
      expect(requested).not.toHaveBeenCalled();
      expect(mounts).not.toHaveBeenCalled();
      act(() => setHintSettings({ enabled: true, chord: 'ctrl-shift-h' }));
      await waitFor(() => expect(document.querySelector('[data-independent-hint-owner]')).not.toBeNull());
      expect(requested).toHaveBeenCalledTimes(1);
      const owner = document.querySelector('[data-independent-hint-owner]');
      act(() => setHintSettings({ enabled: false, chord: 'ctrl-alt-h' }));
      view.rerender(createElement(GearTray, { ...props, hintBlocked: true }));
      expect(document.querySelector('[data-independent-hint-owner]')).toBe(owner);
      expect(requested).toHaveBeenCalledTimes(1);
    } finally { vi.doUnmock('../src/web-ui/routes/verse/hints/HintNavigation.js'); }
  });
});
