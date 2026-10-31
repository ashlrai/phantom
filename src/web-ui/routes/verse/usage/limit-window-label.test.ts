import { describe, expect, it } from 'vitest';
import { limitWindowLabel } from './limit-window-label.js';

describe('limitWindowLabel', () => {
  it.each(['five_hour', 'five-hour', '5h', 'claude_anthropic_five_hour'])(
    'marks Claude session window %s as retired',
    (window) => {
      expect(limitWindowLabel('Claude backend', window)).toEqual({
        text: 'per week',
        retired: true,
        title: 'Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.',
      });
    },
  );

  it('recognizes Anthropic backends', () => {
    expect(limitWindowLabel('ANTHROPIC', '5h').retired).toBe(true);
  });

  it('keeps weekly Claude windows', () => {
    expect(limitWindowLabel('claude', 'weekly')).toEqual({ text: 'per weekly', retired: false, title: null });
  });

  it('keeps other providers’ session windows and makes their labels readable', () => {
    expect(limitWindowLabel('codex', 'five_hour')).toEqual({ text: 'per five hour', retired: false, title: null });
  });
});
