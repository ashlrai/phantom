import { expect, it, vi } from 'vitest';
import { chordId, parseChord } from '../shell/command-keys.js';

it('registers distinct shortcuts for the fleet workspace panes and queue', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await import('../fleet-lanes/fleet-lanes.pane.js');
  await import('../fleet-merges/fleet-merges.pane.js');
  await import('../fleet-hub/fleet-hub.pane.js');
  await import('../fleet-queue/fleet-queue.pane.js');
  const { getPane, listPanes, paneChord } = await import('./index.js');

  for (const [id, shortcut] of [
    ['fleet-lanes', 'mod+alt+n'],
    ['fleet-merges', 'mod+alt+o'],
    ['fleet-hub', 'mod+alt+g'],
    ['fleet-queue', 'mod+alt+q'],
  ]) {
    expect(shortcut).toMatch(/^mod\+alt\+[a-z]$/);
    expect(getPane(id!)?.shortcut, id).toEqual(parseChord(shortcut!));
  }

  expect(warn).not.toHaveBeenCalled();
  const shortcuts = listPanes().map(paneChord).filter((chord) => chord !== null).map(chordId);
  expect(new Set(shortcuts).size).toBe(shortcuts.length);
});
