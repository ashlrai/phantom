import { expect, it } from 'vitest';
import { COMMAND_KEYS, DESKTOP_COMMANDS, chordId, formatChord, parseChord } from './command-keys.js';
import { shortcutSections } from './command-catalog.js';

it('binds and displays a chord unique among commands, desktop commands, and panes', async () => {
  await import('../fleet-inbox/fleet-inbox.pane.js');
  await import('../fleet-bus/fleet-bus.pane.js');
  await import('../fleet-events/fleet-events.pane.js');
  await import('../fleet-host/fleet-host.pane.js');
  await import('../fleet-timeline/fleet-timeline.pane.js');
  await import('../fleet-brief/fleet-brief.pane.js');
  await import('../fleet-supply/fleet-supply.pane.js');
  await import('../leader-thread/leader-thread.pane.js');
  await import('../leader-journal/leader-journal.pane.js');
  const { listPanes, paneChord } = await import('../panes/index.js');
  const chord = COMMAND_KEYS['fleet.interject'].keys[0]!;
  expect(chord).toEqual(parseChord('mod+alt+m'));
  expect(formatChord(chord, 'mac')).toBe('⌥⌘M');
  expect(formatChord(chord, 'other')).toBe('Ctrl+Alt+M');
  const id = chordId(chord);
  expect(Object.values(COMMAND_KEYS).flatMap((binding) => binding.keys.filter((key) => chordId(key) === id))).toHaveLength(1);
  expect(Object.values(DESKTOP_COMMANDS).some((command) => COMMAND_KEYS[command].keys.some((key) => chordId(key) === id))).toBe(false);
  expect(listPanes().some((pane) => { const key = paneChord(pane); return key && chordId(key) === id; })).toBe(false);
  expect(shortcutSections().flatMap((section) => section.commands).some((command) => command.id === 'fleet.interject')).toBe(true);
}, 30_000);
