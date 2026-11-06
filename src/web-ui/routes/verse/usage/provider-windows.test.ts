import { describe, expect, it } from 'vitest';
import { isClaudeProvider, visibleWindows, windowNote } from './provider-windows.js';

const win = (id: string) => ({ id, usedPercent: 10 });

describe('visibleWindows', () => {
  it('drops every spelling of the retired session window for Claude', () => {
    const windows = [win('five_hour'), win('seven_day'), win('claude_five_hour'), win('five-hour'), win('5h'), win('seven_day_fable')];
    expect(visibleWindows('claude', windows).map((w) => w.id)).toEqual(['seven_day', 'seven_day_fable']);
  });

  it('accepts the anthropic spelling of the provider', () => {
    expect(visibleWindows('anthropic', [win('five_hour'), win('seven_day')]).map((w) => w.id)).toEqual(['seven_day']);
  });

  it('keeps every window for Codex — its 5-hour window still exists', () => {
    const windows = [win('five_hour'), win('codex_codex_primary'), win('seven_day')];
    expect(visibleWindows('codex', windows)).toEqual(windows);
  });

  it('keeps every window for Grok, local and unknown providers', () => {
    const windows = [win('five_hour'), win('seven_day')];
    for (const provider of ['grok', 'local', 'devin', 'claude-api', 'something-new']) {
      expect(visibleWindows(provider, windows)).toEqual(windows);
    }
  });

  it('does not mutate the input and returns a new array', () => {
    const windows = [win('five_hour'), win('seven_day')];
    const out = visibleWindows('claude', windows);
    expect(windows).toHaveLength(2);
    expect(out).not.toBe(windows);
  });
});

describe('windowNote', () => {
  it('states the lifted limit once for Claude providers', () => {
    expect(windowNote('claude')).toBe('Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.');
    expect(windowNote('anthropic')).toBe('Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.');
  });

  it('says nothing for every other provider', () => {
    for (const provider of ['codex', 'grok', 'local', 'devin', 'claude-api', '']) {
      expect(windowNote(provider)).toBeNull();
    }
  });
});

describe('isClaudeProvider', () => {
  it('matches the wire spellings only', () => {
    expect(isClaudeProvider('claude')).toBe(true);
    expect(isClaudeProvider('anthropic')).toBe(true);
    expect(isClaudeProvider('CLAUDE')).toBe(true);
    expect(isClaudeProvider('claude-api')).toBe(false);
    expect(isClaudeProvider('codex')).toBe(false);
  });
});
