import { expect, it } from 'vitest';
import { matchKey } from './command-keys.js';
import { shouldFocusSteer } from './steer-hotkey.js';

it('protects another editable draft but allows empty fields and the steer box', () => {
  expect(shouldFocusSteer({ editable: true, text: 'draft', steer: false })).toBe('blocked');
  expect(shouldFocusSteer({ editable: true, text: '', steer: false })).toBe('focus');
  expect(shouldFocusSteer({ editable: true, text: 'draft', steer: true })).toBe('focus');
  expect(shouldFocusSteer({ editable: false, text: 'label', steer: false })).toBe('focus');
});

it.each(['mac', 'other'] as const)('matches the shortcut on %s', platform => {
  const event = new KeyboardEvent('keydown', { key: 'J', shiftKey: true, metaKey: platform === 'mac', ctrlKey: platform === 'other' });
  expect(matchKey(event, ['global'], platform)?.id).toBe('fleet.focus-steer');
});

it('leaves a different draft and the current surface alone', async () => {
  const { requestSteerFocus } = await import('./steer-hotkey.js');
  const { getVerseUiState, setVerseSection } = await import('../verse-ui-store.js');
  setVerseSection('chat');
  const input = document.createElement('textarea');
  input.value = 'Unsent';
  document.body.append(input);
  input.focus();
  let blocked = false;
  requestSteerFocus(false, () => { blocked = true; });
  expect(blocked).toBe(true);
  expect(getVerseUiState().section).toBe('chat');
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe('Unsent');
  input.remove();
});
