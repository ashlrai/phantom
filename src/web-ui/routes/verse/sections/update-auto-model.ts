import type { ServerObservation } from './update-status-queries.js';
import type { Workers } from '../fleet/workers-card-model.js';

export interface AutoUpdatePolicy { enabled: boolean; quietMinutes: number }
export interface AutoUpdateAttempt { originSha: string; at: number; outcome: string }
const policyKey = 'phantom.self-update.auto';
const attemptKey = 'phantom.self-update.auto.last';
export const autoPolicyEvent = 'phantom-auto-policy';
function validPolicy(v: unknown): v is AutoUpdatePolicy {
  const p = v as AutoUpdatePolicy | null;
  return !!p && typeof p.enabled === 'boolean' && Number.isFinite(p.quietMinutes) && p.quietMinutes >= 10;
}
function read(key: string): unknown { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } }
export function readAutoUpdatePolicy(): AutoUpdatePolicy {
  const p = read(policyKey); return validPolicy(p) ? p : { enabled: false, quietMinutes: 10 };
}
export function writeAutoUpdatePolicy(p: AutoUpdatePolicy): void {
  if (!validPolicy(p)) return;
  try { localStorage.setItem(policyKey, JSON.stringify(p)); } catch { return; }
  window.dispatchEvent(new Event(autoPolicyEvent));
}
export function readAutoUpdateAttempt(): AutoUpdateAttempt | null {
  const a = read(attemptKey) as AutoUpdateAttempt | null;
  return a && typeof a.originSha === 'string' && /^[a-f0-9]{7,64}$/i.test(a.originSha)
    && Number.isFinite(a.at) && a.at >= 0 && typeof a.outcome === 'string' ? a : null;
}
export function writeAutoUpdateAttempt(a: AutoUpdateAttempt): boolean {
  try { localStorage.setItem(attemptKey, JSON.stringify(a)); return true; } catch { return false; }
}
type Reason = 'off' | 'no-status' | 'current' | 'cannot-fast-forward' | 'dirty' | 'applying' | 'native-busy' | 'workers-unknown' | 'workers-active' | 'recent-attempt';
export type AutoDecision = { apply: true; reason: 'ready' } | { apply: false; reason: Reason; lastAttempt?: AutoUpdateAttempt };
export function decideAutoUpdate({ policy, status, workers, nativePhase, lastAttempt, nowMs }: {
  policy: AutoUpdatePolicy; status: ServerObservation | undefined; workers: Workers | null | undefined;
  nativePhase: string | undefined; lastAttempt: AutoUpdateAttempt | null; nowMs: number;
}): AutoDecision {
  const wait = (reason: Reason): AutoDecision => ({ apply: false, reason });
  if (!policy.enabled) return wait('off');
  if (!status || 'kind' in status || status.sourceState !== 'healthy' || status.behind === null || !status.originSha) return wait('no-status');
  if (status.applying) return wait('applying');
  if (status.behind <= 0) return wait('current');
  if (status.dirty === true) return wait('dirty');
  if (status.canFastForward !== true) return wait('cannot-fast-forward');
  if (nativePhase === 'downloading' || nativePhase === 'installing') return wait('native-busy');
  if (!workers || workers.sources.workers !== 'healthy' || workers.workers.some(w => w.ageSeconds === null || !Number.isFinite(w.ageSeconds) || w.ageSeconds < 0)) return wait('workers-unknown');
  if (workers.workers.some(w => w.ageSeconds! < policy.quietMinutes * 60)) return wait('workers-active');
  if (lastAttempt?.originSha === status.originSha && nowMs - lastAttempt.at < 30 * 60_000) return { apply: false, reason: 'recent-attempt', lastAttempt };
  return { apply: true, reason: 'ready' };
}
export function describeAutoDecision(decision: AutoDecision, workers: Workers | null | undefined, nowMs: number): string {
  if (decision.reason === 'off') return 'Auto-update off';
  const last = !decision.apply ? decision.lastAttempt : undefined;
  if (decision.reason === 'recent-attempt' && last) return `Last auto-update ${new Date(Math.min(last.at, nowMs)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} → ${last.originSha.slice(0, 7)} (${last.outcome})`;
  if (decision.reason === 'workers-active' && workers) return `Auto-update on · waiting: ${workers.workers.length} workers running, youngest ${Math.floor(Math.min(...workers.workers.map(w => w.ageSeconds ?? 0)) / 60)} min`;
  return `Auto-update on · ${decision.apply ? 'fleet quiet; updating' : `waiting: ${decision.reason.replaceAll('-', ' ')}`}`;
}
