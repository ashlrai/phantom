import { describe, expect, it } from 'vitest';
import { keyPassesToPage } from '../terminal/panel-keys.js';
import { WORKBENCH_COMMANDS } from './command-catalog.js';
import { chordId, COMMAND_KEYS, matchKey } from './command-keys.js';

describe('dock tab jump shortcuts', () => {
  it('matches the physical digit with Option on macOS and passes it out of a terminal', () => {
    for (const key of ['£', '3']) {
      const event = new KeyboardEvent('keydown', { key, code: 'Digit3', metaKey: true, altKey: true });
      expect(matchKey(event, ['chat'], 'mac')?.id).toBe('dock.tab-3');
      expect(keyPassesToPage(event, 'mac')).toBe(true);
    }
  });

  it('matches Ctrl+Alt+3 on other platforms', () => {
    const event = new KeyboardEvent('keydown', { key: '3', code: 'Digit3', ctrlKey: true, altKey: true });
    expect(matchKey(event, ['chat'], 'other')?.id).toBe('dock.tab-3');
  });

  it('registers nine unique chords and exposes all nine in the palette catalog', () => {
    const chords = Object.values(COMMAND_KEYS).flatMap((binding) =>
      binding.keys.map((key) => ({ id: binding.id, chord: chordId(key) })),
    );
    for (let n = 1; n <= 9; n++) {
      const id = `dock.tab-${n}`;
      const binding = COMMAND_KEYS[id as keyof typeof COMMAND_KEYS];
      expect(binding?.scope).toBe('chat');
      expect(binding?.keys).toHaveLength(1);
      const chord = chordId(binding!.keys[0]!);
      expect(chords.filter((entry) => entry.chord === chord)).toEqual([{ id, chord }]);
      expect(WORKBENCH_COMMANDS.find((command) => command.id === id)).toMatchObject({
        title: `Go to panel tab ${n}`, section: 'Dock', keywords: ['dock', 'tab', 'panel'],
      });
    }
  });
});
