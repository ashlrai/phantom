/**
 * core/verse/desktop-error-report.ts — render-crash reports from the desktop
 * console, recorded where agents can read them (RQ-PHX-DESKTOPCRASHREPORT100).
 *
 * A view or pane error boundary used to `console.error` and stop: Mason saw
 * "This view hit an error" and no agent ever learned of it. Every caught
 * render crash now lands as one JSONL record in `<runsDir>/desktop/
 * errors.jsonl`, deduped by a fingerprint and bounded by a single rotation,
 * and `ashlr fleet desktop-errors` prints the grouped list.
 *
 * Trust posture: the POST body is operator-supplied free text. Every string
 * is truncated, scrubbed of secret-shaped values and stripped of absolute
 * home paths BEFORE it reaches the ledger — the file is read by agents, so
 * it must never carry a token or a private path.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { redactHomePaths, scrubSecrets } from '../util/scrub.js';

export const VERSE_DESKTOP_ERRORS_PATH = '/api/verse/desktop-errors';
/** Crash reports are stack text, not payloads — tighter than the 64 KiB default. */
export const DESKTOP_ERRORS_POST_MAX_BODY_BYTES = 16 * 1024;

const DESKTOP_ERRORS_DIR = 'desktop';
const DESKTOP_ERRORS_FILE = 'errors.jsonl';
const DESKTOP_ERRORS_ROTATED_FILE = 'errors.1.jsonl';
/** A second report of the same crash inside this window appends nothing. */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** The dedupe scan never reads more than the newest slice of the ledger. */
const DEDUPE_TAIL_BYTES = 256 * 1024;
/** One rotation only: errors.jsonl -> errors.1.jsonl, replacing the old one. */
const MAX_LEDGER_BYTES = 2 * 1024 * 1024;

const SURFACE_PATTERN = /^[a-z0-9._:-]{1,64}$/;
const MESSAGE_MAX_CHARS = 500;
const STACK_MAX_CHARS = 4000;
const APP_VERSION_MAX_CHARS = 128;
const BODY_KEYS = new Set(['surface', 'message', 'stack', 'componentStack', 'appVersion']);

export interface DesktopErrorInput {
  surface: string;
  message: string;
  stack?: string;
  componentStack?: string;
  appVersion?: string;
}

export interface DesktopErrorRecord extends DesktopErrorInput {
  at: string;
  fingerprint: string;
}

export interface DesktopErrorWriteResult {
  /** False when the same fingerprint was recorded inside the dedupe window. */
  recorded: boolean;
  fingerprint: string;
}

export interface DesktopErrorGroup {
  fingerprint: string;
  surface: string;
  message: string;
  appVersion?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Truncate first, then scrub secrets and home paths — order matters for the cap. */
function clean(text: string, maxChars: number): string {
  return redactHomePaths(scrubSecrets(text.slice(0, maxChars)));
}

/**
 * Validate and sanitize a POST body into a storable record. Returns null for
 * anything outside the declared shape — extra keys, a bad surface, a missing
 * or non-string message, or wrong-typed optional fields.
 */
export function normaliseDesktopError(input: unknown): DesktopErrorInput | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => !BODY_KEYS.has(key))) return null;
  if (typeof body.surface !== 'string' || !SURFACE_PATTERN.test(body.surface)) return null;
  if (typeof body.message !== 'string' || body.message.length === 0) return null;
  const optional = (key: 'stack' | 'componentStack' | 'appVersion', maxChars: number): string | undefined | null =>
    body[key] === undefined ? undefined : typeof body[key] === 'string' ? clean(body[key] as string, maxChars) : null;
  const stack = optional('stack', STACK_MAX_CHARS);
  const componentStack = optional('componentStack', STACK_MAX_CHARS);
  const appVersion = optional('appVersion', APP_VERSION_MAX_CHARS);
  if (stack === null || componentStack === null || appVersion === null) return null;
  return {
    surface: body.surface,
    message: clean(body.message, MESSAGE_MAX_CHARS),
    ...(stack !== undefined ? { stack } : {}),
    ...(componentStack !== undefined ? { componentStack } : {}),
    ...(appVersion !== undefined ? { appVersion } : {}),
  };
}

/** The first `at …` frame of a stack, which is what localizes a crash. */
function firstStackFrame(stack: string | undefined): string {
  if (stack === undefined) return '';
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('at ')) return trimmed;
  }
  return '';
}

/** sha256(surface + first stack frame + message) sliced to 16 hex chars. */
export function desktopErrorFingerprint(record: DesktopErrorInput): string {
  const frame = firstStackFrame(record.stack) || firstStackFrame(record.componentStack);
  return createHash('sha256').update(`${record.surface}\n${frame}\n${record.message}`).digest('hex').slice(0, 16);
}

function parseLedgerLine(line: string): DesktopErrorRecord | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const rec = value as Record<string, unknown>;
    if (typeof rec.at !== 'string' || !Number.isFinite(Date.parse(rec.at))) return null;
    if (typeof rec.fingerprint !== 'string' || typeof rec.surface !== 'string' || typeof rec.message !== 'string') return null;
    return rec as unknown as DesktopErrorRecord;
  } catch {
    return null;
  }
}

/** Read the last `cap` bytes of `file`; a leading partial line is dropped. */
async function readTail(file: string, cap: number): Promise<string> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - cap);
    const { buffer } = await handle.read(Buffer.alloc(size - start), 0, size - start, start);
    const text = buffer.toString('utf8');
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } finally {
    await handle.close();
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/**
 * Append one JSONL record to `<runsDir>/desktop/errors.jsonl`. Dedupes a
 * fingerprint already written in the last 10 minutes (scanning at most the
 * last 256 KB), and rotates the ledger to errors.1.jsonl once it passes 2 MB.
 */
export async function recordDesktopError(runsDir: string, record: DesktopErrorInput, now: number): Promise<DesktopErrorWriteResult> {
  const dir = join(runsDir, DESKTOP_ERRORS_DIR);
  const file = join(dir, DESKTOP_ERRORS_FILE);
  const fingerprint = desktopErrorFingerprint(record);
  await mkdir(dir, { recursive: true });
  for (const line of (await readTail(file, DEDUPE_TAIL_BYTES)).split('\n')) {
    const prior = parseLedgerLine(line);
    if (prior !== null && prior.fingerprint === fingerprint && now - Date.parse(prior.at) < DEDUPE_WINDOW_MS) {
      return { recorded: false, fingerprint };
    }
  }
  if ((await fileSize(file)) >= MAX_LEDGER_BYTES) {
    // One rotation only: the previous errors.1.jsonl is replaced outright.
    await rename(file, join(dir, DESKTOP_ERRORS_ROTATED_FILE));
  }
  const line: DesktopErrorRecord = {
    at: new Date(now).toISOString(),
    surface: record.surface,
    message: record.message,
    ...(record.stack !== undefined ? { stack: record.stack } : {}),
    ...(record.componentStack !== undefined ? { componentStack: record.componentStack } : {}),
    ...(record.appVersion !== undefined ? { appVersion: record.appVersion } : {}),
    fingerprint,
  };
  await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8');
  return { recorded: true, fingerprint };
}

async function readWhole(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * Newest-first grouped view of the ledger: one row per fingerprint with a
 * count, first and last seen. Reads the live file plus the single rotation so
 * a crash recorded just before a rotate stays visible.
 */
export async function readDesktopErrors(runsDir: string, opts: { sinceMs: number; limit: number }): Promise<DesktopErrorGroup[]> {
  const dir = join(runsDir, DESKTOP_ERRORS_DIR);
  const cutoff = Date.now() - opts.sinceMs;
  const records: DesktopErrorRecord[] = [];
  for (const name of [DESKTOP_ERRORS_ROTATED_FILE, DESKTOP_ERRORS_FILE]) {
    for (const line of (await readWhole(join(dir, name))).split('\n')) {
      const record = parseLedgerLine(line);
      if (record !== null && Date.parse(record.at) >= cutoff) records.push(record);
    }
  }
  records.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const groups = new Map<string, DesktopErrorGroup>();
  for (const record of records) {
    const group = groups.get(record.fingerprint);
    if (group === undefined) {
      groups.set(record.fingerprint, {
        fingerprint: record.fingerprint,
        surface: record.surface,
        message: record.message,
        ...(record.appVersion !== undefined ? { appVersion: record.appVersion } : {}),
        count: 1,
        firstSeen: record.at,
        lastSeen: record.at,
      });
    } else {
      // Records are newest-first: every later sighting is older, so it only
      // ever widens firstSeen while lastSeen stays the most recent.
      group.count += 1;
      group.firstSeen = record.at;
    }
  }
  return [...groups.values()].slice(0, Math.max(0, opts.limit));
}
