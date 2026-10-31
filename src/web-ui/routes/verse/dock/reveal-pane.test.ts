import { beforeEach, expect, it, vi } from 'vitest';
import { setFocusMode } from '../shell/focus-mode.js';
import { setVerseSection } from '../verse-ui-store.js';
import { openDockPane } from './dock-store.js';
import { revealDockPane } from './reveal-pane.js';

vi.mock('../shell/focus-mode.js', () => ({ setFocusMode: vi.fn() }));
vi.mock('../verse-ui-store.js', () => ({ setVerseSection: vi.fn() }));
vi.mock('./dock-store.js', () => ({ openDockPane: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it('clears focus, switches to Chat, and opens the normalized pane', () => {
  revealDockPane('preview');
  expect(setFocusMode).toHaveBeenCalledExactlyOnceWith(false);
  expect(setVerseSection).toHaveBeenCalledExactlyOnceWith('chat');
  expect(openDockPane).toHaveBeenCalledExactlyOnceWith('browser');
  expect(vi.mocked(setFocusMode).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(setVerseSection).mock.invocationCallOrder[0]!);
  expect(vi.mocked(setVerseSection).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(openDockPane).mock.invocationCallOrder[0]!);
});

it('does nothing for an invalid pane id', () => {
  revealDockPane('invalid pane');
  expect(setFocusMode).not.toHaveBeenCalled();
  expect(setVerseSection).not.toHaveBeenCalled();
  expect(openDockPane).not.toHaveBeenCalled();
});
