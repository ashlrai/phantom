import { describe, expect, it } from 'vitest';
import { targetsOf } from '../fleet/interject-target-model.js';
import { aimText, canAim, rosterHeadline, rosterRows, stepRow } from './leader-roster-model.js';
import { rosterEmpty, rosterFleet } from './leader-roster.test-support.js';

describe('rosterRows', () => {
  const list = rosterFleet();
  const rows = rosterRows(list);
  const row = (id: string) => rows.find(item => item.id === id);

  it('lists only running workers and helpers, the quiet one first', () => {
    expect(rows.map(item => item.id).sort()).toEqual(['RQ-A', 'RQ-PR', 'RQ-QUIET', 'helper-a']);
    expect(rows[0]).toMatchObject({ id: 'RQ-QUIET', state: 'quiet', when: 'quiet 14m' });
    expect(row('RQ-FAILED')).toBeUndefined();
  });

  it('keeps what each said, and says nothing it does not hold', () => {
    expect(row('RQ-A')).toMatchObject({ kind: 'worker', state: 'running', said: 'Running the tests', job: 'RQ-A', lane: 'claude' });
    expect(row('RQ-QUIET')!.said).toBeNull();
    expect(row('RQ-PR')!.prUrl).toBe('https://github.com/ashlrai/phantom/pull/9');
  });

  it('marks a helper the steer syntax cannot name as not aimable', () => {
    expect(row('helper-a')).toMatchObject({ kind: 'subagent', aimable: false });
    expect(row('RQ-A')!.aimable).toBe(true);
  });

  it('counts quiet sessions in the headline and has a plain line for nobody working', () => {
    expect(rosterHeadline(rows, list)).toBe('4 working now · 1 quiet');
    expect(rosterHeadline([], rosterEmpty())).toBe('No agents are working right now');
  });

  it('counts workers whose state is unknown beside the running ones, never among them', () => {
    const leader = list.tree.roots[0]!;
    const lost = (id: string) => ({ ...leader.children[0]!, id, jobId: id, state: 'unknown' as const, children: [] });
    const unknown = { ...list, tree: { ...list.tree, roots: [{ ...leader, children: [...leader.children, lost('RQ-FAR'), lost('RQ-FARTHER')] }] } };
    expect(rosterHeadline(rosterRows(unknown), unknown)).toBe('4 working now · 1 quiet · 2 with state unknown');
    expect(rosterRows(unknown).map(item => item.id)).not.toContain('RQ-FAR');
  });
});

describe('aiming', () => {
  it('writes the mention the Leader thread reads back as a target', () => {
    expect(aimText('RQ-PHX-FIX')).toBe('@RQ-PHX-FIX ');
    expect(targetsOf(`earlier words\n\n${aimText('RQ-PHX-FIX')}`)).toEqual(['RQ-PHX-FIX']);
  });

  it('only aims at ids the steer syntax can name', () => {
    expect(canAim('RQ-PHX-FIX')).toBe(true);
    expect(canAim('helper-a')).toBe(false);
    expect(canAim('RQ-lower')).toBe(false);
  });
});

it('stepRow wraps in both directions and has no row in an empty list', () => {
  expect(stepRow(3, 2, 1)).toBe(0);
  expect(stepRow(3, 0, -1)).toBe(2);
  expect(stepRow(3, -1, 1)).toBe(1);
  expect(stepRow(0, 0, 1)).toBe(-1);
});
