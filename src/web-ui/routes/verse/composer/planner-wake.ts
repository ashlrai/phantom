import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiPost, readFailureReason } from '../../../data/client.js';

const path = '/api/verse/leader/planner/run';
const storageKey = 'verse.planner.lastWakeAt';
let lastWakeAtMs: number | null = null;
let inFlight = false;

type WakeKind = 'started' | 'ran' | 'failed' | 'in-flight' | 'no-slate' | 'locked' | 'unavailable';
type WakeResult = { kind: WakeKind; text: string };
type PassResult = { v: number; provider: string | null; outcome: string; exitCode: number | null; planError?: string | null };
type Dependencies = { post?: typeof apiPost; getToken?: typeof getMutationToken; now?: () => number };

export function getLastPlannerWakeAt(): number | null {
  try {
    const stored = sessionStorage.getItem(storageKey);
    const parsed = stored === null ? NaN : Number(stored);
    if (Number.isFinite(parsed) && parsed >= 0) lastWakeAtMs = Math.max(lastWakeAtMs ?? 0, parsed);
  } catch { /* Storage can be disabled; retain the in-memory interval. */ }
  return lastWakeAtMs;
}

export function decidePlannerWake({ outcome, lastWakeAtMs: lastWake, nowMs, minGapMs = 600_000 }: {
  outcome: 'accepted' | 'duplicate'; lastWakeAtMs: number | null; nowMs: number; minGapMs?: number;
}): 'wake' | 'skip-duplicate' | 'skip-recent' {
  if (outcome === 'duplicate') return 'skip-duplicate';
  return lastWake !== null && nowMs - lastWake < minGapMs ? 'skip-recent' : 'wake';
}

export async function wakePlannerForOrder(text: string, deps: Dependencies = {}): Promise<WakeResult> {
  if (inFlight) return { kind: 'in-flight', text: 'A planner pass is already running; your order is in its inbox' };
  const token = (deps.getToken ?? getMutationToken)();
  if (!token) return { kind: 'locked', text: 'Order saved. Unlock controls to wake the planner.' };
  inFlight = true;
  lastWakeAtMs = (deps.now ?? Date.now)();
  try { sessionStorage.setItem(storageKey, String(lastWakeAtMs)); } catch { /* In-memory protection still applies. */ }
  try {
    // eslint-disable-next-line no-control-regex
    const reason = `inbox order: ${text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 60)}`;
    const result = await (deps.post ?? apiPost)<PassResult>(path, { reason }, token);
    touchMutationHold();
    if (result?.v !== 1 || typeof result.outcome !== 'string') return { kind: 'failed', text: 'The server returned an invalid planner response.' };
    if (result.outcome === 'started') return { kind: 'started', text: 'Planner pass started for your order' };
    if (result.outcome === 'ran' && result.exitCode === 0) return { kind: 'ran', text: `Planner pass ran on ${result.provider ?? 'no provider'} for your order` };
    return { kind: 'failed', text: result.planError || `Planner pass ran on ${result.provider ?? 'no provider'}: ${result.outcome} (exit ${result.exitCode ?? 'none'})` };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { kind: 'unavailable', text: '' };
      if (error.status === 401 || error.status === 403) return { kind: 'locked', text: 'Order saved. Unlock controls to wake the planner.' };
      if (error.status === 409 && error.detail === 'pass-in-flight') return { kind: 'in-flight', text: 'A planner pass is already running; your order is in its inbox' };
      if (error.status === 409 && (error.detail === 'no-slate' || error.detail === 'no-prompt-declared')) {
        return { kind: 'no-slate', text: 'Order saved. The planner has no logins declared: Settings, Planner logins' };
      }
    }
    return { kind: 'failed', text: readFailureReason(error) };
  } finally {
    inFlight = false;
  }
}
