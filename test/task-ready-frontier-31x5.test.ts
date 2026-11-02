import { describe, expect, it } from 'vitest';

import { DuplicateTaskIdError, taskReadyFrontier } from '../src/core/fleet/task-ready-frontier.js';

/** Each fixture: [tasks, completed] → expected ready IDs. */
type Fixture = [
  { id: string; dependsOn?: string[] }[],
  string[],
  string[],
];

describe('taskReadyFrontier', () => {
  /* ─── independent ready tasks ─── */
  it('returns independent tasks when no dependencies exist', () => {
    const tasks = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    expect(taskReadyFrontier(tasks, [])).toEqual(['a', 'b', 'c']);
  });

  /* ─── completed tasks excluded ─── */
  it('excludes tasks whose ID is in completed', () => {
    const tasks = [{ id: 'x' }, { id: 'y' }];
    expect(taskReadyFrontier(tasks, ['x'])).toEqual(['y']);
  });

  /* ─── chain advances only after deps complete ─── */
  it('advances a chain only after each dependency completes', () => {
    const tasks = [
      { id: 'alpha' },
      { id: 'beta', dependsOn: ['alpha'] },
      { id: 'gamma', dependsOn: ['beta'] },
    ];
    // Only alpha is ready.
    expect(taskReadyFrontier(tasks, [])).toEqual(['alpha']);
    // After alpha completes, beta becomes ready (gamma still blocked).
    expect(taskReadyFrontier(tasks, ['alpha'])).toEqual(['beta']);
    // All done — gamma ready.
    expect(taskReadyFrontier(tasks, ['alpha', 'beta'])).toEqual(['gamma']);
    // Everything completed → empty.
    expect(taskReadyFrontier(tasks, ['alpha', 'beta', 'gamma'])).toEqual([]);
  });

  /* ─── unknown dependency blocks readiness ─── */
  it('blocks tasks with dependencies not present in any task list', () => {
    const tasks = [{ id: 'p', dependsOn: ['nonexistent'] }];
    expect(taskReadyFrontier(tasks, [])).toEqual([]);
  });

  /* ─── self-dependency and cycles stay blocked ─── */
  it('self-dependency prevents readiness', () => {
    const tasks = [{ id: 'loop', dependsOn: ['loop'] }];
    expect(taskReadyFrontier(tasks, [])).toEqual([]);
  });

  it('a two-node cycle stays blocked', () => {
    const tasks = [
      { id: 'u', dependsOn: ['v'] },
      { id: 'v', dependsOn: ['u'] },
    ];
    expect(taskReadyFrontier(tasks, [])).toEqual([]);
  });

  /* ─── duplicate dependency labels ─── */
  it('duplicate dependency entries do not affect readiness', () => {
    const tasks = [
      { id: 'z', dependsOn: ['w', 'w', 'w'] },
      { id: 'w' },
    ];
    expect(taskReadyFrontier(tasks, ['w'])).toEqual(['z']);
  });

  /* ─── duplicate task IDs throw ─── */
  it('throws DuplicateTaskIdError on duplicate task IDs', () => {
    const tasks = [
      { id: 'a' },
      { id: 'a' },
      { id: 'b' },
    ];
    expect(() => taskReadyFrontier(tasks, [])).toThrow(DuplicateTaskIdError);
  });

  /* ─── stable ordering ─── */
  it('preserves original task order in output', () => {
    const tasks = [
      { id: 'first' },
      { id: 'second', dependsOn: ['first'] },
      { id: 'third' },
      { id: 'fourth', dependsOn: ['third'] },
    ];
    expect(taskReadyFrontier(tasks, [])).toEqual(['first', 'third']);
  });

  /* ─── frozen inputs ─── */
  it('does not mutate inputs', () => {
    const tasks = [
      { id: 'i' },
      { id: 'j', dependsOn: ['i'] },
    ];
    const completed = ['i'];
    taskReadyFrontier(tasks, completed);
    expect((tasks[1] as any).dependsOn).toEqual(['i']);
    expect(completed).toEqual(['i']);
  });
});
