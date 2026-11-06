import { mergeAge, type MergeAgeInput, type MergeAgePr } from './merge-age.js';

export interface MergeQueueAgeInput extends MergeAgeInput {
  prs: (MergeAgePr & { state?: 'OPEN' | 'MERGED' | 'CLOSED' })[];
}

/** Only active queue entries contribute to current merge latency. */
export function mergeQueueAge(input: MergeQueueAgeInput, now = Date.now()) {
  const inactive = new Set(input.prs.filter(pr => pr.state === 'MERGED' || pr.state === 'CLOSED').map(pr => pr.number));
  return { ...mergeAge({ prs: input.prs, queue: input.queue.filter(entry => !inactive.has(entry.number)) }, now),
    schema: 'fleet.merge-queue-age.v1' as const };
}
