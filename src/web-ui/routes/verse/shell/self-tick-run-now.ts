/**
 * routes/verse/shell/self-tick-run-now.ts — the Needs-you self-tick row's
 * "Run now" action: one POST to /api/verse/fleet/self-tick with {apply:true}
 * under the session's mutation token (the same x-ashlr-token header apiPost
 * sends on every verse mutation), folded into a small view the row can print.
 * fetch is injected so tests never touch the network.
 */
export const SELF_TICK_RUN_PATH = '/api/verse/fleet/self-tick';

export interface SelfTickRunNowView {
  /**
   * ran-ok: every step exited 0. ran-failed: the pass ran and at least one
   * step failed. busy: another pass holds the lock or a POST is already in
   * flight. error: the request never produced a report (network, refusal,
   * malformed answer).
   */
  outcome: 'ran-ok' | 'ran-failed' | 'busy' | 'error';
  /** Step names the run reported failed; empty on ok, busy and error. */
  failedSteps: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Step names a self-tick report marked failed — defensive, like the file read. */
function failedStepsOf(report: Record<string, unknown>): string[] {
  const steps = report['steps'];
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) =>
    object(step) && step['state'] === 'failed' && typeof step['step'] === 'string' ? [step['step']] : []);
}

export async function runSelfTickNow(fetchImpl: typeof fetch, token: string): Promise<SelfTickRunNowView> {
  let response: Response;
  try {
    response = await fetchImpl(SELF_TICK_RUN_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-ashlr-token': token },
      body: JSON.stringify({ apply: true }),
    });
  } catch {
    return { outcome: 'error', failedSteps: [] };
  }
  // A second POST while a run is in flight answers 409 {code:'busy'}.
  if (response.status === 409) return { outcome: 'busy', failedSteps: [] };
  if (!response.ok) return { outcome: 'error', failedSteps: [] };
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { outcome: 'error', failedSteps: [] };
  }
  if (!object(data) || data['v'] !== 1 || typeof data['exitCode'] !== 'number' || !object(data['report'])) {
    return { outcome: 'error', failedSteps: [] };
  }
  const report = data['report'];
  const failedSteps = failedStepsOf(report);
  // Lock contention is not a failure: the server answered 200 with a busy report.
  if (report['state'] === 'busy') return { outcome: 'busy', failedSteps };
  if (report['state'] !== 'ran') return { outcome: 'error', failedSteps: [] };
  return {
    outcome: data['exitCode'] === 0 && failedSteps.length === 0 ? 'ran-ok' : 'ran-failed',
    failedSteps,
  };
}
