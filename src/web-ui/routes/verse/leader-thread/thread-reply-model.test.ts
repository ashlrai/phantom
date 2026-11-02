import { describe, expect, it } from 'vitest';
import { canSend, scrollTargetIndex, trimReply } from './thread-reply-model.js';

describe('thread reply model', () => {
  it('only sends nonblank replies when idle', () => {
    expect(canSend(' \n\t', false)).toBe(false);
    expect(canSend('hello', true)).toBe(false);
    expect(canSend(' hello ', false)).toBe(true);
  });

  it('limits the reply and removes trailing whitespace without altering the body', () => {
    expect(trimReply('  hello\nthere  \n')).toBe('  hello\nthere');
    expect(trimReply(`${'a'.repeat(5999)} b`)).toHaveLength(5999);
    expect(trimReply('a'.repeat(7000))).toHaveLength(6000);
  });

  it('selects the last entry or no entry', () => {
    expect(scrollTargetIndex([])).toBe(-1);
    expect(scrollTargetIndex(['one'])).toBe(0);
    expect(scrollTargetIndex(['one', 'two'])).toBe(1);
  });
});
