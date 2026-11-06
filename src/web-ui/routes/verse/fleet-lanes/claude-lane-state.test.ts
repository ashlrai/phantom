import { describe, expect, it } from 'vitest';
import { readLeaderPasses } from '../mobile/leader-passes-model.js';
import { claudeLaneFix, parseClaudeLane } from './claude-lane-state.js';

const localDate = new Date(2026, 10, 1, 1, 31, 50);
const now = localDate.getTime() + 2 * 60 * 60 * 1000;

describe('Claude lane state', () => {
  it.each([null, 'healthy', 'down token rejected 2026-11-01 01:31:50'])('agrees with the phone for %j', (text) => {
    expect(parseClaudeLane(text, now).down).toBe(readLeaderPasses({ claudeLane: text }, now).claudeLane.down);
  });

  it('parses a local timestamp and its reason', () => {
    expect(parseClaudeLane('down token rejected 2026-11-01 01:31:50', now)).toEqual({
      down: true, reason: 'token rejected', since: localDate.toISOString(), sinceText: 'since 01:31, 2 h ago', text: 'down token rejected 2026-11-01 01:31:50',
    });
  });

  it('finds a timestamp even when it is not trailing', () => {
    expect(parseClaudeLane('down 2026-11-01 01:31:50 for maintenance', now)).toMatchObject({
      down: true, reason: '2026-11-01 01:31:50 for maintenance', since: localDate.toISOString(), sinceText: 'since 01:31, 2 h ago',
    });
  });

  it('handles missing timestamps, punctuation, and healthy text', () => {
    expect(parseClaudeLane('down: quota', now)).toMatchObject({ down: true, reason: 'quota', since: null, sinceText: null });
    expect(parseClaudeLane('DOWN for maintenance', now)).toMatchObject({ down: true, reason: 'for maintenance', since: null });
    expect(parseClaudeLane('healthy', now)).toEqual({ down: false, reason: null, since: null, sinceText: null, text: 'healthy' });
    expect(parseClaudeLane(null, now)).toEqual({ down: false, reason: null, since: null, sinceText: null, text: null });
    expect(parseClaudeLane('not down', now).down).toBe(false);
    expect(claudeLaneFix()).toBe('Run on this Mac: ~/.ashlr-runs/bin/fix-claude-lane.sh');
  });
});
