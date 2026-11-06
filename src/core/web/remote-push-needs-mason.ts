/**
 * Diffing for NEEDS-MASON items so a newly written line triggers the same
 * `needs-you` push as the activity feed. The first read is a baseline.
 */
import { sanitizePushDetail } from './remote-push-fleet.js';

export interface PushNeedsMasonItem { id: string; text: string }
export interface NeedsMasonPushIntent { kind: 'needs-you'; count: number; detail: string }

const MAX_ITEMS = 500;
const ID_PATTERN = /^nm-[0-9a-f]{12}$/;

export function validNeedsMasonItems(value: unknown): value is PushNeedsMasonItem[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return typeof entry.id === 'string' && ID_PATTERN.test(entry.id) && typeof entry.text === 'string';
  });
}

/** Items that left the set (resolved) never produce an intent. */
export function diffNeedsMasonForPush(
  previous: ReadonlySet<string> | null,
  current: readonly PushNeedsMasonItem[],
): { intent: NeedsMasonPushIntent | null; ids: Set<string> } {
  const ids = new Set(current.map((item) => item.id));
  if (previous === null) return { intent: null, ids };
  const added = current.filter((item) => !previous.has(item.id));
  if (added.length === 0) return { intent: null, ids };
  return { intent: { kind: 'needs-you', count: added.length, detail: sanitizePushDetail(added[0].text) }, ids };
}
