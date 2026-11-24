import type { Tone } from '../../../components/primitives/StatusBadge.js';

export const WORK_TRACE_MAX_IDS = 20;
export type WorkState = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED';
export interface WorkTraceItem {
  id: string; state: WorkState; asOf: string; source: string; missing: string[];
  owner: string | null; claimReceipt: string | null; inbox: string; claims: string;
}
export interface WorkTrace { v: 1; authority: 'none'; generatedAt: string; items: WorkTraceItem[] }
export interface WorkStateChip { label: string; tone: Tone; title: string }

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const states: readonly string[] = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];
const nullableText = (x: unknown) => x === null || typeof x === 'string';

/** Bad shape → null. Never trusts a field it did not check. */
export function parseWorkTrace(x: unknown): WorkTrace | null {
  if (!record(x) || x.v !== 1 || x.authority !== 'none' || typeof x.generatedAt !== 'string' || !Array.isArray(x.items)) return null;
  const ok = x.items.every(i => record(i) && typeof i.id === 'string' && typeof i.state === 'string' && states.includes(i.state)
    && typeof i.asOf === 'string' && typeof i.source === 'string'
    && Array.isArray(i.missing) && i.missing.every(m => typeof m === 'string')
    && nullableText(i.owner) && nullableText(i.claimReceipt) && typeof i.inbox === 'string' && typeof i.claims === 'string');
  return ok ? x as unknown as WorkTrace : null;
}

const TONES: Record<WorkState, Tone> = { RECEIVED: 'neutral', ASSIGNED: 'info', RUNNING: 'running', BLOCKED: 'danger', VERIFIED: 'success' };

export function unknownWorkChip(reason: string): WorkStateChip {
  return { label: 'state unknown', tone: 'warning', title: reason };
}

/** Shows what the classifier returned. The only deviation is a downgrade: an ASSIGNED item with no claim
 * receipt is not shown as assigned. A state is never upgraded here. */
export function workStateChip(item: WorkTraceItem | undefined): WorkStateChip {
  if (!item) return unknownWorkChip('No work-trace reading for this message.');
  if (item.state === 'ASSIGNED' && !item.claimReceipt?.trim()) return unknownWorkChip(`Reported ASSIGNED without a claim receipt, so not shown as assigned · as of ${item.asOf}`);
  const parts = [`${item.state} · as of ${item.asOf}`];
  if (item.owner) parts.push(`owner ${item.owner}`);
  if (item.claimReceipt) parts.push(`claim ${item.claimReceipt}`);
  if (item.missing.length) parts.push(`missing: ${item.missing.join(', ')}`);
  return { label: item.state, tone: TONES[item.state], title: parts.join(' · ') };
}

/** The bus feed carries no structured id, so a request row names its message as `id=<id>`; no match → null (state unknown). */
export function requestMessageId(text: string): string | null {
  const m = /\bid[=:]\s*([^\s,;)]{1,200})/i.exec(text);
  return m ? m[1]! : null;
}
export function workTraceUrl(ids: readonly string[]): string {
  return `/api/verse/fleet/control/work-trace?${ids.map(id => `id=${encodeURIComponent(id)}`).join('&')}`;
}
