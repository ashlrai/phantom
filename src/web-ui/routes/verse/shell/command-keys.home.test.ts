import { describe, expect, it } from 'vitest';
import { formatChord, keyBinding, matchKey } from './command-keys.js';

describe('home shortcuts', () => {
  it.each([['leader', 'h'], ['feed', 'g']])('opens %s with its global chord', (view, key) => {
    const id = `home.${view}`;
    const binding = keyBinding(id);
    expect(binding?.scope).toBe('global');
    expect(matchKey(new KeyboardEvent('keydown', { key: key.toUpperCase(), metaKey: true, shiftKey: true }), ['global'], 'mac')?.id).toBe(id);
    expect(formatChord(binding!.keys[0]!, 'mac')).toBe(`⇧⌘${key.toUpperCase()}`);
  });
});
