import type { DropJobListItem } from '../../../../core/fleet/drop-job-writer.js';

type DropQueueCard = {
  headline: string;
  tone: 'ok' | 'warn' | 'neutral';
  verdict: string | null;
  rows: Array<{ id: string; laneTier: string; title: string; age: string }>;
};

function isItem(value: unknown): value is DropJobListItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const nullableString = (v: unknown) => v === null || typeof v === 'string';
  return typeof item.id === 'string' && nullableString(item.lane) && nullableString(item.tier)
    && nullableString(item.title) && typeof item.bytes === 'number' && Number.isFinite(item.bytes) && item.bytes >= 0
    && typeof item.ageSeconds === 'number' && Number.isFinite(item.ageSeconds) && item.ageSeconds >= 0;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.round(seconds / 360) / 10} h`;
}

export function dropQueueCard(read: unknown, _nowMs: number): DropQueueCard | null {
  if (!read || typeof read !== 'object' || Array.isArray(read)) return null;
  const value = read as Record<string, unknown>;
  if (value.v !== 1 || !Array.isArray(value.items) || !value.items.every(isItem)) return null;
  const items: DropJobListItem[] = [...value.items].sort((a, b) => b.ageSeconds - a.ageSeconds);
  if (!items.length) return { headline: 'Drop folder empty', tone: 'ok', verdict: 'The ingest sweeps it about every 2 minutes.', rows: [] };
  const oldest = items[0]!;
  const age = formatAge(oldest.ageSeconds);
  return {
    headline: `${items.length} job${items.length === 1 ? '' : 's'} waiting for ingest · oldest ${age}`,
    tone: oldest.ageSeconds >= 600 ? 'warn' : 'ok',
    verdict: oldest.ageSeconds >= 600 ? `Ingest looks stuck: the oldest file has waited ${age}. Check orch-ingest on this Mac.` : null,
    rows: items.slice(0, 8).map((item) => ({
      id: item.id,
      laneTier: item.lane === null || item.tier === null ? '—' : `${item.lane}/${item.tier}`,
      title: item.title || '(untitled)',
      age: formatAge(item.ageSeconds),
    })),
  };
}
