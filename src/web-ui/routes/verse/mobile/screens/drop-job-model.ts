// Browser copies: the core writer imports node:fs. Contract parity is tested.
export const DROP_JOB_LANES = ['claude', 'codex-personal', 'devin', 'codex-local'] as const;
export const DROP_JOB_TIERS = ['frontier', 'work', 'mid', 'fast'] as const;
export const DROP_JOB_ID = /^[A-Z0-9]{3,40}$/;
export const DROP_JOB_MAX_FILE_BYTES = 8000;
export interface DropJobPayload { id: string; lane: string; tier: string; body: string }
export const dropJobHeader = (lane: string, tier: string) => `#job repo=phantom lane=${lane} tier=${tier}`;
// The API writer adds its routing header, blank line and final newline too.
export const dropJobBytes = (p: DropJobPayload) => new TextEncoder().encode(`${dropJobHeader(p.lane, p.tier)}\n\n${p.body}\n`).length;
export function validateDropJob(payload: DropJobPayload): { ok: true; payload: DropJobPayload } | { ok: false; reason: string } {
  if (!DROP_JOB_ID.test(payload.id)) return { ok: false, reason: 'id-shape' };
  if (!DROP_JOB_LANES.some(lane => lane === payload.lane)) return { ok: false, reason: 'lane' };
  if (!DROP_JOB_TIERS.some(tier => tier === payload.tier)) return { ok: false, reason: 'tier' };
  if (!payload.body.trim()) return { ok: false, reason: 'empty-body' };
  if (/(?![\n\t])\p{Cc}/u.test(payload.body)) return { ok: false, reason: 'control-characters' };
  if (/\.github\/|\/\.codex|auth\.json|CODEOWNERS/.test(payload.body)) return { ok: false, reason: 'denied-content' };
  if (dropJobBytes(payload) > DROP_JOB_MAX_FILE_BYTES) return { ok: false, reason: 'too-large' };
  return { ok: true, payload };
}
export function suggestId(goal: string, nowMs: number): string {
  const date = new Date(nowMs);
  const words = goal.trim().split(/\s+/).slice(0, 5).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${(words || 'JOB').slice(0, 16).padEnd(2, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}
