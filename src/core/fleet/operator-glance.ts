/**
 * One typed glance of the fleet, shared by the phone, Telegram, email, and agents.
 *
 * Inbound text is an order to log or a plain-language status ask. It is never
 * a shell command. Replies stay short. Counts stay null when a source did not
 * report them.
 */

import type { GuardianGlanceRow } from './guardian-glance.js';

export interface OperatorGlance {
  v: 1;
  at: string;
  running: number | null;
  target: number | null;
  usagePct: number | null;
  resetsAt: string | null;
  mergesToday: number | null;
  main: 'up' | 'down' | 'unknown';
  incidents: string[];
  /** Per-repo main-guardian chips for the desktop; absent when no status table. */
  guardian?: GuardianGlanceRow[];
}

export interface OperatorLane {
  running: number | null;
  target: number | null;
  merged24h?: number | null;
}

export interface OperatorGlanceInput {
  now: Date;
  lanes?: readonly OperatorLane[];
  switches?: readonly string[];
  claudeLane?: string | null;
  usagePct?: number | null;
  resetsAt?: string | null;
  /** Newest supervisor/status-*.md text, or null when that folder is absent. */
  mainText?: string | null;
  /** leader/INCIDENTS.md text, or null when the file is absent. */
  incidentText?: string | null;
}

const STATUS_ASK = /^(?:\/status(?:@\w+)?|status|glance|fleet status|what(?:'s| is|s) up|what(?:'s| is) happening|what(?:'s| is) running|how(?:'s| is|s) (?:the fleet|it going)|how are (?:we|things))\??$/i;

const RATE_LIMIT = 500;
const RATE_WINDOW_MS = 10 * 60_000;
const buckets = new Map<string, number[]>();

export function resetOperatorRateForTest(): void {
  buckets.clear();
}

/** Five hundred messages per ten minutes per sender. Excess is not an order. */
export function allowOperatorMessage(key: string, nowMs: number): boolean {
  const prev = (buckets.get(key) ?? []).filter((at) => nowMs - at < RATE_WINDOW_MS);
  if (prev.length >= RATE_LIMIT) {
    buckets.set(key, prev);
    return false;
  }
  prev.push(nowMs);
  buckets.set(key, prev);
  return true;
}

/** The whole message is a status ask. Anything longer is an order. */
export function isOperatorStatusAsk(text: string): boolean {
  return STATUS_ASK.test(text.trim());
}

function finitePct(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value);
}

function count(values: readonly (number | null | undefined)[]): number | null {
  if (values.length === 0 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null;
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return Number.isSafeInteger(total) ? total : null;
}

function clip(text: string): string {
  let flat = '';
  for (const char of text.replace(/\s+/g, ' ').trim()) {
    if (char.charCodeAt(0) > 31) flat += char;
  }
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** `main: green` / `main: down` from a supervisor status note. */
export function parseMainHealth(text: string | null | undefined): OperatorGlance['main'] {
  if (!text) return 'unknown';
  const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => /^main\b/i.test(item));
  if (!line) return 'unknown';
  const value = line.split(':').slice(1).join(':').trim().toLowerCase();
  if (/^(up|green|healthy|ok|pass|passing)\b/.test(value)) return 'up';
  if (/^(down|red|fail|failing|broken)\b/.test(value)) return 'down';
  return 'unknown';
}

/** Open incident lines. Resolved and checked items stay off the glance. */
export function parseIncidentLines(text: string | null | undefined): string[] {
  if (!text) return [];
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, '');
    if (!line || line.startsWith('#') || /\bresolved\b/i.test(line) || /^\[[xX]\]/.test(line)) continue;
    const clean = clip(line.replace(/^\[[ ]\]\s+/, ''));
    if (clean && !lines.includes(clean)) lines.push(clean);
    if (lines.length === 3) break;
  }
  return lines;
}

export function buildOperatorGlance(input: OperatorGlanceInput): OperatorGlance {
  const lanes = input.lanes ?? [];
  const incidents = parseIncidentLines(input.incidentText);
  if (input.claudeLane && /^down\b/i.test(input.claudeLane) && !incidents.includes('Claude lane is down')) {
    incidents.push('Claude lane is down');
  }
  if ((input.switches ?? []).some((item) => item === 'HOLD' || item.endsWith('HOLD')) && !incidents.includes('HOLD is on')) {
    incidents.push('HOLD is on');
  }
  const merged = lanes.map((lane) => lane.merged24h).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return {
    v: 1,
    at: input.now.toISOString(),
    running: count(lanes.map((lane) => lane.running)),
    target: count(lanes.map((lane) => lane.target)),
    usagePct: finitePct(input.usagePct),
    resetsAt: typeof input.resetsAt === 'string' && Number.isFinite(Date.parse(input.resetsAt)) ? new Date(Date.parse(input.resetsAt)).toISOString() : null,
    mergesToday: merged.length === 0 ? null : count(merged),
    main: parseMainHealth(input.mainText),
    incidents: incidents.slice(0, 3),
  };
}

function resetPhrase(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const hours = Math.round((at - nowMs) / 3_600_000);
  if (hours <= 0) return ', reset due';
  if (hours < 48) return `, resets in ${hours} h`;
  return `, resets in ${Math.round(hours / 24)} d`;
}

/** The same short text Telegram, email, and the phone show. */
export function formatOperatorGlance(glance: OperatorGlance, nowMs = Date.now()): string {
  const running = glance.running === null || glance.target === null
    ? 'Running unknown.'
    : `Running ${glance.running} of ${glance.target}.`;
  const usage = glance.usagePct === null
    ? 'Usage unknown.'
    : `Usage ${glance.usagePct}%${resetPhrase(glance.resetsAt, nowMs)}.`;
  const merges = glance.mergesToday === null ? 'Merges unknown.' : `Merges ${glance.mergesToday} today.`;
  const main = glance.main === 'up' ? 'Main is healthy.' : glance.main === 'down' ? 'Main needs you.' : 'Main health unknown.';
  const incidents = glance.incidents.length > 0 ? `Incidents: ${glance.incidents.join('; ')}.` : '';
  return [running, usage, merges, main, incidents].filter(Boolean).join('\n');
}

export function isOperatorGlance(value: unknown): value is OperatorGlance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as OperatorGlance;
  const num = (item: unknown): boolean => item === null || (typeof item === 'number' && Number.isFinite(item));
  return row.v === 1 && typeof row.at === 'string' && num(row.running) && num(row.target)
    && num(row.usagePct) && (row.resetsAt === null || typeof row.resetsAt === 'string')
    && num(row.mergesToday) && (row.main === 'up' || row.main === 'down' || row.main === 'unknown')
    && Array.isArray(row.incidents) && row.incidents.every((item) => typeof item === 'string');
}

/**
 * Outbound copy. A release and a human-only incident are worth a message.
 * Ordinary merges, completions, and lane holds are not.
 */
export type SignificantKind = 'needs-you' | 'completed' | 'fleet-merged' | 'fleet-lane-held';

export function significantNotice(kind: SignificantKind, detail: string): string | null {
  switch (kind) {
    case 'needs-you':
      return 'Needs you.';
    case 'fleet-merged':
      return /\brelease\b/i.test(detail) ? 'Release shipped.' : null;
    case 'fleet-lane-held':
      return /^claude:\s*down\b/i.test(detail) ? 'Claude lane is down. It needs you.' : null;
    case 'completed':
      return null;
    default: {
      const neverKind: never = kind;
      return neverKind;
    }
  }
}
