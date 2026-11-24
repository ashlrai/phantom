import { describe, expect, it } from 'vitest';
import { buildFleetPace, paceSentence, paceWord } from '../src/core/fleet/pace-verdict.js';

const NOW = Date.parse('2026-11-19T10:00:00Z');
const HOUR = 3_600_000;
const pool = (id: string, usedPct: number | null, hoursLeft: number | null, burn: number | null) =>
  ({ id, usedPct, hoursLeft, burnPctPerHour: burn, resetAt: hoursLeft === null ? null : new Date(NOW + hoursLeft * HOUR).toISOString() });
const TIME = /\w{3}\s\d{1,2}\sAM|\w{3}\s\d{1,2}\sPM/u;

describe('paceSentence', () => {
  const view = { generatedAt: '2026-11-19T10:00:00.000Z', pools: [
    pool('claude', 64, 100, 2), pool('zai', 30, 100, 0.1), pool('grok', 50, 50, 1), pool('gemini', null, null, null),
  ] };
  const byPool = Object.fromEntries(buildFleetPace(view, NOW).pools.map(v => [v.pool, v]));

  it('ahead: names when it runs empty and when it resets', () => {
    expect(byPool['claude']!.state).toBe('ahead');
    expect(paceSentence(byPool['claude']!)).toMatch(/^Claude: 64%, empty about \w{3}\s\d{1,2}\s[AP]M, resets \w{3}\s\d{1,2}\s[AP]M\. Ahead of pace\.$/u);
    expect(paceWord('ahead')).toBe('ahead');
  });
  it('behind: says room is left over, with no empty time', () => {
    expect(byPool['zai']!.state).toBe('behind');
    expect(paceSentence(byPool['zai']!)).toMatch(/^Zai: 30%, resets .*\. Behind pace, room left over\.$/u);
    expect(paceSentence(byPool['zai']!)).not.toContain('empty');
  });
  it('on pace', () => {
    expect(byPool['grok']!.state).toBe('on-pace');
    expect(paceSentence(byPool['grok']!)).toMatch(/^Grok: 50%, resets .*\. On pace\.$/u);
    expect(paceWord('on-pace')).toBe('on pace');
  });
  it('unknown says unknown and guesses nothing', () => {
    expect(byPool['gemini']!.state).toBe('unknown');
    expect(paceSentence(byPool['gemini']!)).toBe('Gemini: unknown, no usable reading.');
    expect(paceSentence(byPool['gemini']!)).not.toMatch(TIME);
  });
});
