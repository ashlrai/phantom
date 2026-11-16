import { describe, expect, it } from 'vitest';
import { isFlagOnlyText, isStatusAskText } from './thread-noise-model.js';

describe('thread noise', () => {
  it('matches only flag-only text', () => {
    for (const text of ['--help', '-h', '--json --limit=5']) expect(isFlagOnlyText(text)).toBe(true);
    expect(isFlagOnlyText('--help me ship')).toBe(false);
  });
  it('recognizes short status asks without treating orders as asks', () => {
    for (const text of ['status', 'Phantom status?', 'fleet status', '/status', '/status@MyBot', "what's the status", 'whats the status', 'glance', 'what’s up!', "what's running", "what's happening", "how's the fleet", "how's it going", 'how are we', 'how are things']) expect(isStatusAskText(text)).toBe(true);
    for (const text of ['status of the release pr #12', '--help', '/status@', 'status '.repeat(10)]) expect(isStatusAskText(text)).toBe(false);
  });
});
