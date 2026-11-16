/**
 * core/ideas/idea-verdicts.ts — the owner's per-idea verdicts ("not now" /
 * "never") for the Ideas loop (RQ-PHX-IDEANOTNOW94).
 *
 * Append-only JSONL at ~/.ashlr/idea-verdicts.jsonl (O_APPEND, O_NOFOLLOW,
 * 0600) — one line per verdict: { ideaId, verdict, reason, at }. Lines are
 * never deleted; the latest valid line per ideaId wins. Reads are bounded to
 * the last READ_TAIL_LINES lines and malformed lines are skipped, matching the
 * journal conventions in automations/store.ts and agents/slack-journal.ts.
 *
 * "not-now" suppresses an idea for NOT_NOW_HIDE_MS; "never" suppresses it
 * permanently. The producer (portfolio/backlog.ts) skips live verdicts, and
 * the generative cycle reads declinedIdeaFeedback() so the loop learns what
 * the owner turns down. Reason text is untrusted input: it is flattened to
 * one line and clipped to REASON_MAX chars, and callers that feed it to a
 * model still run it through scrubSecrets like the rest of the prompt.
 */
import { closeSync, constants as fsConstants, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPrivateFileTailCapped } from '../verse/preferences.js';

export type IdeaVerdict = 'not-now' | 'never';

export interface IdeaVerdictEntry {
  ideaId: string;
  verdict: IdeaVerdict;
  /** One line, at most REASON_MAX chars; '' when the owner gave none. */
  reason: string;
  /** ISO timestamp the verdict was recorded. */
  at: string;
}

export const IDEA_VERDICTS_FILE = 'idea-verdicts.jsonl';
export const REASON_MAX = 280;
export const IDEA_ID_MAX = 512;
/** Reads keep only the newest this many lines — "latest wins" stays cheap. */
export const READ_TAIL_LINES = 2000;
/** Generous byte cap for the tail read; ~2000 worst-case lines fit inside it. */
const READ_TAIL_BYTES = 2 * 1024 * 1024;
/** A "not now" verdict hides the idea for seven days, then it returns. */
export const NOT_NOW_HIDE_MS = 7 * 24 * 60 * 60 * 1000;

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const VERDICTS: ReadonlySet<string> = new Set<IdeaVerdict>(['not-now', 'never']);

/**
 * Absolute path of the verdicts file: ~/.ashlr/idea-verdicts.jsonl.
 * Re-resolved at call time so tests can relocate HOME.
 */
export function ideaVerdictsPath(): string {
  return join(homedir(), '.ashlr', IDEA_VERDICTS_FILE);
}

/** Flatten to a single line (control bytes and separators become spaces), then collapse whitespace. */
// eslint-disable-next-line no-control-regex -- matching control bytes is the point.
const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

export type ParsedIdeaVerdict = { ok: true; ideaId: string; verdict: IdeaVerdict; reason: string } | { ok: false; error: string };

/**
 * Validate a POST /api/ideas/verdict body. Strict: an unknown verdict, an
 * empty ideaId, or a non-string reason is a 400 — never silently coerced.
 */
export function parseIdeaVerdict(body: unknown): ParsedIdeaVerdict {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const obj = body as Record<string, unknown>;
  const ideaId = typeof obj['ideaId'] === 'string' ? oneLine(obj['ideaId']) : '';
  if (!ideaId || ideaId.length > IDEA_ID_MAX) {
    return { ok: false, error: '"ideaId" (string, 1..512 chars) is required' };
  }
  const verdict = obj['verdict'];
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) {
    return { ok: false, error: '"verdict" must be "not-now" or "never"' };
  }
  const rawReason = obj['reason'];
  if (rawReason !== undefined && typeof rawReason !== 'string') {
    return { ok: false, error: '"reason" must be a string when present' };
  }
  const reason = (rawReason === undefined ? '' : oneLine(rawReason)).slice(0, REASON_MAX).trim();
  return { ok: true, ideaId, verdict: verdict as IdeaVerdict, reason };
}

/**
 * Append one verdict line. Returns the recorded entry, or null when the file
 * could not be written — the route turns null into a 500; a verdict write
 * must never throw its way through the API surface.
 */
export function recordIdeaVerdict(
  input: { ideaId: string; verdict: IdeaVerdict; reason: string },
  deps: { now?: number; path?: string } = {},
): IdeaVerdictEntry | null {
  const entry: IdeaVerdictEntry = {
    ideaId: input.ideaId,
    verdict: input.verdict,
    reason: oneLine(input.reason).slice(0, REASON_MAX).trim(),
    at: new Date(deps.now ?? Date.now()).toISOString(),
  };
  try {
    const path = deps.path ?? ideaVerdictsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
    } finally {
      closeSync(fd);
    }
    return entry;
  } catch {
    return null;
  }
}

/** Parse one stored line; anything malformed (or with a bad `at`) is skipped. */
function parseLine(line: string): IdeaVerdictEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const ideaId = obj['ideaId'];
  const verdict = obj['verdict'];
  const reason = obj['reason'];
  const at = obj['at'];
  if (typeof ideaId !== 'string' || ideaId.length === 0 || ideaId.length > IDEA_ID_MAX) return null;
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return null;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  return {
    ideaId,
    verdict: verdict as IdeaVerdict,
    reason: typeof reason === 'string' ? oneLine(reason).slice(0, REASON_MAX).trim() : '',
    at,
  };
}

/**
 * Latest verdict per ideaId, from the last READ_TAIL_LINES lines. Never
 * throws; a missing or unreadable file is an empty map.
 */
export function readIdeaVerdicts(opts: { path?: string } = {}): Map<string, IdeaVerdictEntry> {
  const out = new Map<string, IdeaVerdictEntry>();
  const read = readPrivateFileTailCapped(opts.path ?? ideaVerdictsPath(), READ_TAIL_BYTES);
  if (!read) return out;
  let text = read.text;
  if (read.truncated) {
    // The first line may be torn by the tail cap; drop it.
    const newline = text.indexOf('\n');
    text = newline === -1 ? '' : text.slice(newline + 1);
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '').slice(-READ_TAIL_LINES);
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry) out.set(entry.ideaId, entry);
  }
  return out;
}

/** True while a verdict still suppresses its idea: "never" always; "not now" for seven days. */
export function ideaVerdictLive(entry: IdeaVerdictEntry, nowMs: number): boolean {
  if (entry.verdict === 'never') return true;
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at)) return true;
  return nowMs - at < NOT_NOW_HIDE_MS;
}

const FEEDBACK_MAX_LINES = 10;

/**
 * The owner's decline reasons as prompt text for the generative producer, so
 * the loop learns what he turns down instead of re-proposing it. Bounded to
 * the most recent FEEDBACK_MAX_LINES live verdicts; '' when there is nothing
 * to say. Callers still run the block through their usual secret scrub.
 */
export function declinedIdeaFeedback(nowMs: number, opts: { path?: string } = {}): string {
  try {
    const live = [...readIdeaVerdicts(opts).values()]
      .filter((entry) => ideaVerdictLive(entry, nowMs))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, FEEDBACK_MAX_LINES);
    if (live.length === 0) return '';
    const lines = live.map((entry) => `- ${entry.verdict === 'never' ? 'never' : 'not now'}: ${entry.reason || '(no reason given)'}`);
    return `DECLINED IDEAS — the owner turned this work down; do not re-propose it and weigh the reasons:\n${lines.join('\n')}`;
  } catch {
    return '';
  }
}
