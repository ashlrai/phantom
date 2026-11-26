import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runDesktopOperator, scrubOperatorJson } from '../../desktop/operator.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../../fleet/local-store-lock.js';
import { writePrivateFileAtomically } from '../../util/private-file-write.js';
import { readPrivateJson, resourceLiveStateDir } from './store.js';

const ids = ['antigravity', 'dot', 'cursor', 'grok-bot', 'claude-api', 'openai-api'] as const;
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
const fileSchema = z.object({
  schema: z.literal('resource-evidence.v1'),
  readings: z.record(z.string(), z.unknown()),
});
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

function parseObservation(id: Id, heading: string, text: string | null, now: number): Row {
  const unknown = { used: null, limit: null, observed_at: iso(now), reset_at: null };
  if (!text) return unknown;
  const nodes = text.split(/\r?\n/).map(line => line.trim()).filter(line => !/^AXWindow\s/.test(line));
  const label = (line: string) => line.replace(/^AX\w+\s+/, '');
  if (nodes.filter(line => label(line) === heading).length !== 1) return unknown;
  const start = nodes.findIndex(line => label(line) === heading);
  const end = nodes.findIndex((line, i) => i > start && /^AXHeading\s/.test(line));
  const lines = nodes.slice(start + 1, end < 0 ? undefined : end).map(label);
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

function dueAt(prior: unknown, now: number): number {
  const parsed = rowSchema.safeParse(prior);
  if (!parsed.success) return now;
  const row = parsed.data;
  const observed = Date.parse(row.observed_at);
  if (!Number.isFinite(observed) || observed > now) return now;
  const end = Math.min(row.reset_at ? Date.parse(row.reset_at) : Infinity, row.expires_at ? Date.parse(row.expires_at) : Infinity);
  const lead = end - 2 * MINUTE;
  return Math.min(observed + (row.used === null ? 5 : 10) * MINUTE, observed < lead ? lead : end);
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
  const state = resourceLiveStateDir(options.runsDir);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const path = join(state, 'resource-evidence.json');
  const lock = acquireLocalStoreLock(join(state, 'resource-evidence.lock'), 0, { anchorPath: options.runsDir });
  if (!lock) return { checked: [], nextAt: now() + MINUTE };
  try {
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const stored = existing ? fileSchema.safeParse(await readPrivateJson(path, FILE_CAP)) : null;
    if (stored && !stored.success) throw new Error('Invalid existing resource-evidence.v1 file.');
    const readings = stored?.data.readings ?? {};
    const checked: Id[] = [];
    for (const id of enabled) {
      const at = now();
      if (dueAt(readings[id], at) > at) continue;
      const target = targets[id]!;
      const text = await readWindow(target, options.operator ?? runDesktopOperator).catch(() => null);
      readings[id] = parseObservation(id, target.heading, text, now());
      checked.push(id);
    }
    if (checked.length) {
      const body = JSON.stringify({ schema: 'resource-evidence.v1', readings }) + '\n';
      if (Buffer.byteLength(body) > FILE_CAP) throw new Error('Resource evidence exceeds the sidecar limit.');
      writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path, body, { anchorPath: options.runsDir, label: 'Resource evidence' });
    }
    return { checked, nextAt: Math.min(...enabled.map(id => dueAt(readings[id], now()))) };
  } finally {
    releaseLocalStoreLock(lock);
  }
}
