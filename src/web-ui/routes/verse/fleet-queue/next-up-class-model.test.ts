import { describe, expect, it } from 'vitest';
import { fillerFirst, nextUpCaption, nextUpClasses } from './next-up-class-model.js';

describe('next-up classes', () => {
  it('classifies jobs in order using the fleet classifier', () => {
    expect(nextUpClasses(['RQ-PHX-ABC01', 'RQ-FIXUP-1', 'RQ-FILL-2', 'RQ-STACK12A20261031Q8', 'manual'])).toEqual([
      { job: 'RQ-PHX-ABC01', cls: 'phx', label: 'Phantom' },
      { job: 'RQ-FIXUP-1', cls: 'fixup', label: 'fix-up' },
      { job: 'RQ-FILL-2', cls: 'filler', label: 'filler' },
      { job: 'RQ-STACK12A20261031Q8', cls: 'filler', label: 'filler' },
      { job: 'manual', cls: 'other', label: 'other' },
    ]);
  });

  it('counts only present classes in a stable order and handles an empty list', () => {
    expect(nextUpCaption('codex-personal', ['RQ-PHX-ABC01', 'RQ-FILL-2', 'RQ-PHX-DEF01']))
      .toBe('next 3 on codex-personal: 2 Phantom, 1 filler');
    expect(nextUpCaption('devin', ['manual', 'RQ-FIXUP-1', 'RQ-FILL-2', 'RQ-PHX-ABC01']))
      .toBe('next 4 on devin: 1 Phantom, 1 fix-up, 1 filler, 1 other');
    expect(nextUpCaption('devin', [])).toBe('nothing next');
  });

  it('warns only when a filler is first and Phantom work follows', () => {
    expect(fillerFirst(['RQ-FILL-2', 'RQ-FIXUP-1', 'RQ-PHX-DEF01'])).toBe(true);
    expect(fillerFirst(['RQ-STACK12A20261031Q8', 'RQ-PHX-DEF01'])).toBe(true);
    for (const jobs of [[], ['RQ-FILL-2'], ['RQ-FILL-2', 'manual'], ['RQ-PHX-ABC01', 'RQ-FILL-2', 'RQ-PHX-DEF01'], ['manual', 'RQ-FILL-2', 'RQ-PHX-DEF01']]) {
      expect(fillerFirst(jobs)).toBe(false);
    }
  });
});
