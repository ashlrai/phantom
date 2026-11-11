/**
 * Provider usage pages read through the dedicated usage browser.
 *
 * Only the visible text of a rendered page is parsed, and only for numbers that
 * match a strict shape. Anything else is unknown, never a guessed percentage.
 * No cookie, token or storage value is ever read here or by the driver.
 */
import type { UsageSensorLane } from '../sensor-reading.js';

export interface UsageSite {
  id: 'claude' | 'chatgpt-codex' | 'devin' | 'zai' | 'gemini';
  label: string;
  /** Page opened on each pass. Sign-in happens in the browser, by the operator. */
  url: string;
  /** The page may only be read while the browser stays on these hosts. */
  hosts: readonly string[];
  /** Sensor lane the reading feeds; null for pools the sensor schema does not carry. */
  lane: UsageSensorLane | null;
  /** Name used in the status.json budget block. */
  budgetLane: string;
  unit: 'percent' | 'acu';
}

export const USAGE_SITES: readonly UsageSite[] = [
  { id: 'claude', label: 'claude.ai Settings > Usage', url: 'https://claude.ai/settings/usage',
    hosts: ['claude.ai'], lane: 'claude-max', budgetLane: 'claude', unit: 'percent' },
  { id: 'chatgpt-codex', label: 'ChatGPT Codex usage', url: 'https://chatgpt.com/codex/settings/usage',
    hosts: ['chatgpt.com'], lane: 'codex-personal', budgetLane: 'codex-personal', unit: 'percent' },
  { id: 'devin', label: 'Devin billing', url: 'https://app.devin.ai/settings/billing',
    hosts: ['app.devin.ai'], lane: 'devin', budgetLane: 'devin', unit: 'acu' },
  { id: 'zai', label: 'z.ai subscription', url: 'https://z.ai/manage-apikey/subscription',
    hosts: ['z.ai'], lane: null, budgetLane: 'zai', unit: 'percent' },
  { id: 'gemini', label: 'Google AI Studio usage', url: 'https://aistudio.google.com/usage',
    hosts: ['aistudio.google.com'], lane: null, budgetLane: 'gemini', unit: 'percent' },
];

export interface VisibleWindow { label: string; used: number; limit: number; resetAt: string | null }

const MINUTE = 60_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function clock(hour: string, minute: string | undefined, meridiem: string | undefined): [number, number] | null {
  let h = Number(hour);
  const m = minute === undefined ? 0 : Number(minute);
  if (!Number.isInteger(h) || m < 0 || m > 59) return null;
  const ap = meridiem?.toLowerCase();
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
  else if (h > 23) return null;
  return [h, m];
}

/**
 * A "Resets ..." phrase as an ISO time, in the machine's local zone (the zone
 * the page is rendered in). Relative phrases are minute-accurate at best.
 */
export function parseResetPhrase(text: string, nowMs: number): string | null {
  const phrase = /resets?\s+(?:on\s+)?(.{1,40})/i.exec(text)?.[1]?.trim();
  if (!phrase || !Number.isFinite(nowMs)) return null;
  const rel = /^in\s+(?:(\d+)\s*(?:days?|d)\s*)?(?:(\d+)\s*(?:hours?|hrs?|h)\s*)?(?:(\d+)\s*(?:minutes?|mins?|m))?/i.exec(phrase);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = (Number(rel[1] ?? 0) * 24 * 60 + Number(rel[2] ?? 0) * 60 + Number(rel[3] ?? 0)) * MINUTE;
    return ms > 0 ? new Date(nowMs + ms).toISOString() : null;
  }
  const now = new Date(nowMs);
  const day = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(phrase);
  if (day) {
    const at = clock(day[2]!, day[3], day[4]);
    if (!at) return null;
    const target = WEEKDAYS.indexOf(day[1]!.toLowerCase());
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), at[0], at[1], 0, 0);
    d.setDate(d.getDate() + ((target - now.getDay() + 7) % 7));
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 7);
    return d.toISOString();
  }
  const date = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(phrase);
  if (date) {
    const at = date[4] ? clock(date[4], date[5], date[6]) : [0, 0] as [number, number];
    if (!at) return null;
    const month = MONTHS.indexOf(date[1]!.toLowerCase());
    let d = new Date(date[3] ? Number(date[3]) : now.getFullYear(), month, Number(date[2]), at[0], at[1], 0, 0);
    if (!date[3] && d.getTime() <= nowMs) d = new Date(now.getFullYear() + 1, month, Number(date[2]), at[0], at[1], 0, 0);
    return d.getMonth() === month && d.getTime() > nowMs ? d.toISOString() : null;
  }
  return null;
}

const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%\s*used/i;
const ACU = /([\d,]+(?:\.\d+)?)\s*(?:\/|of)\s*([\d,]+(?:\.\d+)?)\s*ACUs?\b/i;

/**
 * Windows from rendered text. A percent is accepted only as "NN% used" inside
 * 0..100, paired with the nearest reset phrase in the same block. A block is
 * the lines between blank lines, so one window's reset never leaks to another.
 */
export function parseVisibleWindows(unit: 'percent' | 'acu', text: string, nowMs: number): VisibleWindow[] {
  if (typeof text !== 'string' || text.length > 200_000) return [];
  const out: VisibleWindow[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    const reset = lines.map(line => parseResetPhrase(line, nowMs)).find(value => value !== null) ?? null;
    if (unit === 'acu') {
      const hit = ACU.exec(block);
      if (!hit) continue;
      const used = Number(hit[1]!.replaceAll(',', '')), limit = Number(hit[2]!.replaceAll(',', ''));
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0 && used >= 0) {
        out.push({ label: lines[0] ?? 'acu', used, limit, resetAt: reset });
      }
      continue;
    }
    for (const line of lines) {
      const hit = PERCENT.exec(line);
      if (!hit) continue;
      const used = Number(hit[1]);
      if (used >= 0 && used <= 100) out.push({ label: lines[0] ?? 'window', used, limit: 100, resetAt: reset });
    }
  }
  return out;
}

/** The fullest window binds, as for Codex. */
export function bindingWindow(windows: readonly VisibleWindow[]): VisibleWindow | null {
  let best: VisibleWindow | null = null;
  for (const w of windows) if (!best || w.used / w.limit > best.used / best.limit) best = w;
  return best;
}

const SIGNIN_PATH = /\/(?:log-?in|sign-?in|signin|auth|oauth|accounts|sso|authorize)(?:[/?#]|$)/i;
const SIGNIN_TEXT = /\b(?:sign in|log in|continue with google|continue with email|enter your password)\b/i;

/** True when the browser landed on a sign-in surface instead of the usage page. */
export function needsSignin(site: UsageSite, finalUrl: string, text: string, windows: readonly VisibleWindow[]): boolean {
  let url: URL;
  try { url = new URL(finalUrl); } catch { return true; }
  const onHost = site.hosts.includes(url.hostname);
  if (!onHost || SIGNIN_PATH.test(url.pathname)) return true;
  return windows.length === 0 && SIGNIN_TEXT.test(text.slice(0, 4000));
}
