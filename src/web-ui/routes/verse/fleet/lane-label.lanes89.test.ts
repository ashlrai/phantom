import { describe, expect, it } from 'vitest';
import { laneLabel, laneShort } from './lane-label';

describe('fleet lane labels', () => {
  it.each([
    ['devin-flash', 'Devin SWE-2 Flash'],
    ['zai', 'Z.ai'],
    ['gemini', 'Gemini'],
    ['agy', 'Antigravity'],
    ['grok', 'Grok'],
    ['cursor', 'Cursor'],
  ])('labels %s as %s', (lane, label) => {
    expect(laneLabel(lane)).toBe(label);
  });

  it.each([
    ['codex-personal', 'PERS'], ['codex-cmp', 'CMP'], ['codex-local', 'LOCAL'],
    ['claude', 'CL'], ['claude-api', 'API'], ['devin', 'DEVIN'],
    ['devin-flash', 'FLASH'], ['zai', 'ZAI'], ['gemini', 'GEM'],
    ['agy', 'AGY'], ['grok', 'GROK'], ['cursor', 'CUR'],
    ['personal', 'PERS'], ['cmp', 'CMP'], ['local', 'LOCAL'], ['api', 'API'],
  ])('shortens %s to %s', (lane, tag) => {
    expect(laneShort(lane)).toBe(tag);
  });

  it('distinguishes Devin lanes', () => {
    expect(laneShort('devin')).not.toBe(laneShort('devin-flash'));
  });

  it('preserves unknown and empty fallbacks', () => {
    expect(laneLabel('  new_lane-name  ')).toBe('New lane name');
    expect(laneShort('  new_lane-name  ')).toBe('NEW_');
    expect(laneLabel('')).toBe('Unknown lane');
    expect(laneShort('')).toBe('?');
  });
});
