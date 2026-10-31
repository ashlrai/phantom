export interface PersonalReading {
  usedPct: number | null;
  resetsAt: string | null;
  asOf: string | null;
  sourceState: 'healthy' | 'degraded' | 'missing' | 'not-landed';
}
export interface Reading { at: number; usedPct: number }
const key = 'phantom.codex-personal.readings';
const hour = 3_600_000;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pct = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const dateOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)));

export function readCodexPersonal(raw: unknown): PersonalReading | null {
  if (!record(raw) || !record(raw.sources) || !['healthy', 'degraded', 'missing', 'not-landed'].includes(String(raw.sources.codex)) || !record(raw.codexPersonal)) return null;
  const { usedPct, resetsAt, asOf } = raw.codexPersonal;
  if (!(usedPct === null || pct(usedPct)) || !dateOrNull(resetsAt) || !dateOrNull(asOf)) return null;
  return { usedPct, resetsAt, asOf, sourceState: raw.sources.codex as PersonalReading['sourceState'] };
}

let history: Reading[] | null = null;
export function readings(): Reading[] {
  if (history === null) {
    history = [];
    try {
      const data: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (Array.isArray(data)) history = data.filter((r): r is Reading => record(r) && typeof r.at === 'number' && Number.isFinite(r.at) && pct(r.usedPct)).sort((a, b) => a.at - b.at).slice(-240);
    } catch { /* Storage is optional. */ }
  }
  return history.map(r => ({ ...r }));
}
export function recordReading(reading: PersonalReading, nowMs: number): void {
  // An undated observation cannot be distinguished from the same sample on the next poll.
  if (reading.usedPct === null || reading.asOf === null || !Number.isFinite(nowMs)) return;
  const at = Date.parse(reading.asOf);
  if (!Number.isFinite(at)) return;
  const list = readings();
  if (list.some(r => r.at === at)) return;
  list.push({ at, usedPct: reading.usedPct });
  history = list.sort((a, b) => a.at - b.at).slice(-240);
  try { localStorage.setItem(key, JSON.stringify(history)); } catch { /* Storage is optional. */ }
}
export function resetReadings(): void {
  history = null;
  try { localStorage.removeItem(key); } catch { /* Storage is optional. */ }
}
export function pacePerHour(list: Reading[], nowMs: number, windowMs = 3 * hour): number | null {
  const recent = list.filter(r => r.at >= nowMs - windowMs && r.at <= nowMs).sort((a, b) => a.at - b.at);
  const first = recent[0], last = recent[recent.length - 1];
  if (!first || !last || last.at - first.at < 600_000) return null;
  return (last.usedPct - first.usedPct) / ((last.at - first.at) / hour);
}
export function requiredPacePerHour(usedPct: number | null, resetsAt: string | null, nowMs: number): number | null {
  if (usedPct === null || resetsAt === null) return null;
  const hours = (Date.parse(resetsAt) - nowMs) / hour;
  return Number.isFinite(hours) && hours > 0 ? (100 - usedPct) / hours : null;
}
export function stall(list: Reading[], nowMs: number): number | null {
  const past = list.filter(r => r.at <= nowMs).sort((a, b) => a.at - b.at);
  if (past.length < 2) return null;
  const latest = past[past.length - 1]!;
  const different = [...past].reverse().find(r => r.usedPct !== latest.usedPct);
  return Math.max(0, nowMs - (different?.at ?? past[0]!.at));
}
export function stallText(ms: number | null): string | null {
  if (ms === null || ms < hour) return null;
  const minutes = Math.floor(ms / 60_000);
  return `No movement for ${Math.floor(minutes / 60)} h ${minutes % 60} min: check dispatch.`;
}
export function verdict(pace: number | null, required: number | null): { state: 'ahead' | 'behind' | 'unknown'; text: string } {
  if (pace === null || required === null) return { state: 'unknown', text: 'Pace unknown yet' };
  return pace >= required ? { state: 'ahead', text: 'On pace to use it all before the reset' }
    : { state: 'behind', text: `Behind: needs ${required.toFixed(1)} points/h, running ${pace.toFixed(1)}` };
}
export function runwayHours(usedPct: number | null, pacePerHour: number | null): number | null {
  if (pacePerHour === null || pacePerHour <= 0) return null;
  if (usedPct === null || usedPct >= 100) return 0;
  return (100 - usedPct) / pacePerHour;
}
