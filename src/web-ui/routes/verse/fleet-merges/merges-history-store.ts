import { useSyncExternalStore } from 'react';

export interface MergeSample { generatedAt: string; at: number; count: number }
export interface MergeSummary { spark: string; first: number; last: number; spanMinutes: number }

export const MAX_SAMPLES = 180;
export const MIN_GAP_MS = 60_000;
const glyphs = '▁▂▃▄▅▆▇█';
const listeners = new Set<() => void>();
let history: readonly MergeSample[] = [];
let version = 0;

function changed() {
  version++;
  for (const listener of listeners) listener();
}

export function recordMergeSample(generatedAt: string, count: number | null, nowMs = Date.now()): void {
  if (!generatedAt || count === null || !Number.isSafeInteger(count) || count < 0 || !Number.isFinite(nowMs)) return;
  const last = history[history.length - 1];
  if ((last && nowMs - last.at < MIN_GAP_MS) || history.some(sample => sample.generatedAt === generatedAt)) return;
  history = [...history, { generatedAt, at: nowMs, count }].slice(-MAX_SAMPLES);
  changed();
}

export function mergeHistory(): readonly MergeSample[] {
  return history;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMergeHistory(): readonly MergeSample[] {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return mergeHistory();
}

export function summariseMerges(samples: readonly MergeSample[], _nowMs: number): MergeSummary | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const max = Math.max(...samples.map(sample => sample.count));
  const spark = samples.map(sample => glyphs[max === 0 ? 0 : Math.round(sample.count / max * 7)]).join('');
  return { spark, first: first.count, last: last.count, spanMinutes: Math.floor((last.at - first.at) / 60_000) };
}

export function resetMergeHistory(): void {
  if (history.length === 0) return;
  history = [];
  changed();
}
