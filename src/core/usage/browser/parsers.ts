/**
 * parsers.ts: one visible-text page parser per provider for the browser
 * fallback of RQ-USAGE-LIVE-1 (claude.ai usage, ChatGPT/Codex usage, Devin
 * billing, z.ai, Gemini). Each takes the visible text of the page and returns
 * the binding window as a usage record, or a refusal. A number is reported
 * only when the page states it; nothing is guessed, defaulted or inferred.
 */
import type { UsageResourceUnit } from '../resource-usage-types.js';

export const BROWSER_PROVIDERS = ['claude', 'chatgpt', 'devin', 'zai', 'gemini'] as const;
export type BrowserProvider = (typeof BROWSER_PROVIDERS)[number];

/** The RQ-USAGE-LIVE-1 interface: one JSON record per provider. */
export interface BrowserUsageRecord {
  used: number;
  limit: number;
  unit: UsageResourceUnit;
  reset_at: string | null;
  source: string;
  estimated: boolean;
  observed_at: string;
}

export type ParseRefusal = 'login-required' | 'no-match';

interface Window {
  used: number;
  limit: number;
  unit: UsageResourceUnit;
  resetAt: string | null;
}

interface Spec {
  /** Window headings, in page order is not required. */
  labels: RegExp[];
  /** Unit for "X of Y" counts; percent windows are always percent. */
  countUnit: UsageResourceUnit;
  /** A count only counts when the slice also says this (e.g. ACU). */
  countNeeds?: RegExp;
}

const SPECS: Record<BrowserProvider, Spec> = {
  claude: { labels: [/current session/i, /all models/i, /(?:sonnet|opus)(?: only)?/i], countUnit: 'points' },
  chatgpt: { labels: [/5[- ]?hours?(?: usage)? limit/i, /weekly(?: usage)? limit/i, /code review/i], countUnit: 'points' },
  devin: { labels: [/\bACUs?\b[^\n]{0,20}(?:usage|used|included)|(?:usage|included)[^\n]{0,20}\bACUs?\b/i], countUnit: 'acu', countNeeds: /\bACUs?\b/i },
  zai: { labels: [/(?:5[- ]?hours?|weekly|monthly)\s+(?:usage|quota|limit)/i], countUnit: 'points' },
  gemini: { labels: [/(?:daily |hourly |monthly )?(?:usage )?(?:limit|quota)s?\b/i], countUnit: 'points' },
};

const LOGIN_WALL = /\b(?:log ?in|sign ?in|continue with (?:google|apple|email)|verify you are human)\b/i;

const num = (s: string): number => Number(s.replace(/,/g, ''));

const UNIT_MS: Array<[RegExp, number]> = [
  [/^d/, 86_400_000],
  [/^h/, 3_600_000],
  [/^m/, 60_000],
];

/** "2 hr 14 min", "in 3 days", or an ISO instant. Anything else is null, never a guess. */
export function parseResetAt(raw: string, observedAtMs: number): string | null {
  const text = raw.trim().replace(/^in\s+/i, '');
  const iso = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (iso) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)];
  if (parts.length === 0) return null;
  const rest = text.replace(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi, '').replace(/[\s,.]|and/gi, '');
  if (rest !== '') return null;
  let ms = 0;
  for (const [, n, unit] of parts) {
    const scale = UNIT_MS.find(([re]) => re.test(unit.toLowerCase()))?.[1];
    if (scale === undefined) return null;
    ms += num(n) * scale;
  }
  return ms > 0 ? new Date(observedAtMs + ms).toISOString() : null;
}

function readWindow(slice: string, spec: Spec, observedAtMs: number): Window | null {
  const resetMatch = /resets?\s+([^\n]*)/i.exec(slice);
  const resetAt = resetMatch ? parseResetAt(resetMatch[1], observedAtMs) : null;
  const body = resetMatch ? slice.replace(resetMatch[0], ' ') : slice;
  const used = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i.exec(body);
  if (used && num(used[1]) <= 100) return { used: num(used[1]), limit: 100, unit: 'percent', resetAt };
  const left = /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:remaining|left)/i.exec(body);
  if (left && num(left[1]) <= 100) return { used: Math.round((100 - num(left[1])) * 100) / 100, limit: 100, unit: 'percent', resetAt };
  const count = /(\d[\d,]*(?:\.\d+)?)\s*(?:\/|of)\s*(\d[\d,]*(?:\.\d+)?)/i.exec(body);
  if (count && (!spec.countNeeds || spec.countNeeds.test(body))) {
    const [u, l] = [num(count[1]), num(count[2])];
    if (l > 0 && u >= 0 && u <= l) return { used: u, limit: l, unit: spec.countUnit, resetAt };
  }
  return null;
}

/** Every window the page states, each sliced from its heading to the next heading. */
export function parseWindows(provider: BrowserProvider, text: string, observedAtMs: number): Window[] {
  const spec = SPECS[provider];
  const hits: number[] = [];
  for (const re of spec.labels) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) hits.push(m.index);
  }
  hits.sort((a, b) => a - b);
  const windows: Window[] = [];
  hits.forEach((start, i) => {
    const end = Math.min(hits[i + 1] ?? text.length, start + 240);
    const w = readWindow(text.slice(start, end), spec, observedAtMs);
    if (w) windows.push(w);
  });
  return windows;
}

/**
 * Parse one provider page. The record is the binding window: the one closest
 * to its limit. A login wall or an unrecognised page is a refusal, never 0%.
 */
export function parseUsagePage(
  provider: BrowserProvider,
  visibleText: string,
  observedAt: Date,
): { ok: true; record: BrowserUsageRecord } | { ok: false; reason: ParseRefusal } {
  const windows = parseWindows(provider, visibleText, observedAt.getTime());
  if (windows.length === 0) return { ok: false, reason: LOGIN_WALL.test(visibleText) ? 'login-required' : 'no-match' };
  const best = windows.reduce((a, b) => (b.used / b.limit > a.used / a.limit ? b : a));
  return {
    ok: true,
    record: {
      used: best.used,
      limit: best.limit,
      unit: best.unit,
      reset_at: best.resetAt,
      source: `browser:${provider}`,
      estimated: false,
      observed_at: observedAt.toISOString(),
    },
  };
}
