import { useSyncExternalStore } from 'react';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiPost } from '../../../data/client.js';
import { VerseMutationLockedError } from '../verse-queries.js';

const INBOX_PATH = '/api/verse/fleet/runs/inbox';
let open = false;
let prefill: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const snapshot = () => open;
function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}
export function openInterjectDialog(options?: { prefill?: string }): void { prefill = options?.prefill ?? null; setOpen(true); }
export function closeInterjectDialog(): void { prefill = null; setOpen(false); }
export function takeInterjectPrefill(): string | null { const value = prefill; prefill = null; return value; }
export function useInterjectDialogOpen(): boolean { return useSyncExternalStore(subscribe, snapshot, () => false); }

export async function postInterjection(text: string): Promise<string> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<{ ok?: boolean; at?: string }>(INBOX_PATH, { text, source: 'Phantom desktop' }, token);
  if (!result || result.ok !== true || typeof result.at !== 'string' || !Number.isFinite(Date.parse(result.at))) {
    throw new Error('The message could not be confirmed.');
  }
  touchMutationHold();
  return result.at;
}
