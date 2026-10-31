import { act, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { registerPane } from '../panes/pane-registry.js';
import { detectKeyPlatform } from './command-keys.js';
import { ShortcutsOverlay } from './ShortcutsOverlay.js';

const Blank = () => null;
let dispose: () => void = () => undefined;

afterEach(() => {
  act(() => dispose());
  dispose = () => undefined;
});

it('lists pane-registry chords alongside the command catalog', () => {
  // Registered before the mount so this pane holds 'mod+alt+i' when the
  // lazy panes/index.js load resolves (fleet-inbox wants the same chord).
  act(() => {
    dispose = registerPane({ id: 'overlay-probe', title: 'Overlay probe pane', icon: Blank, component: Blank, shortcut: 'mod+alt+i' });
  });
  render(<ShortcutsOverlay />);
  const group = within(screen.getByRole('region', { name: 'Fleet panes' }));
  const term = group.getByText('Overlay probe pane');
  expect(term.parentElement).toHaveTextContent(detectKeyPlatform() === 'mac' ? '⌥⌘I' : 'Ctrl+Alt+I');
});
