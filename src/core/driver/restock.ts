import { generateResearchLines, type ResearchRestockInput } from './research-restock.js';

/** DRIVER-3 integration seam until its queue driver is available.
 * Call under the driver's queue lock with a fresh queue snapshot, then persist
 * the returned queue once. No I/O, credentials, provider calls or dispatch here.
 */
export function restockQueue(input: ResearchRestockInput): { queue: string; added: string[] } {
  const added = generateResearchLines(input);
  if (!added.length) return { queue: input.queue, added };
  const separator = input.queue.length && !input.queue.endsWith('\n') ? '\n' : '';
  return { queue: input.queue + separator + added.join('\n') + '\n', added };
}
