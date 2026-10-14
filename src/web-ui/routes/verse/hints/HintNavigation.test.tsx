import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HintNavigation from './HintNavigation.js';
import { discoverHintTargets, hintLabels, MAX_HINT_TARGETS } from './hint-model.js';
import { matchesHintChord, setHintSettings } from './hint-settings.js';

const rect = (left = 20, top = 20) => ({ left, top, right: left + 50, bottom: top + 25, width: 50, height: 25, x: left, y: top, toJSON: () => ({}) });
function chord(options = {}) { return fireEvent.keyDown(document.activeElement ?? document.body, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true, ...options }); }
function key(key: string, options = {}) { return fireEvent.keyDown(document.activeElement ?? document.body, { key, code: `Key${key.toUpperCase()}`, ...options }); }
function fixture(onPress = vi.fn()) {
  render(<><textarea aria-label="Draft" defaultValue="keep this draft" data-phantom-hint="a.composer" data-phantom-hint-action="focus" />
    <button type="button" data-phantom-hint="b.settings" data-phantom-hint-action="press" onClick={onPress}>Settings</button>
    <button type="submit" data-phantom-hint="c.send" data-phantom-hint-action="press" onClick={onPress}>Send</button>
    <button type="button" onClick={onPress}>Approve</button><HintNavigation /></>);
  return onPress;
}
beforeEach(() => {
  localStorage.clear();
  setHintSettings({ enabled: true, chord: 'ctrl-alt-h' });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Phantom hint navigation', () => {
  it('does not intercept normal typing or any shortcut until enabled', async () => {
    fixture();
    const draft = screen.getByRole('textbox');
    const user = userEvent.setup();
    await user.click(draft);
    await user.type(draft, 'fash');
    expect(draft).toHaveValue('keep this draftfash');
    act(() => setHintSettings({ enabled: false, chord: 'ctrl-alt-h' }));
    expect(chord()).toBe(true);
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });
  it('owns modal letters and Escape before descendant/document handlers, preserving drafts', () => {
    fixture();
    const handler = vi.fn();
    document.addEventListener('keydown', handler);
    const draft = screen.getByRole('textbox'); draft.focus();
    expect(chord()).toBe(false);
    expect(screen.getByLabelText('Phantom keyboard hints')).toHaveFocus();
    expect(key('Escape')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(draft).toHaveFocus(); expect(draft).toHaveValue('keep this draft');
    document.removeEventListener('keydown', handler);
  });
  it('presses only explicit safe button targets and focuses composer without submitting', () => {
    const onPress = fixture();
    expect(discoverHintTargets().map((target) => target.id)).toEqual(['a.composer', 'b.settings']);
    chord(); key('a');
    expect(screen.getByRole('textbox')).toHaveFocus(); expect(onPress).not.toHaveBeenCalled();
    chord(); key('s'); expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });
  it('consumes Enter and modified chords without sending or leaking a modal character', () => {
    const onPress = fixture(); chord(); expect(key('Enter')).toBe(false); expect(onPress).not.toHaveBeenCalled();
    chord(); expect(key('a', { ctrlKey: true })).toBe(false); expect(onPress).not.toHaveBeenCalled();
  });
  it('revalidates moved targets synchronously before activation and disabled targets on mutation', async () => {
    const onPress = fixture(); chord();
    const settings = screen.getByRole('button', { name: 'Settings' });
    vi.spyOn(settings, 'getBoundingClientRect').mockReturnValue(rect(40));
    key('s'); expect(onPress).not.toHaveBeenCalled();
    chord();
    await act(async () => { settings.setAttribute('disabled', ''); });
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });
  it('cancels after identity replacement, resize, scroll or window blur', async () => {
    fixture(); chord();
    await act(async () => { screen.getByRole('button', { name: 'Settings' }).dataset.phantomHint = 'changed'; });
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    for (const event of ['resize', 'scroll', 'blur']) {
      chord(); expect(screen.getByLabelText('Phantom keyboard hints')).toBeInTheDocument();
      fireEvent(window, new Event(event));
      expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    }
  });
  it('matches the modified shortcut by physical code for Option/layout characters and refuses AltGraph', () => {
    fixture(); expect(chord({ key: '˙' })).toBe(false); key('Escape');
    const altGraph = new KeyboardEvent('keydown', { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
    vi.spyOn(altGraph, 'getModifierState').mockImplementation((name) => name === 'AltGraph');
    expect(matchesHintChord(altGraph, 'ctrl-alt-h')).toBe(false);
  });
  it('does not enter on repeat, composing input, AltGraph or an unfocused document', () => {
    fixture();
    chord({ repeat: true }); chord({ isComposing: true }); chord({ keyCode: 229 });
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    vi.mocked(document.hasFocus).mockReturnValue(false); chord();
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });
  it('consumes repeat while modal and after selection until key release', () => {
    const onPress = fixture(); chord(); key('s', { repeat: true }); expect(onPress).not.toHaveBeenCalled();
    key('s'); expect(onPress).toHaveBeenCalledTimes(1);
    expect(key('s', { repeat: true })).toBe(false);
    fireEvent.keyUp(document.body, { key: 's', code: 'KeyS' });
    expect(key('s')).toBe(true);
  });
  it('disabling entry drains held modal repeats until release without swallowing fresh idle typing', () => {
    fixture(); chord(); key('s');
    act(() => setHintSettings({ enabled: false, chord: 'ctrl-alt-h' }));
    expect(key('s', { repeat: true })).toBe(false);
    fireEvent.keyUp(document.body, { key: 's', code: 'KeyS' });
    expect(key('s')).toBe(true); expect(key('s', { repeat: true })).toBe(true);
    expect(chord()).toBe(true);
  });
  it('cancels composition without restoring focus into an editable draft', () => {
    fixture(); const draft = screen.getByRole('textbox'); draft.focus(); chord();
    fireEvent.compositionStart(document.activeElement!);
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    expect(draft).not.toHaveFocus(); expect(draft).toHaveValue('keep this draft');
  });
  it('stands down for open menus/dialogs and cancels when one appears', async () => {
    fixture(); chord();
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    await act(async () => { document.body.append(dialog); });
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
    expect(chord()).toBe(true); dialog.remove();
  });
  it('uses the configured alternate chord and keeps invalid local preference data disabled', () => {
    fixture(); act(() => setHintSettings({ enabled: true, chord: 'ctrl-shift-h' }));
    expect(chord()).toBe(true); expect(chord({ altKey: false, shiftKey: true })).toBe(false); key('Escape');
    act(() => { localStorage.setItem('phantom.keyboard-hints.v1', '{broken'); window.dispatchEvent(new Event('storage')); });
    expect(chord({ altKey: false, shiftKey: true })).toBe(true);
  });
  it('fails closed for duplicate identities, too many targets, hidden and secure fields', () => {
    fixture();
    const settings = screen.getByRole('button', { name: 'Settings' }); settings.dataset.phantomHint = 'a.composer';
    expect(discoverHintTargets()).toEqual([]); settings.dataset.phantomHint = 'b.settings'; settings.setAttribute('hidden', '');
    const draft = screen.getByRole('textbox'); draft.setAttribute('hidden', '');
    expect(discoverHintTargets()).toEqual([]); draft.removeAttribute('hidden');
    for (let i = 0; i < MAX_HINT_TARGETS; i++) {
      const el = document.createElement('input'); el.type = 'password'; el.dataset.phantomHint = `secure.${i}`; el.dataset.phantomHintAction = 'focus'; document.body.append(el);
    }
    expect(discoverHintTargets()).toEqual([]);
    document.querySelectorAll('input[type="password"]').forEach((el) => el.remove());
  });
  it('adapts only the existing app-owned shell structure and composer, without startup hint markers', () => {
    render(<><nav data-rail="collapsed"><button type="button" data-section="chat">Chat</button><button type="button" data-gear>Settings</button><button type="button" data-needs-you="0">Inbox</button><button type="button">Approve</button></nav>
      <main id="main-content"><div><nav><button type="button" aria-pressed>With me</button><button type="button" aria-pressed={false}>For me</button></nav><button type="button" aria-haspopup="menu">Review</button></div>
        <div data-surface="chat"><form aria-describedby="help"><div><textarea aria-label="Draft" /></div><button type="submit">Send</button></form></div></main></>);
    expect(discoverHintTargets().map((target) => target.id)).toEqual(['chat.composer', 'mode.for-me', 'mode.with-me', 'rail.chat', 'rail.needs-you', 'rail.settings', 'shell.review']);
  });
  it('generates deterministic prefix-free labels across alphabet boundaries', () => {
    for (const count of [1, 9, 10, 81, 82, MAX_HINT_TARGETS]) {
      const labels = hintLabels(count); expect(new Set(labels).size).toBe(count); expect(labels).toEqual(hintLabels(count));
      expect(labels.every((label) => !labels.some((other) => label !== other && other.startsWith(label)))).toBe(true);
    }
  });
  it('reliability: stands down for a partially offscreen modal and cancels when it appears', async () => {
    fixture(); chord();
    const modal = document.createElement('div'); modal.setAttribute('role', 'dialog');
    modal.getBoundingClientRect = () => rect(-10);
    try {
      await act(async () => { document.body.append(modal); });
      expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
      expect(chord()).toBe(true);
    } finally { modal.remove(); }
  });
  it('reliability: cancels a stale semantic button state even when identity and bounds stay unchanged', async () => {
    fixture(); chord();
    await act(async () => { screen.getByRole('button', { name: 'Settings' }).setAttribute('aria-pressed', 'true'); });
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });
  it('reliability: an absent physical key code does not make a consumed hint swallow unrelated idle repeats', () => {
    fixture(); chord(); key('s', { code: '' });
    expect(key('f', { code: '', repeat: true })).toBe(true);
    expect(key('s', { code: '', repeat: true })).toBe(false);
    fireEvent.keyUp(document.body, { key: 's', code: '' });
    expect(key('s', { code: '', repeat: true })).toBe(true);
  });
  it('reliability: secure input scope prevents entry even when the focused field is nested', () => {
    fixture(); const draft = screen.getByRole('textbox');
    draft.parentElement!.dataset.secureInput = 'true'; draft.focus();
    expect(chord()).toBe(true);
    expect(screen.queryByLabelText('Phantom keyboard hints')).not.toBeInTheDocument();
  });

  it('reliability: failed overlay focus yields an honest state and leaves the draft input owner intact', () => {
    fixture(); const draft = screen.getByRole('textbox'); draft.focus();
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
      if (this.getAttribute('aria-label') !== 'Phantom keyboard hints') focus.call(this, options);
    });
    chord();
    expect(key('f')).toBe(true); expect(draft).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Keyboard hints could not take focus');
    expect(document.querySelector('[data-hint-label]')).toBeNull();
  });
  it('exposes hint instructions and labels through a named focus group without reading field text', () => {
    fixture(); chord();
    const group = screen.getByRole('group', { name: 'Phantom keyboard hints' });
    expect(group).toHaveFocus(); expect(group).toHaveAccessibleDescription('2 controls. Type a hint · Escape cancels');
    const choices = screen.getByRole('list', { name: 'Available keyboard hint targets' });
    expect(choices).toHaveTextContent('A — Focus a composer'); expect(choices).toHaveTextContent('S — Open b settings');
    expect(group).not.toHaveTextContent('keep this draft');
  });

  it('restores the same visible editor when a crowded measured layout rejects hint mode', () => {
    fixture(); const draft = screen.getByRole('textbox'); draft.focus();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-hint-label') ? { ...rect(0, 0), width: 1000, height: 760, right: 1000, bottom: 760 } : rect();
    });
    chord();
    expect(screen.queryByRole('group', { name: 'Phantom keyboard hints' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Controls are too crowded');
    expect(draft).toHaveFocus(); expect(draft).toHaveValue('keep this draft'); expect(key('f')).toBe(true);
  });

});
