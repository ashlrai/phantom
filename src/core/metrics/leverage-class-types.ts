/** How much a merged PR moves the fleet or the product. `unknown` is shown as unknown, never guessed. */
export const MERGE_CLASSES = ['fleet', 'product', 'docs', 'filler', 'unknown'] as const;
export type MergeClass = typeof MERGE_CLASSES[number];
