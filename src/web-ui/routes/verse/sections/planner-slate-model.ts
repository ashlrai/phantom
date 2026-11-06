import { ApiError, readFailureReason } from '../../../data/client.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import type { PlannerSlateResult, PlannerSlateView } from './planner-slate-queries.js';

type Tone = 'ok' | 'warn' | 'bad';
export function slateSummary(view: PlannerSlateView, _nowMs: number): { headline: string; tone: Tone } {
  if (view.source === 'invalid') return { headline: 'The planner logins file is invalid.', tone: 'bad' };
  if (view.source === 'missing' || view.candidates.length === 0) return { headline: 'No planner logins declared: the fleet cannot plan for itself', tone: 'warn' };
  return { headline: `Planner runs on ${view.candidates.map(candidate => candidate.preset ?? candidate.provider).join(', ')}`, tone: 'ok' };
}
export function presetRows(view: PlannerSlateView) {
  const declared = new Set(view.source === 'ok' ? view.candidates.map(candidate => candidate.preset) : []);
  return view.presets.map(preset => ({ id: preset.id, label: preset.id, checked: declared.has(preset.id),
    enabled: preset.available, note: preset.available ? null : `${preset.provider} not found on this Mac` }));
}
export function briefLine(view: PlannerSlateView, nowMs: number): { text: string; tone: Tone } {
  const brief = view.promptPath && view.promptExists ? { path: view.promptPath, ageSeconds: view.promptAgeSeconds }
    : view.briefCandidates.find(candidate => candidate.exists);
  if (!brief) return { text: 'No brief file found; run a planner brief first', tone: 'warn' };
  const elapsed = Math.max(0, (nowMs - Date.parse(view.generatedAt)) / 1000);
  const age = brief.ageSeconds === null ? null : brief.ageSeconds + (Number.isFinite(elapsed) ? elapsed : 0);
  const ageText = age === null ? 'age unknown' : age < 60 ? 'less than a minute old' : `${Math.floor(age / 60)} min old`;
  return { text: `Brief: ${brief.path}, ${ageText}`, tone: 'ok' };
}
export function saveOutcomeText(result: PlannerSlateResult): string {
  if (result.status === 'written') return 'Planner logins saved.';
  if (result.status === 'unchanged') return 'Planner logins were already up to date.';
  return 'Planner logins were not saved.';
}
export function failureText(error: unknown): string {
  if (error instanceof VerseControlLockedError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 404) return 'Planner login changes are unavailable on this server.';
    if (error.status === 409 && error.detail === 'preset-unavailable') return 'A selected planner login is unavailable on this Mac.';
    if (error.status === 409 && error.detail === 'no-brief') return 'No brief file found; run a planner brief first';
  }
  return readFailureReason(error);
}
