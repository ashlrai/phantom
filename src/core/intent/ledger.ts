/** Compatibility entry point for the recovered intent ledger operations. */
export { listIntents, getIntent } from './read.js';
export { addIntent, updateIntent } from './edit.js';
export type { IntentAddInput, IntentUpdateInput } from './edit.js';
export { importIntentFiles } from './import.js';
export { isStale, summarize, intentSummary } from './summary.js';
export type { IntentSummary } from './summary.js';
export { linkMergedPull, markShipped } from './evidence.js';
export type { MergedPullNote, ShippedReleaseNote } from './evidence.js';
export { noteShippedRelease } from './release.js';
export { sweepStale } from './sweep.js';
export type { SweepRow } from './sweep.js';
