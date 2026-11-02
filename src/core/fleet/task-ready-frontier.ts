/**
 * Fleet frontier — task-ready planning query (SPEC-310B ?? "frontier").
 *
 * Pure, side-effect-free query: given a static task graph and a set of
 * completed task IDs, return the IDs that are *ready* to dispatch — i.e.
 * tasks whose every dependency has already completed.
 *
 * Invariants:
 *   - Returns a new array with unique task IDs, preserving input order.
 *   - Unknown dependency IDs block readiness; self / cycle stays blocked.
 *   - Duplicate task IDs throw a static error (ambiguous graph = no dispatch).
 *   - Inputs are never mutated.
 */

/** Thrown when the task list contains duplicate identifiers. */
export class DuplicateTaskIdError extends Error {
  constructor(
    message = 'Duplicate task IDs detected: ambiguous graphs must not be silently dispatched',
  ) {
    super(message);
    this.name = 'DuplicateTaskIdError';
  }
}

/**
 * Return task IDs whose dependencies are all satisfied by *completed*.
 *
 * @param tasks  A readonly list of task definitions (id + optional dependsOn).
 * @param completed  A readonly list of completed task IDs.
 * @returns  A new list of ready task IDs, in original order.
 */
export function taskReadyFrontier(
  tasks: readonly { id: string; dependsOn?: readonly string[] }[],
  completed: readonly string[],
): string[] {
  const completedSet = new Set(completed);
  const seenIds = new Map<string, number>();

  for (let i = 0; i < tasks.length; i++) {
    const prev = seenIds.get(tasks[i].id);
    if (prev !== undefined) {
      throw new DuplicateTaskIdError();
    }
    seenIds.set(tasks[i].id, i);
  }

  const ready: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (completedSet.has(task.id)) continue;
    const deps = task.dependsOn;
    if (deps === undefined || deps.length === 0) {
      ready.push(task.id);
      continue;
    }
    let allDone = true;
    for (let j = 0; j < deps.length; j++) {
      if (!completedSet.has(deps[j])) {
        allDone = false;
        break;
      }
    }
    if (allDone) {
      ready.push(task.id);
    }
  }
  return ready;
}
