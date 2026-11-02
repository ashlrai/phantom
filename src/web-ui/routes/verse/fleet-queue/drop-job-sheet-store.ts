/**
 * fleet-queue/drop-job-sheet-store.ts — the tiny cross-surface open store
 * for the New job sheet (interject-dialog-store.ts is the pattern). Any row
 * anywhere can ask the queue pane to open its sheet with a seed draft; the
 * pane is always mounted, so the request just sits in module state until
 * useDropJobSheetRequest delivers it.
 *
 * A request never overwrites an unsent draft body in sessionStorage: when
 * one exists the sheet opens with the existing draft and the caller gets
 * 'kept' so it can say why the seed was not applied.
 */
import { useSyncExternalStore } from 'react';
import type { DropJobDraft } from './drop-job-model.js';

export const dropJobDraftStorageKey = 'phantom.drop-job-draft.v1';

export interface DropJobSheetRequest { seed: DropJobDraft | null }

let request: DropJobSheetRequest | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => request;

/** The persisted draft, or null when absent or unreadable (storage may throw). */
export function readDropJobDraftStorage(): DropJobDraft | null {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(dropJobDraftStorageKey) ?? 'null');
    if (raw && typeof raw === 'object'
      && ['id', 'lane', 'tier', 'body'].every(key => typeof (raw as Record<string, unknown>)[key] === 'string')) {
      return raw as DropJobDraft;
    }
  } catch { /* Storage may be unavailable. */ }
  return null;
}

export function openDropJobSheet(seed: DropJobDraft): 'seeded' | 'kept' {
  const kept = (readDropJobDraftStorage()?.body ?? '').trim() !== '';
  request = { seed: kept ? null : seed };
  for (const listener of listeners) listener();
  return kept ? 'kept' : 'seeded';
}

export function useDropJobSheetRequest(): DropJobSheetRequest | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

export function resetDropJobSheetForTest(): void {
  request = null;
}
