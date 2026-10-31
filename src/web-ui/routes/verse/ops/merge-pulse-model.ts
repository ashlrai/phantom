export interface PulseInput {
  generatedAt: string;
  lastTick: string | null;
  paused: boolean | null;
  claudeLane: string | null;
  workers: Array<{ ageSeconds: number | null }>;
  mergesLastHour: { count: number | null };
  events: Array<{ at: string; kind: string }>;
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const nullableNumber = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

export function readPulseInput(value: unknown): PulseInput | null {
  if (!record(value) || typeof value.generatedAt !== 'string' || !nullableString(value.lastTick)
    || !(value.paused === null || typeof value.paused === 'boolean') || !nullableString(value.claudeLane)
    || !Array.isArray(value.workers) || !value.workers.every(w => record(w) && nullableNumber(w.ageSeconds))
    || !record(value.mergesLastHour) || !nullableNumber(value.mergesLastHour.count)
    || !Array.isArray(value.events) || !value.events.every(e => record(e) && typeof e.at === 'string' && typeof e.kind === 'string')) return null;
  return value as unknown as PulseInput;
}

export const STALL_MS = 30 * 60_000;
export type PulseState = 'incident' | 'paused' | 'calm' | 'unknown';
export interface Pulse { state: PulseState; headline: string; detail: string | null; lastStartAgoMs: number | null; merged: number | null }

export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes < 1 ? '< 1 min' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function derivePulse(input: PulseInput | null, nowMs: number): Pulse {
  let lastStartAgoMs: number | null = null;
  const merged = input?.mergesLastHour.count ?? null;
  for (const worker of input?.workers ?? []) {
    if (worker.ageSeconds !== null) lastStartAgoMs = Math.min(lastStartAgoMs ?? Infinity, worker.ageSeconds * 1000);
  }
  if (input && input.workers.length === 0) {
    for (const event of input.events) {
      const at = Date.parse(event.at);
      if (/launch|start/i.test(event.kind) && Number.isFinite(at)) lastStartAgoMs = Math.min(lastStartAgoMs ?? Infinity, Math.max(0, nowMs - at));
    }
  }
  const base = { lastStartAgoMs, merged, detail: null };
  if (input?.paused === true) return { ...base, state: 'paused', headline: 'Fleet paused', detail: /down/i.test(input.claudeLane ?? '') ? `Claude lane: ${input.claudeLane}` : null };
  if (!input || (lastStartAgoMs === null && merged === null)) return { ...base, state: 'unknown', headline: '' };
  if ((lastStartAgoMs === null || lastStartAgoMs >= STALL_MS) && merged === 0) return {
    ...base, state: 'incident',
    headline: lastStartAgoMs === null ? 'Incident: nothing started yet and nothing merged in the last hour' : `Incident: nothing started for ${formatDuration(lastStartAgoMs)} and nothing merged in the last hour`,
    detail: "Mason's rule: 30 minutes without a start or a merge means dispatch is stuck. Check Live runs and the leaders.",
  };
  const start = lastStartAgoMs === null ? 'Nothing started yet' : `Last start ${formatDuration(lastStartAgoMs)} ago`;
  const merges = merged === null ? 'merges unknown' : merged === 0 ? 'no merges yet' : `${merged} merged in the last hour`;
  return { ...base, state: 'calm', headline: `${start} · ${merges}` };
}
