// Contract (lanes, tiers, header, validation) comes from the browser-safe core
// contract module, so the phone and the server cannot drift apart.
import {
  DROP_JOB_ID, DROP_JOB_LANES, DROP_JOB_MAX_FILE_BYTES, DROP_JOB_TIERS, composeDropJobFile, dropJobHeader as coreHeader, validateDropJob as coreValidate,
} from '../../../../../core/fleet/drop-job-contract.js';
export { DROP_JOB_ID, DROP_JOB_LANES, DROP_JOB_MAX_FILE_BYTES, DROP_JOB_TIERS };
/** `repo` is the chosen repo; omitted means phantom. */
export interface DropJobPayload { id: string; lane: string; tier: string; body: string; repo?: string }
export const dropJobHeader = (lane: string, tier: string, repo?: string) => coreHeader(lane, tier, repo);
// The API writer adds its routing header, blank line and final newline too.
export const dropJobBytes = (p: DropJobPayload) => new TextEncoder().encode(composeDropJobFile(p)).length;
export function validateDropJob(payload: DropJobPayload): { ok: true; payload: DropJobPayload } | { ok: false; reason: string } {
  const verdict = coreValidate(payload);
  return verdict.ok ? { ok: true, payload } : { ok: false, reason: verdict.reasons[0]! };
}
export function suggestId(goal: string, nowMs: number): string {
  const date = new Date(nowMs);
  const words = goal.trim().split(/\s+/).slice(0, 5).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${(words || 'JOB').slice(0, 16).padEnd(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}
