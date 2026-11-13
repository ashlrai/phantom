/**
 * The "Phantom status" reply body: five fixed lines built from plain data.
 * Pure: no I/O, no clock. Every line is a fact or the word "unknown" with its
 * reason; an unreadable source is never rendered as 0 or "none".
 */
import { scrubSecrets } from '../util/scrub.js';

export type Fact<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface StatusDigestLane { lane: string; running: number; target: number; held: boolean; heldReason: string | null }

export interface StatusDigestInput {
  installedVersion: Fact<string>;
  /** Newest published release that carries the desktop asset. */
  publishedVersion: Fact<string>;
  /** Null when either version is unknown. */
  updatePending: boolean | null;
  mergesLastHour: Fact<number>;
  mergesLast24h: Fact<number>;
  lanes: Fact<StatusDigestLane[]>;
  /** Hard-limit asks only (secrets, money, outside sends, data destruction). */
  needsMason: Fact<number>;
  topP0: Fact<{ text: string; ageMs: number | null } | null>;
}

export const TOP_P0_MAX_CHARS = 120;

const unknown = (reason: string): string => `unknown (${reason.replace(/\s+/g, ' ').trim() || 'no reason recorded'})`;
const show = <T>(fact: Fact<T>, render: (value: T) => string): string => fact.ok ? render(fact.value) : unknown(fact.reason);

function age(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'age unknown';
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function truncateP0(text: string): string {
  const clean = scrubSecrets(text).replace(/\s+/g, ' ').trim();
  return clean.length > TOP_P0_MAX_CHARS ? `${clean.slice(0, TOP_P0_MAX_CHARS - 1)}…` : clean;
}

export function buildStatusDigest(input: StatusDigestInput): string[] {
  const pending = input.updatePending === null ? '' : input.updatePending ? ' · update pending' : ' · up to date';
  const lanes = show(input.lanes, rows => {
    const live = rows.filter(row => !row.held && row.target > 0).map(row => `${row.lane} ${row.running}/${row.target}`);
    const held = rows.filter(row => row.held).map(row => `${row.lane} (${row.heldReason?.replace(/\s+/g, ' ').trim() || 'no reason recorded'})`);
    const parts = [live.join(', '), held.length ? `held: ${held.join(', ')}` : ''].filter(Boolean);
    return parts.join(' · ') || 'no lane has a target';
  });
  return [
    `App: installed ${show(input.installedVersion, v => v)} · published ${show(input.publishedVersion, v => v)}${pending}`,
    `Merges: ${show(input.mergesLastHour, n => `${n} in the last hour`)} · ${show(input.mergesLast24h, n => `${n} in the last 24h`)}`,
    `Lanes: ${lanes}`,
    `Needs Mason: ${show(input.needsMason, n => n === 0 ? 'none waiting' : `${n} hard-limit ask${n === 1 ? '' : 's'} waiting`)}`,
    `Top P0: ${show(input.topP0, p0 => p0 ? `${truncateP0(p0.text)} (${age(p0.ageMs)})` : 'none in the inbox')}`,
  ];
}
