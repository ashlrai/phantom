/**
 * Plain-words readiness note for a pool `phm node join` that registered but
 * reports `ready: false`. The enrollment reply already carries `lanes`,
 * `capacity` and `ready`; this names why the node will sit idle and the one
 * fix, mirroring the standalone join's empty-sign-in note and the worker's
 * `no-local-provider-login` hold. A ready join returns undefined and stays
 * quiet — the same rule the other join notes follow.
 */
import type { NodeCapacity } from './capacity.js';

/** Plain words for every hold `readNodeCapacity` can report; an unknown code
 * (a newer writer) falls back to the code itself rather than a guess. */
const HELD_WORDS: Record<string, string> = {
  'memory-unmeasured': 'memory not measured',
  'memory-pressure': 'memory pressure',
  'disk-unmeasured': 'disk not measured',
  'disk-pressure': 'disk pressure',
  'cpu-unmeasured': 'cpu not measured',
  'cpu-pressure': 'cpu pressure',
  'host-slots-unmeasured': 'host job slots not measured',
  'host-slots-exhausted': 'host job slots exhausted',
};

/** The note for a registered-but-not-ready join, or undefined when ready. */
export function poolJoinReadinessNote(lanes: readonly string[], capacity: NodeCapacity): string | undefined {
  const notes: string[] = [];
  if (lanes.length === 0) {
    notes.push('No codex or claude sign-in and no enabled local model lane was detected on this machine, so the join advertised no capabilities. Sign in to a provider CLI or configure a local model lane, then re-run: phm node join --json');
  }
  if (capacity.held !== null) {
    notes.push(`This machine's capacity is held (${HELD_WORDS[capacity.held] ?? capacity.held}), so it takes no work until the hold clears. Re-check with: phm node measure`);
  }
  return notes.length === 0 ? undefined : notes.join(' ');
}
