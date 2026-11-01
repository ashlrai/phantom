export const lanes = ['claude', 'codex-personal', 'devin', 'codex-local'] as const;
export const tiers = ['frontier', 'work', 'mid', 'fast'] as const;
export interface DropJobDraft { id: string; lane: string; tier: string; body: string }
export interface DropJobItem { id: string; lane: string; tier: string; title: string; bytes: number; ageSeconds: number }
// Include the planner routing header and its separating blank line in the budget.
export function draftBytes(draft: DropJobDraft): number {
  return new TextEncoder().encode(`# RQ-PHX-${draft.id} lane=${draft.lane} tier=${draft.tier}\n\n${draft.body}`).length;
}
export function validateDraft(draft: DropJobDraft): { ok: true; bytes: number } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (!/^[A-Z0-9]{3,40}$/.test(draft.id)) reasons.push('Id must contain 3 to 40 uppercase letters and digits, without RQ-PHX-.');
  if (!lanes.some(lane => lane === draft.lane)) reasons.push('Choose an allowed lane.');
  if (!tiers.some(tier => tier === draft.tier)) reasons.push('Choose an allowed tier.');
  if (!draft.body.trim()) reasons.push('Body must not be empty.');
  const bytes = draftBytes(draft);
  if (bytes > 8000) reasons.push('Body and header must fit within 8000 bytes.');
  return reasons.length ? { ok: false, reasons } : { ok: true, bytes };
}
export function suggestId(body: string, now: Date | number): string {
  const words = body.trim().split(/\s+/).slice(0, 5).map(word => word.toUpperCase().replace(/[^A-Z0-9]/g, '')).join('');
  return `${(words || 'JOB').slice(0, 38)}${String(new Date(now).getDate()).padStart(2, '0')}`;
}
export function outcomeText(status: string | number, payload: unknown): string {
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  switch (status) {
    case 201: case 'written': return `Written ${typeof p.file === 'string' ? p.file.split(/[\\/]/).pop() : 'job'} (${p.bytes} bytes)`;
    case 400: case 'invalid': return `Invalid draft: ${Array.isArray(p.reasons) ? p.reasons.filter(reason => typeof reason === 'string').join('; ') : 'Check the draft and try again.'}`;
    case 409: case 'exists': return 'A job with this id already exists';
    case 507: return 'The drop queue is full; wait for space before trying again.';
    case 404: return 'This server was started without --allow-dispatch, so mutations are disabled.';
    case 401: return 'Your session or mutation token was rejected; unlock actions and try again.';
    default: return 'The job could not be written; try again.';
  }
}
export function waitingRows(items: readonly DropJobItem[], _nowMs: number) {
  return [...items].sort((a, b) => b.ageSeconds - a.ageSeconds).map(item => {
    const seconds = Math.max(0, Math.floor(item.ageSeconds));
    const age = seconds < 60 ? `${seconds} s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : `${Math.floor(seconds / 3600)} h ago`;
    return { ...item, age };
  });
}
