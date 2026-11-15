import { leaderFileAge, leaderFileSize } from './library-leader-files-model.js';

export interface Handoff { folder: string; name: string; size: number; modifiedAt: string; preview: string }
export interface HandoffsResponse { v: 1; observedAt: string; handoffs: Handoff[]; state?: 'absent' | 'unavailable' }

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isTime = (x: unknown): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x));

function validHandoff(x: unknown): x is Handoff {
  return record(x) && typeof x.folder === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(x.folder)
    && typeof x.name === 'string' && x.name.length > 0 && x.name !== '..' && !/[/\\\0]/.test(x.name)
    && Number.isSafeInteger(x.size) && (x.size as number) >= 0 && isTime(x.modifiedAt)
    && typeof x.preview === 'string' && x.preview.length <= 240;
}

export function narrowHandoffs(x: unknown): HandoffsResponse | null {
  if (!record(x) || x.v !== 1 || !isTime(x.observedAt) || !Array.isArray(x.handoffs) || !x.handoffs.every(validHandoff)) return null;
  if (x.state !== undefined && x.state !== 'absent' && x.state !== 'unavailable') return null;
  if (x.state !== undefined && x.handoffs.length > 0) return null;
  return x as unknown as HandoffsResponse;
}

export function handoffGroups(rows: readonly Handoff[], now: number) {
  const groups = new Map<string, Handoff[]>();
  for (const row of rows) groups.set(row.folder, [...(groups.get(row.folder) ?? []), row]);
  return [...groups].map(([folder, files]) => {
    const sorted = files.slice().sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    return { folder, newest: Date.parse(sorted[0].modifiedAt), rows: sorted.map((file) => ({
      key: file.name, label: file.name.replace(/\.md$/, ''), age: leaderFileAge(file.modifiedAt, now),
      size: leaderFileSize(file.size), preview: file.preview,
    })) };
  }).sort((a, b) => b.newest - a.newest);
}
