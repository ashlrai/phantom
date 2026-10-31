import { expect, it, vi } from 'vitest';
import { COMMAND_KEYS, SYSTEM_RESERVED_CHORDS, chordId, chordMatches, parseChord, type KeyChord, type KeyPlatform } from '../shell/command-keys.js';

const ids = ['fleet-inbox', 'fleet-bus', 'fleet-events', 'fleet-host', 'fleet-timeline', 'fleet-brief', 'fleet-supply', 'leader-thread', 'leader-journal'];

function eventFor(chord: KeyChord, platform: KeyPlatform) {
  return {
    key: chord.key,
    metaKey: platform === 'mac' && !!chord.mod,
    ctrlKey: !!chord.ctrl || (platform === 'other' && !!chord.mod),
    shiftKey: !!chord.shift,
    altKey: !!chord.alt,
  };
}

it('registers nine distinct, valid shortcuts without conflicts or warnings', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await import('../fleet-inbox/fleet-inbox.pane.js');
  await import('../fleet-bus/fleet-bus.pane.js');
  await import('../fleet-events/fleet-events.pane.js');
  await import('../fleet-host/fleet-host.pane.js');
  await import('../fleet-timeline/fleet-timeline.pane.js');
  await import('../fleet-brief/fleet-brief.pane.js');
  await import('../fleet-supply/fleet-supply.pane.js');
  await import('../leader-thread/leader-thread.pane.js');
  await import('../leader-journal/leader-journal.pane.js');
  const { getPane, listPanes, paneChord } = await import('./index.js');
  expect(warn).not.toHaveBeenCalled();
  const catalog = Object.values(COMMAND_KEYS).flatMap((binding) => binding.keys);
  const allPanes = listPanes();
  for (const id of ids) {
    const chord = getPane(id)?.shortcut;
    expect(chord, id).toBeTruthy();
    if (!chord) throw new Error(`Missing shortcut for ${id}`);
    expect(parseChord(chordId(chord))).toEqual(chord);
    expect(chord.mod || chord.ctrl, id).toBe(true);
    for (const platform of ['mac', 'other'] as const) {
      const event = eventFor(chord, platform);
      expect([...catalog, ...SYSTEM_RESERVED_CHORDS].some((other) => chordMatches(event, other, platform)), `${id} on ${platform}`).toBe(false);
      expect(allPanes.filter((pane) => {
        const other = paneChord(pane);
        return other && chordMatches(event, other, platform);
      }).map((pane) => pane.id), `${id} on ${platform}`).toEqual([id]);
    }
  }
});
