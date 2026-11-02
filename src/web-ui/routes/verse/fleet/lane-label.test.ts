import { describe, expect, it } from 'vitest';
import { laneLabel, laneShort } from './lane-label.js';

describe('laneLabel — known ids', () => {
  it('codex-personal', () => expect(laneLabel('codex-personal')).toBe('Codex personal'));
  it('codex-cmp', () => expect(laneLabel('codex-cmp')).toBe('Codex CMP'));
  it('codex-local', () => expect(laneLabel('codex-local')).toBe('Local models'));
  it('claude', () => expect(laneLabel('claude')).toBe('Claude'));
  it('claude-api', () => expect(laneLabel('claude-api')).toBe('Claude API'));
  it('devin', () => expect(laneLabel('devin')).toBe('Devin'));
});

describe('laneShort — known ids', () => {
  it('personal', () => expect(laneShort('personal')).toBe('PERS'));
  it('cmp', () => expect(laneShort('cmp')).toBe('CMP'));
  it('local', () => expect(laneShort('local')).toBe('LOCAL'));
  it('claude', () => expect(laneShort('claude')).toBe('CL'));
  it('api', () => expect(laneShort('api')).toBe('API'));
  it('devin', () => expect(laneShort('devin')).toBe('DEVIN'));
});

describe('laneLabel — unknown normalisation', () => {
  it('my_new-lane → My new lane', () => expect(laneLabel('my_new-lane')).toBe('My new lane'));
  it('empty string', () => expect(laneLabel('')).toBe('Unknown lane'));
  it('whitespace only', () => expect(laneLabel('   ')).toBe('Unknown lane'));
  it('undefined as unknown as string', () => expect(laneLabel(undefined as unknown as string)).toBe('Unknown lane'));
});

describe('laneShort — unknown normalisation', () => {
  it('my_new-lane → MY_N (first 4 chars upper)', () => expect(laneShort('my_new-lane')).toBe('MY_N'));
  it('empty string → ?', () => expect(laneShort('')).toBe('?'));
  it('whitespace only', () => expect(laneShort('   ')).toBe('?'));
  it('undefined as unknown as string → ?', () => expect(laneShort(undefined as unknown as string)).toBe('?'));
});
