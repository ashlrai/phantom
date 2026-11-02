import { describe, expect, it } from 'vitest';
import { personalLaneFacts, type PersonalLaneRow } from './personal-lane-facts.js';

const lane = (over: Partial<PersonalLaneRow> = {}): PersonalLaneRow => ({
  lane: 'codex-personal', running: 0, target: 12, queued: 0, held: false, heldReason: null, ...over,
});

describe('personalLaneFacts', () => {
  it('reports the lane line and the usage hold with its reason', () => {
    expect(personalLaneFacts([lane({ queued: 14, held: true, heldReason: 'usage limit until Nov 4 01:41' })]))
      .toEqual(['Lane codex-personal: 0/12 running · 14 queued', 'Held: usage limit (usage limit until Nov 4 01:41)']);
  });

  it('reports only the lane line while the lane is unheld', () => {
    expect(personalLaneFacts([lane({ running: 3, queued: 14 })]))
      .toEqual(['Lane codex-personal: 3/12 running · 14 queued']);
  });

  it('reports when nothing is queued', () => {
    expect(personalLaneFacts([lane({ running: 3 })])).toEqual(['Lane codex-personal: 3/12 running · 0 queued']);
  });

  it('returns nothing without the lane or without lanes at all', () => {
    expect(personalLaneFacts([])).toEqual([]);
    expect(personalLaneFacts(null)).toEqual([]);
    expect(personalLaneFacts(undefined)).toEqual([]);
    expect(personalLaneFacts([lane({ lane: 'claude-main' })])).toEqual([]);
  });

  it('selects an explicitly named lane', () => {
    expect(personalLaneFacts([lane({ lane: 'other', queued: 1 })], 'other'))
      .toEqual(['Lane other: 0/12 running · 1 queued']);
  });

  it('skips rows missing a string lane and ignores malformed counts', () => {
    const malformed = [{ running: 4, target: 9, queued: 2, held: false }, lane({ running: Number.NaN })] as unknown as PersonalLaneRow[];
    expect(personalLaneFacts(malformed)).toEqual(['Lane codex-personal: 0/12 running · 0 queued']);
    expect(personalLaneFacts([null, lane()] as unknown as PersonalLaneRow[])).toEqual(['Lane codex-personal: 0/12 running · 0 queued']);
  });

  it('reports a manual hold and falls back when the reason is absent or blank', () => {
    expect(personalLaneFacts([lane({ held: true, heldReason: 'maintenance window' })]))
      .toEqual(['Lane codex-personal: 0/12 running · 0 queued', 'Held: maintenance window']);
    expect(personalLaneFacts([lane({ held: true, heldReason: null })]))
      .toEqual(['Lane codex-personal: 0/12 running · 0 queued', 'Held: reason not reported']);
    expect(personalLaneFacts([lane({ held: true })]))
      .toEqual(['Lane codex-personal: 0/12 running · 0 queued', 'Held: reason not reported']);
    expect(personalLaneFacts([lane({ held: true, heldReason: '   ' })]))
      .toEqual(['Lane codex-personal: 0/12 running · 0 queued', 'Held: reason not reported']);
  });

  it('caps a long reason at 120 characters and strips control characters', () => {
    const reason = 'weekly quota reached '.repeat(15).trim();
    const [first, second] = personalLaneFacts([lane({ held: true, heldReason: `${reason}\u0007\u001b` })]);
    expect(first).toBe('Lane codex-personal: 0/12 running · 0 queued');
    expect(second).toBe(`Held: usage limit (${reason.slice(0, 120)})`);
    expect(second!.length).toBeLessThanOrEqual('Held: usage limit ()'.length + 120);
    expect(second).not.toMatch(/[\p{Cc}]/u);
  });
});
