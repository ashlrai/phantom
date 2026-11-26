import { z } from 'zod';
import { runDesktopOperator, scrubOperatorJson } from '../../desktop/operator.js';
import { readPrivateJson, updateEvidence } from './store.js';
import { bankSchema } from './banked-resets.js';
import { nextResetCheck } from './cadence.js';
import type { BankedResetGrant } from './types.js';

const RESET_ID = 'codex-personal-resets';
const ids = ['antigravity', 'dot', 'cursor', 'grok-bot', 'claude-api', 'openai-api', RESET_ID] as const;
const idSchema = z.enum(ids);
type Id = typeof ids[number];
const targetSchema = z.object({
  app: z.string().trim().min(1).max(120),
  window: z.string().trim().min(1).max(200),
  heading: z.string().trim().min(1).max(160),
}).strict().refine(target => !Object.values(target).some(value => /[\r\n\0]/.test(value)));
type Target = z.infer<typeof targetSchema>;
const configSchema = z.object({
  schema: z.literal('resource-evidence-targets.v1'),
  targets: z.partialRecord(idSchema, targetSchema),
}).strict();
const timestamp = z.string().datetime();
const rowSchema = z.object({
  used: z.number().nullable(),
  limit: z.number().nullable(),
  observed_at: timestamp,
  reset_at: timestamp.nullable(),
  expires_at: timestamp.optional(),
  window_start: timestamp.optional(),
});
type Row = z.infer<typeof rowSchema>;

const MINUTE = 60_000;
const FIVE_HOURS = 300 * MINUTE;
const FILE_CAP = 16 * 1024;
const isCredit = (id: Id): boolean => id === 'claude-api' || id === 'openai-api';
const iso = (at: number): string => new Date(at).toISOString();

function fields(lines: string[], label: RegExp): string[] {
  return lines.flatMap(line => {
    const match = label.exec(line);
    return match ? [match[1]!] : [];
  });
}

function readInstant(values: string[]): string | null {
  if (values.length !== 1 || !timestamp.safeParse(values[0]).success) return null;
  const value = values[0]!;
  const time = Date.parse(value);
  return Number.isFinite(time) && iso(time).replace('.000Z', 'Z') === value.replace('.000Z', 'Z') ? iso(time) : null;
}

function amount(values: string[], unit: 'percent' | 'usd'): number | null {
  if (values.length !== 1) return null;
  const value = values[0]!;
  if (unit === 'percent' ? !/^\d{1,3}(?:\.\d{1,2})?%$/.test(value) : !/^\$\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  return Number(unit === 'percent' ? value.slice(0, -1) : value.slice(1));
}

function section(heading: string, text: string | null): string[] {
  if (!text) return [];
  const nodes = text.split(/\r?\n/).map(line => line.trim()).filter(line => !/^AXWindow\s/.test(line));
  const label = (line: string) => line.replace(/^AX\w+\s+/, '');
  if (nodes.filter(line => label(line) === heading).length !== 1) return [];
  const start = nodes.findIndex(line => label(line) === heading);
  const end = nodes.findIndex((line, i) => i > start && /^AXHeading\s/.test(line));
  return nodes.slice(start + 1, end < 0 ? undefined : end).map(label);
}

function parseObservation(id: Id, heading: string, lines: string[], now: number): Row {
  const unknown = { used: null, limit: null, observed_at: iso(now), reset_at: null };
  const reset = fields(lines, /^(?:Reset(?:s)?(?: at)?):?\s+(.+)$/i);
  const resetAt = readInstant(reset);
  if (reset.length && (!resetAt || Date.parse(resetAt) <= now)) return unknown;
  const unit = isCredit(id) ? 'usd' : 'percent';
  const limit = unit === 'usd' ? amount(fields(lines, /^Grant total:?\s+(.+)$/i), unit) : 100;
  const used = [...fields(lines, /^Used:?\s+(.+)$/i), ...fields(lines, /^([\d.]+%)\s+used$/i)];
  const left = [...fields(lines, /^(?:Remaining|Balance):?\s+(.+)$/i), ...fields(lines, /^([\d.]+%)\s+(?:remaining|left)$/i)];
  const value = amount(used.length ? used : left, unit);
  const remaining = left.length ? amount(left, unit) : null;
  if (limit === null || limit <= 0 || value === null || value > limit ||
    (left.length > 0 && (remaining === null || remaining > limit || (used.length && Math.abs(value + remaining - limit) > 1e-6)))) return unknown;
  const row = { ...unknown, used: used.length ? value : Math.round((limit - value) * 100) / 100, limit, reset_at: resetAt };
  if (id === 'antigravity') {
    if (!/\b5[- ]hour\b/i.test(heading) || !resetAt || Date.parse(resetAt) - FIVE_HOURS > now) return unknown;
    return { ...row, window_start: iso(Date.parse(resetAt) - FIVE_HOURS) };
  }
  if (!isCredit(id)) return row;
  const expiry = readInstant(fields(lines, /^(?:Expires at|Expiry):?\s+(.+)$/i));
  return /\bpromotional\b/i.test(heading) && expiry && Date.parse(expiry) > now ? { ...row, expires_at: expiry } : unknown;
}

function resetExpiry(value: string, now: number): string | null {
  const instant = readInstant([value]);
  if (instant) return Date.parse(instant) > now ? instant : null;
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:, (\d{4}))?, (\d{1,2}):(\d{2}) (AM|PM) (EST|EDT)$/.exec(value);
  if (!match) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(match[1]!);
  const day = Number(match[2]), h = Number(match[4]), minute = Number(match[5]);
  if (h < 1 || h > 12 || minute > 59 || day < 1 || day > 31) return null;
  const current = new Date(now - 5 * 60 * MINUTE);
  const year = match[3] ? Number(match[3]) : current.getUTCFullYear() + Number(current.getUTCMonth() === 11 && month === 0);
  if (year < 2000) return null;
  const hour = h % 12 + (match[6] === 'PM' ? 12 : 0);
  const local = Date.UTC(year, month, day, hour, minute);
  if (new Date(local).getUTCMonth() !== month) return null;
  const at = local + (match[7] === 'EST' ? 5 : 4) * 60 * MINUTE;
  return at > now ? iso(at) : null;
}

function parseResetBank(lines: string[], now: number): z.infer<typeof bankSchema> | null {
  const available = fields(lines, /^(?:Available[: ]+([0-9]{1,3}))$/i);
  if (available.length !== 1) return null;
  const grants: BankedResetGrant[] = [];
  for (const line of lines) {
    const match = /^(Full|5-hour|Weekly) reset expires:? (.+)$/i.exec(line);
    if (!match) continue;
    const expires_at = resetExpiry(match[2]!, now);
    if (!expires_at) return null;
    const name = match[1]!.toLowerCase();
    grants.push({ count: 1, expires_at, kind: name === '5-hour' ? '5h' : name === 'weekly' ? 'weekly' : 'full',
      source: 'chatgpt-settings-usage' });
  }
  const parsed = bankSchema.safeParse({ observed_at: iso(now), count: Number(available[0]), grants });
  return parsed.success ? parsed.data : null;
}

function nextEvidenceAt(id: Id, row: unknown, now: number): number {
  if (id !== RESET_ID) return dueAt(row, now);
  const bank = bankSchema.safeParse(row);
  if (!bank.success) return now;
  const observed = Date.parse(bank.data.observed_at);
  return observed > now ? now : Math.min(observed + 10 * MINUTE, ...bank.data.grants.map(grant => Date.parse(grant.expires_at)));
}

function dueAt(prior: unknown, now: number): number {
  const parsed = rowSchema.safeParse(prior);
  if (!parsed.success) return now;
  const row = parsed.data;
  const observed = Date.parse(row.observed_at);
  if (!Number.isFinite(observed) || observed > now) return now;
  const end = Math.min(row.reset_at ? Date.parse(row.reset_at) : Infinity, row.expires_at ? Date.parse(row.expires_at) : Infinity);
  return Math.min(observed + (row.used === null ? 5 : 10) * MINUTE, nextResetCheck(observed, end));
}

async function readWindow(target: Target, operator: typeof runDesktopOperator): Promise<string | null> {
  const windows = await operator({ verb: 'windows', app: target.app });
  if (!windows.ok || !Array.isArray(windows.data['windows']) ||
    windows.data['windows'].filter(window => window?.title === target.window).length !== 1) return null;
  const result = await operator({ verb: 'read', app: target.app, window: target.window });
  if (!result.ok || result.data['truncated'] !== false) return null;
  const text = scrubOperatorJson(result.data) as Record<string, unknown>;
  return typeof text['text'] === 'string' ? text['text'] : null;
}

export async function recordResetEvidence(runsDir: string, count: number, expiries: string[], kind: BankedResetGrant['kind'],
  observedAt: string, now = Date.now()) {
  const grants = expiries.map(value => ({ count: 1, kind, source: 'owner-screenshot', expires_at: readInstant([value]) }));
  const observed = readInstant([observedAt]);
  const parsed = bankSchema.safeParse({ observed_at: observed, count, grants });
  if (!parsed.success || !observed || Date.parse(observed) > now ||
    parsed.data.grants.some(grant => Date.parse(grant.expires_at) <= Date.parse(observed))) throw new Error('Invalid reset count or dates.');
  const result = await updateEvidence(runsDir, async readings => {
    const previous = bankSchema.safeParse(readings[RESET_ID]);
    if (previous.success && Date.parse(previous.data.observed_at) > Date.parse(observed)) throw new Error('A newer reset observation is already recorded.');
    readings[RESET_ID] = parsed.data;
    return { changed: true, result: parsed.data };
  });
  if (!result) throw new Error('Resource evidence is busy.');
  return result;
}

export async function collectResourceEvidence(options: {
  runsDir: string;
  configPath: string;
  now?: () => number;
  operator?: typeof runDesktopOperator;
}): Promise<{ checked: Id[]; nextAt: number | null }> {
  const config = configSchema.safeParse(await readPrivateJson(options.configPath, FILE_CAP));
  if (!config.success) throw new Error('Invalid resource-evidence-targets.v1 configuration.');
  const { targets } = config.data;
  const enabled = ids.filter(id => targets[id] !== undefined);
  const now = options.now ?? Date.now;
  if (!enabled.length) return { checked: [], nextAt: null };
  return await updateEvidence(options.runsDir, async readings => {
    const checked: Id[] = [];
    const next: number[] = [];
    for (const id of enabled) {
      const at = now();
      const due = nextEvidenceAt(id, readings[id], at);
      if (due > at) { next.push(due); continue; }
      const target = targets[id]!;
      const text = await readWindow(target, options.operator ?? runDesktopOperator).catch(() => null);
      const observed = now();
      const lines = section(target.heading, text);
      const row = id === RESET_ID ? parseResetBank(lines, observed) : parseObservation(id, target.heading, lines, observed);
      if (row) readings[id] = row;
      next.push(row ? nextEvidenceAt(id, row, observed) : observed + 5 * MINUTE);
      checked.push(id);
    }
    return { changed: checked.length > 0, result: { checked, nextAt: Math.min(...next) } };
  }) ?? { checked: [], nextAt: now() + MINUTE };
}
