export interface SupersededPair {
  open: number;
  openTitle: string;
  openState: string;
  mergedBy: number;
  mergedTitle: string;
  jobId: string;
}

export interface SupersededView {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'unavailable';
  openDirty: number;
  pairs: SupersededPair[];
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const prNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function parseSuperseded(raw: unknown): SupersededView {
  const data = record(raw);
  const unavailable: SupersededView = { v: 1, generatedAt: '', source: 'unavailable', openDirty: 0, pairs: [] };
  if (data.v !== 1 || typeof data.generatedAt !== 'string' || (data.source !== 'ok' && data.source !== 'unavailable') ||
      typeof data.openDirty !== 'number' || !Number.isSafeInteger(data.openDirty) || data.openDirty < 0 || !Array.isArray(data.pairs)) return unavailable;
  if (data.source === 'unavailable') return { ...unavailable, generatedAt: data.generatedAt };
  const seen = new Set<number>();
  const pairs: SupersededPair[] = data.pairs.flatMap(rawPair => {
    const pair = record(rawPair);
    if (!prNumber(pair.open) || !prNumber(pair.mergedBy) || seen.has(pair.open) || typeof pair.openTitle !== 'string' ||
        typeof pair.openState !== 'string' || typeof pair.mergedTitle !== 'string' || typeof pair.jobId !== 'string') return [];
    seen.add(pair.open);
    return [{ open: pair.open, openTitle: pair.openTitle, openState: pair.openState, mergedBy: pair.mergedBy, mergedTitle: pair.mergedTitle, jobId: pair.jobId }];
  });
  return { v: 1, generatedAt: data.generatedAt, source: 'ok', openDirty: data.openDirty, pairs };
}

export function supersededLabel(pair: SupersededPair): string {
  return `superseded by #${pair.mergedBy} (merged)`;
}

export function supersededCounts(view: SupersededView, openDirtyFromBacklog: number | null): { superseded: number; liveDirty: number | null } {
  const pairs = view.source === 'ok' ? view.pairs : [];
  return { superseded: pairs.length, liveDirty: openDirtyFromBacklog === null ? null : openDirtyFromBacklog - pairs.filter(pair => pair.openState === 'DIRTY').length };
}
