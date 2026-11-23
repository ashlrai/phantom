import { composeDropJobFile, validateDropJob as validateContract } from '../../../../../core/fleet/drop-job-contract.js';
export { DROP_JOB_LANES, DROP_JOB_TIERS, DROP_JOB_ID, DROP_JOB_MAX_FILE_BYTES, dropJobHeader } from '../../../../../core/fleet/drop-job-contract.js';
export interface DropJobPayload { id: string; repo?: string; lane: string; tier: string; body: string }
export const dropJobBytes = (p: DropJobPayload) => new TextEncoder().encode(composeDropJobFile(p)).length;
export function validateDropJob(payload: DropJobPayload): { ok: true; payload: DropJobPayload } | { ok: false; reason: string } {
  const result = validateContract(payload);
  return result.ok ? { ok: true, payload } : { ok: false, reason: result.reasons[0]! };
}
export function suggestId(goal: string, nowMs: number): string {
  const date = new Date(nowMs);
  const words = goal.trim().split(/\s+/).slice(0, 5).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${(words || 'JOB').slice(0, 16).padEnd(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}
