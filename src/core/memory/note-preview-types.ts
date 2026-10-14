import type { MemoryContextPack, MemoryExclusionReason, MemoryPackQuery, MemorySnapshot, MemorySourceRef } from './types.js';

/** In-memory caller declarations only. No field establishes review, source authenticity or an authenticated scope. */
export interface MemoryNotePreviewRequest {
  schemaVersion: 1;
  snapshot: MemorySnapshot;
  query: MemoryPackQuery;
  operatorSelection: { eventId: string; text: string; sourceRefs: MemorySourceRef[] };
  authority: false;
}

export interface MemoryNotePreview {
  schemaVersion: 1;
  protocol: 'phantom-memory-note-preview-v1';
  pack: MemoryContextPack | null;
  /** A ready pack can contain another event while the selected note is excluded. */
  noteState: 'included' | 'excluded' | 'unknown' | 'refused';
  noteExclusion: MemoryExclusionReason | null;
  stopReasons: string[];
  reviewBasis: 'caller-declared-not-authenticated';
  scopeBasis: 'caller-declared-not-authenticated';
  sourceAuthenticity: 'unknown';
  historyCompleteness: 'caller-declared';
  actualExecution: 'unknown';
  taskQuality: 'unknown';
  elapsedTime: 'unknown';
  providerCost: 'unknown';
  executionEnabled: false;
  autoInject: false;
  authority: false;
}
