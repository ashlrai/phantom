import type { FunnelStage } from '../../../components/charts/Funnel.js';

export interface FunnelInput {
  v: 1;
  generatedAt: string;
  workers: Array<{ job: string }>;
  publishesLastHour: Array<{ job: string; lane: string | null; url: string | null; at: string }>;
  mergesLastHour: { count: number | null; items: Array<{ repo: string; number: number; title: string }> };
  sources: { merges: string };
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function readFunnelInput(value: unknown): FunnelInput | null {
  if (!record(value) || value.v !== 1 || typeof value.generatedAt !== 'string'
    || !Array.isArray(value.workers) || !value.workers.every(w => record(w) && typeof w.job === 'string')
    || !Array.isArray(value.publishesLastHour) || !value.publishesLastHour.every(p => record(p)
      && typeof p.job === 'string' && p.job.length > 0 && nullableString(p.lane) && nullableString(p.url) && typeof p.at === 'string')
    || !record(value.mergesLastHour) || !(value.mergesLastHour.count === null || count(value.mergesLastHour.count))
    || !Array.isArray(value.mergesLastHour.items) || !value.mergesLastHour.items.every(m => record(m)
      && typeof m.repo === 'string' && count(m.number) && typeof m.title === 'string')
    || !record(value.sources) || typeof value.sources.merges !== 'string') return null;
  return value as unknown as FunnelInput;
}

export function funnelStages(input: FunnelInput): FunnelStage[] {
  return [
    { id: 'running', label: 'Workers running', value: input.workers.length },
    { id: 'published', label: 'PRs published', value: input.publishesLastHour.length },
    { id: 'merged', label: 'Merged', value: input.mergesLastHour.count },
  ];
}

export function joinPublishes(input: FunnelInput): Array<FunnelInput['publishesLastHour'][number] & { state: 'merged' | 'waiting'; number: number | null }> {
  return input.publishesLastHour.map(publish => {
    const match = publish.url?.match(/\/pull\/(\d+)$/);
    const number = match ? Number(match[1]) : null;
    const merged = input.mergesLastHour.items.find(item => item.title.includes(publish.job) || (number !== null && item.number === number));
    return { ...publish, state: merged ? 'merged' as const : 'waiting' as const, number: number ?? merged?.number ?? null };
  }).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

export function funnelCaveat(input: FunnelInput): string | null {
  return input.sources.merges !== 'healthy' ? `Merge count from GitHub is ${input.sources.merges}; waiting rows may already be merged.` : null;
}

export function mergeRateText(published: number, merged: number | null): string {
  return merged === null ? 'merged count unknown' : published === 0 ? 'no publishes yet' : `${merged} of ${published} published merged`;
}
